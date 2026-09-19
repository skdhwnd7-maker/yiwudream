'use server'

import { revalidate } from '@/lib/revalidate'
import { redirect } from 'next/navigation'
import {
  Prisma, RemitStatus, DepositKind, DepositMovement, Entity,
  Currency, PaymentStatus, AuditAction,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logAction } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { roundKrw } from '@/lib/money'
import { assertDepositAvailable, DepositShortageError } from '@/lib/deposit'
import { allocateProportional } from '@/lib/allocate'

export type ActionState = { error?: string; ok?: string }

/**
 * 송금 상태 전환 규칙.
 *
 *   DRAFT ─(보냄)→ SENT ─(도착확인)→ ARRIVED
 *     └────────────── 취소 ──────────────┘
 *
 *   DRAFT    아직 은행에 넣지 않았다. 예치금·통장 잔액에 영향이 없다.
 *   SENT     보냈다. 이 순간 예치금이 줄고 한국 통장에서 빠진다.
 *   ARRIVED  중국 계좌에 도착한 금액을 확정한다.
 *   CANCELLED 취소. 새로 만들 수 없고, 취소할 때 반대부호 원장으로 되돌린다.
 */
const ALLOWED_TRANSITIONS: Record<RemitStatus, RemitStatus[]> = {
  DRAFT: [RemitStatus.SENT, RemitStatus.CANCELLED],
  SENT: [RemitStatus.ARRIVED, RemitStatus.CANCELLED],
  ARRIVED: [RemitStatus.CANCELLED],
  CANCELLED: [],
}

const STATUS_LABEL: Record<RemitStatus, string> = {
  DRAFT: '작성중', SENT: '송금완료', ARRIVED: '도착확인', CANCELLED: '취소',
}

function assertTransition(from: RemitStatus, to: RemitStatus): void {
  if (from === to) return
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `${STATUS_LABEL[from]} 상태에서 ${STATUS_LABEL[to]} 로 바꿀 수 없습니다.`
      + ` 가능한 다음 단계: ${ALLOWED_TRANSITIONS[from].map((x) => STATUS_LABEL[x]).join(', ') || '없음'}`,
    )
  }
}

/**
 * 송금액을 예치금에서 뺀다. SENT 가 되는 순간에만 부른다.
 * DRAFT 상태에서는 고객 예치금을 건드리지 않는다 — 아직 나간 돈이 아니다.
 */
async function consumeDeposits(
  tx: Prisma.TransactionClient,
  remit: { id: bigint; remitNo: string; remitDate: Date },
  allocs: { partnerId: bigint; orderId: bigint; allocKrw: Prisma.Decimal }[],
  userId: bigint,
): Promise<void> {
  // 거래처별로 모아 한 번에 확인한다 — 같은 거래처의 주문이 여러 건일 수 있다
  const byPartner = new Map<string, { partnerId: bigint; uses: { orderId: bigint; amount: Prisma.Decimal }[] }>()
  for (const a of allocs) {
    const k = a.partnerId.toString()
    const e = byPartner.get(k) ?? { partnerId: a.partnerId, uses: [] }
    e.uses.push({ orderId: a.orderId, amount: a.allocKrw })
    byPartner.set(k, e)
  }
  for (const { partnerId, uses } of byPartner.values()) {
    const p = await tx.partner.findUnique({ where: { id: partnerId }, select: { name: true } })
    await assertDepositAvailable(tx, partnerId, DepositKind.GOODS_FUND, uses, p?.name)
  }

  for (const a of allocs) {
    await tx.depositLedger.create({
      data: {
        partnerId: a.partnerId, depositKind: DepositKind.GOODS_FUND,
        movement: DepositMovement.USE_REMIT, amountKrw: a.allocKrw.negated(),
        movementDate: remit.remitDate, refTable: 'remittances', refId: remit.id,
        orderId: a.orderId, createdBy: userId,
      },
    })
  }
}

const dec = (v: FormDataEntryValue | null | undefined): Prisma.Decimal | null => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  if (!s || !Number.isFinite(Number(s))) return null
  return new Prisma.Decimal(s)
}
const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 해외송금 등록.
 * 여러 고객의 돈을 합쳐 한 번에 보내는 경우를 위해 주문별 배분을 받는다.
 * 배분 합계가 송금액과 다르면 저장하지 않는다.
 */
export async function createRemittance(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')

  const remitDate = dateOrNull(formData.get('remitDate'))
  const fromAccountId = BigInt(String(formData.get('fromAccountId') ?? '0'))
  const toAccountId = BigInt(String(formData.get('toAccountId') ?? '0'))
  const krwAmount = dec(formData.get('krwAmount'))
  const usdAmount = dec(formData.get('usdAmount'))
  const cnyArrival = dec(formData.get('cnyArrivalAmount'))
  const fxKrwUsd = dec(formData.get('fxRateKrwUsd'))
  const fxUsdCny = dec(formData.get('fxRateUsdCny'))
  const bankFee = dec(formData.get('bankFeeKrw')) ?? new Prisma.Decimal(0)
  const memo = String(formData.get('memo') ?? '').trim() || null
  const statusRaw = String(formData.get('status') ?? 'SENT')
  const status = (statusRaw in RemitStatus ? statusRaw : 'SENT') as RemitStatus
  // 취소 상태로 새로 만들 수는 없다. 취소는 만들어진 전표를 되돌리는 행위다
  if (status === RemitStatus.CANCELLED) {
    return { error: '취소 상태로는 송금을 새로 만들 수 없습니다. 등록한 뒤 취소하세요.' }
  }
  if (status === RemitStatus.ARRIVED) {
    return { error: '도착확인은 송금한 뒤에 하는 절차입니다. 「송금완료」 로 등록한 뒤 도착 확인을 누르세요.' }
  }

  if (!remitDate) return { error: '송금일을 입력하세요.' }
  if (!fromAccountId || !toAccountId) return { error: '출금 계좌와 수취 계좌를 선택하세요.' }
  if (!krwAmount || krwAmount.lte(0)) return { error: 'KRW 송금액을 올바르게 입력하세요.' }

  // 배분
  const orderIds = formData.getAll('allocOrderId').map(String).filter(Boolean)
  const allocKrws = formData.getAll('allocKrw').map(String)

  const allocs: { orderId: bigint; krw: Prisma.Decimal }[] = []
  let allocSum = new Prisma.Decimal(0)
  for (let i = 0; i < orderIds.length; i++) {
    const v = dec(allocKrws[i])
    if (!v || v.lte(0)) continue
    allocs.push({ orderId: BigInt(orderIds[i]), krw: v })
    allocSum = allocSum.plus(v)
  }

  if (allocs.length === 0) return { error: '이 송금에 포함되는 주문을 최소 한 건 지정하세요.' }
  if (!allocSum.equals(krwAmount)) {
    return { error: `배분 합계(${allocSum})가 송금액(${krwAmount})과 다릅니다. 정확히 맞춰야 저장됩니다.` }
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: allocs.map((a) => a.orderId) } },
    include: { partner: { select: { id: true, name: true } } },
  })
  const orderMap = new Map(orders.map((o) => [o.id.toString(), o]))

  // 실효환율 — 실제로 보낸 원화가 얼마짜리 위안이 되었는지
  const effectiveRate = cnyArrival && cnyArrival.gt(0)
    ? krwAmount.div(cnyArrival).toDecimalPlaces(6)
    : null

  let newId = ''
  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user)
      const remitNo = await nextDocNo(tx, 'RM', remitDate)

      // DRAFT 로 만들고 배분을 채운 뒤 상태를 올린다.
      // 배분 합계 트리거가 DRAFT 는 통과시키므로 중간 상태에서 막히지 않는다.
      const remit = await tx.remittance.create({
        data: {
          remitNo, remitDate, fromAccountId, toAccountId,
          krwAmount, usdAmount, cnyArrivalAmount: cnyArrival,
          fxRateKrwUsd: fxKrwUsd, fxRateUsdCny: fxUsdCny, fxRateKrwCny: effectiveRate,
          bankFeeKrw: bankFee, status: RemitStatus.DRAFT, memo, createdBy: BigInt(user.id),
        },
      })
      newId = remit.id.toString()

      // CNY 도착금액은 KRW 배분 비율대로 나눈다. 합이 도착금액과 정확히 같아야 한다
      const cnySplit = cnyArrival
        ? allocateProportional(cnyArrival, allocs.map((a) => ({ item: a, weight: a.krw })))
        : null

      for (const a of allocs) {
        const o = orderMap.get(a.orderId.toString())
        if (!o) throw new Error('주문을 찾을 수 없습니다.')
        const allocCny = cnySplit?.find((x) => x.item === a)?.amount ?? null
        await tx.remittanceAllocation.create({
          data: {
            remittanceId: remit.id, partnerId: o.partnerId, orderId: a.orderId,
            allocKrw: a.krw, allocCny,
          },
        })
      }

      // 예치금은 실제로 보낸 순간(SENT)에만 빠진다. DRAFT 는 아직 아무것도 건드리지 않는다
      if (status === RemitStatus.SENT) {
        assertTransition(RemitStatus.DRAFT, RemitStatus.SENT)
        await consumeDeposits(
          tx,
          { id: remit.id, remitNo, remitDate },
          allocs.map((a) => ({
            partnerId: orderMap.get(a.orderId.toString())!.partnerId,
            orderId: a.orderId,
            allocKrw: a.krw,
          })),
          BigInt(user.id),
        )
      }

      await tx.remittance.update({ where: { id: remit.id }, data: { status } })

      // 송금수수료는 회사 비용이다. 아직 안 보낸 DRAFT 에는 수수료도 없다.
      // 통장 잔액은 이 BANK_FEE 전표로만 줄어든다 — remittance.bankFeeKrw 로 또 빼지 않는다
      if (bankFee.gt(0) && status === RemitStatus.SENT) {
        const cat = await tx.expenseCategory.findFirst({ where: { code: 'BANK_FEE' } })
        if (cat) {
          const expenseNo = await nextDocNo(tx, 'EX', remitDate)
          await tx.expense.create({
            data: {
              expenseNo, entity: Entity.KR, expenseDate: remitDate, categoryId: cat.id,
              accountId: fromAccountId, currency: Currency.KRW, amount: bankFee,
              amountKrw: roundKrw(bankFee, 'FLOOR'),
              paymentStatus: PaymentStatus.PAID, paidAt: remitDate,
              memo: `${remitNo} 송금수수료`, createdBy: BigInt(user.id),
            },
          })
        }
      }

      await logCreate(tx, 'remittances', remit.id, {
        remitNo, krwAmount: krwAmount.toString(),
        cnyArrival: cnyArrival?.toString() ?? null,
        effectiveRate: effectiveRate?.toString() ?? null,
        allocations: allocs.map((a) => `${orderMap.get(a.orderId.toString())?.orderNo}:${a.krw}`).join(', '),
      }, ctx)
    })
  } catch (e) {
    if (e instanceof DepositShortageError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/remittances')
  revalidate('/funds')
  redirect(`/remittances?created=${newId}`)
}

/**
 * 작성중(DRAFT) 송금을 실제로 보냄(SENT) 처리한다.
 * 이 순간 고객 예치금이 줄고 한국 통장에서 빠진다.
 */
export async function sendRemittance(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')
  const id = BigInt(String(formData.get('remittanceId') ?? '0'))

  const remit = await prisma.remittance.findUnique({ where: { id }, include: { allocs: true } })
  if (!remit) return { error: '송금 전표를 찾을 수 없습니다.' }
  if (remit.isVoid) return { error: '취소된 전표입니다.' }

  try {
    assertTransition(remit.status, RemitStatus.SENT)
  } catch (e) {
    return { error: e instanceof Error ? e.message : '상태를 바꿀 수 없습니다.' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, '송금 실행')

      // 버튼을 두 번 눌러도 예치금이 두 번 빠지면 안 된다.
      // 상태 확인을 트랜잭션 밖에서 했으니 여기서 「DRAFT 일 때만」 조건부로 바꾼다.
      // 먼저 들어온 요청만 1건을 바꾸고, 뒤따라온 요청은 0건이라 여기서 멈춘다.
      const claimed = await tx.remittance.updateMany({
        where: { id, status: RemitStatus.DRAFT, isVoid: false },
        data: { status: RemitStatus.SENT, updatedBy: BigInt(user.id) },
      })
      if (claimed.count === 0) {
        throw new Error('이미 처리된 송금입니다. 화면을 새로 고쳐 확인해 주세요.')
      }

      await consumeDeposits(
        tx,
        { id: remit.id, remitNo: remit.remitNo, remitDate: remit.remitDate },
        remit.allocs
          .filter((a) => a.orderId !== null)
          .map((a) => ({ partnerId: a.partnerId, orderId: a.orderId!, allocKrw: a.allocKrw })),
        BigInt(user.id),
      )

      // 송금수수료는 보낸 시점에 회사 비용이 된다
      if (remit.bankFeeKrw.gt(0)) {
        const cat = await tx.expenseCategory.findFirst({ where: { code: 'BANK_FEE' } })
        if (cat) {
          const expenseNo = await nextDocNo(tx, 'EX', remit.remitDate)
          await tx.expense.create({
            data: {
              expenseNo, entity: Entity.KR, expenseDate: remit.remitDate, categoryId: cat.id,
              accountId: remit.fromAccountId, currency: Currency.KRW, amount: remit.bankFeeKrw,
              amountKrw: roundKrw(remit.bankFeeKrw, 'FLOOR'),
              paymentStatus: PaymentStatus.PAID, paidAt: remit.remitDate,
              memo: `${remit.remitNo} 송금수수료`, createdBy: BigInt(user.id),
            },
          })
        }
      }

      // 상태는 위에서 조건부로 이미 바꿨다

      await logAction(tx, 'remittances', id, AuditAction.UPDATE, ctx, {
        field: 'status', oldValue: remit.status, newValue: 'SENT',
      })
    })
  } catch (e) {
    if (e instanceof DepositShortageError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/remittances')
  revalidate('/funds')
  return { ok: '송금 완료로 처리했습니다. 고객 예치금에서 차감했습니다.' }
}

/**
 * 도착 확인 — 중국 계좌 잔액에 반영된다.
 *
 * 실제 도착금액이 예상과 다르면 주문별 CNY 배분도 다시 나눈다.
 * 배분 합계가 도착금액과 다르면 주문별 원가가 실제와 어긋난다.
 */
export async function markArrived(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')
  const id = BigInt(String(formData.get('remittanceId') ?? '0'))
  const cnyArrival = dec(formData.get('cnyArrivalAmount'))

  const remit = await prisma.remittance.findUnique({ where: { id }, include: { allocs: true } })
  if (!remit) return { error: '송금 전표를 찾을 수 없습니다.' }
  if (remit.isVoid) return { error: '취소된 전표입니다.' }
  if (!cnyArrival || cnyArrival.lte(0)) return { error: 'CNY 실제 도착금액을 입력하세요.' }

  try {
    assertTransition(remit.status, RemitStatus.ARRIVED)
  } catch (e) {
    return { error: e instanceof Error ? e.message : '상태를 바꿀 수 없습니다.' }
  }

  const effectiveRate = remit.krwAmount.div(cnyArrival).toDecimalPlaces(6)
  const before = remit.cnyArrivalAmount

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, '송금 도착 확인')
      await tx.remittance.update({
        where: { id },
        data: {
          status: RemitStatus.ARRIVED, cnyArrivalAmount: cnyArrival,
          fxRateKrwCny: effectiveRate, updatedBy: BigInt(user.id),
        },
      })

      // 실제 도착금액 기준으로 주문별 CNY 를 다시 나눈다.
      // 합계는 반드시 도착금액과 같아야 한다 — 남는 잔여는 비중이 큰 주문이 가져간다.
      const split = allocateProportional(
        cnyArrival,
        remit.allocs.map((a) => ({ item: a, weight: a.allocKrw })),
      )
      for (const { item, amount } of split) {
        await tx.remittanceAllocation.update({
          where: { id: item.id }, data: { allocCny: amount },
        })
      }

      await logAction(tx, 'remittances', id, AuditAction.UPDATE, ctx, {
        field: 'status',
        oldValue: `${remit.status}${before ? ` (CNY ${before})` : ''}`,
        newValue: `ARRIVED (CNY ${cnyArrival}, 실효환율 ${effectiveRate}`
          + `, 주문 ${split.length}건 CNY 재배분)`,
      })
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/remittances')
  revalidate('/funds')
  return { ok: '도착 확인했습니다. 주문별 CNY 배분을 실제 도착금액에 맞춰 다시 나눴습니다.' }
}

export async function voidRemittance(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')
  const id = BigInt(String(formData.get('remittanceId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '취소 사유를 입력하세요.' }

  const remit = await prisma.remittance.findUnique({ where: { id }, include: { allocs: true } })
  if (!remit) return { error: '송금 전표를 찾을 수 없습니다.' }
  if (remit.isVoid) return { error: '이미 취소된 전표입니다.' }

  try {
    assertTransition(remit.status, RemitStatus.CANCELLED)
  } catch (e) {
    return { error: e instanceof Error ? e.message : '상태를 바꿀 수 없습니다.' }
  }

  // 예치금을 실제로 뺀 전표만 되돌린다. DRAFT 는 애초에 뺀 적이 없으므로
  // 여기서 되돌리면 있지도 않던 예치금이 생겨난다.
  const consumed = remit.status === RemitStatus.SENT || remit.status === RemitStatus.ARRIVED
  let restored = 0

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    await tx.remittance.update({
      where: { id },
      data: { isVoid: true, voidReason: reason, status: RemitStatus.CANCELLED, updatedBy: BigInt(user.id) },
    })
    if (consumed) {
      // 예치금 원장은 고칠 수 없다. 반대부호 행으로 되돌린다.
      for (const a of remit.allocs) {
        await tx.depositLedger.create({
          data: {
            partnerId: a.partnerId, depositKind: DepositKind.GOODS_FUND,
            movement: DepositMovement.ADJUST, amountKrw: a.allocKrw,
            movementDate: new Date(), refTable: 'remittances', refId: id, orderId: a.orderId,
            reason: `${remit.remitNo} 취소에 따른 복원 — ${reason}`, createdBy: BigInt(user.id),
          },
        })
        restored += 1
      }
      // 송금수수료 전표도 함께 취소한다 — 보내지 않은 송금의 수수료는 없다
      await tx.expense.updateMany({
        where: { memo: `${remit.remitNo} 송금수수료`, isVoid: false },
        data: {
          isVoid: true, voidReason: `${remit.remitNo} 송금 취소 — ${reason}`,
          voidedBy: BigInt(user.id), voidedAt: new Date(),
        },
      })
    }
    await logAction(tx, 'remittances', id, AuditAction.VOID, ctx, {
      field: 'status', oldValue: remit.status,
      newValue: consumed ? `CANCELLED (예치금 ${remit.allocs.length}건 복원)` : 'CANCELLED (작성중이라 복원할 것 없음)',
    })
  })

  revalidate('/remittances')
  revalidate('/funds')
  return {
    ok: consumed
      ? `송금 전표를 취소하고 예치금 ${restored}건을 되돌렸습니다.`
      : '작성중이던 송금 전표를 취소했습니다. 예치금은 건드린 적이 없어 되돌릴 것이 없습니다.',
  }
}

// ─────────────────────────────────────────────────────────────
// 내부 자금이동 — 한국법인 → 중국법인. 매출·마진 집계에서 제외된다.
// ─────────────────────────────────────────────────────────────

export async function createInternalTransfer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')

  const transferDate = dateOrNull(formData.get('transferDate'))
  const fromAccountIdRaw = String(formData.get('fromAccountId') ?? '')
  const toAccountIdRaw = String(formData.get('toAccountId') ?? '')
  const krwAmount = dec(formData.get('krwAmount'))
  const usdAmount = dec(formData.get('usdAmount'))
  const cnyArrival = dec(formData.get('cnyArrivalAmount'))
  const bankFee = dec(formData.get('bankFee')) ?? new Prisma.Decimal(0)
  const purpose = String(formData.get('purpose') ?? '').trim() || null
  const memo = String(formData.get('memo') ?? '').trim() || null

  if (!transferDate) return { error: '일자를 입력하세요.' }
  if (!cnyArrival || cnyArrival.lte(0)) return { error: 'CNY 도착금액을 입력하세요.' }

  // 어느 통장에서 나가 어느 통장으로 들어갔는지 서버에서 확인한다.
  // 화면만 믿으면 한국 통장에서 돈이 나가지 않았는데 중국 통장만 불어나는
  // 전표를 만들 수 있다. 그러면 자금현황이 실제보다 많아진다.
  const fromAccount = fromAccountIdRaw
    ? await prisma.account.findUnique({ where: { id: BigInt(fromAccountIdRaw) } })
    : null
  const toAccount = toAccountIdRaw
    ? await prisma.account.findUnique({ where: { id: BigInt(toAccountIdRaw) } })
    : null

  if (!fromAccount) return { error: '보낸 계좌를 고르세요.' }
  if (!toAccount) return { error: '받은 계좌를 고르세요.' }
  if (fromAccount.entity !== Entity.KR) return { error: '보낸 계좌는 한국법인 계좌여야 합니다.' }
  if (toAccount.entity !== Entity.CN) return { error: '받은 계좌는 중국법인 계좌여야 합니다.' }
  if (toAccount.currency !== Currency.CNY) return { error: '받은 계좌는 위안(CNY) 계좌여야 합니다.' }
  if (fromAccount.currency === Currency.KRW && (!krwAmount || krwAmount.lte(0))) {
    return {
      error: `${fromAccount.name} 은 원화 계좌입니다. 통장에서 실제로 나간 원화 금액을 넣으세요.`
        + ' 넣지 않으면 한국 통장은 그대로인데 중국 통장만 늘어납니다.',
    }
  }
  if (bankFee.lt(0)) return { error: '송금수수료는 음수일 수 없습니다.' }

  const fxUsdCny = usdAmount && usdAmount.gt(0)
    ? cnyArrival.div(usdAmount).toDecimalPlaces(6)
    : null

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user)
      const transferNo = await nextDocNo(tx, 'IT', transferDate)
      const t = await tx.internalTransfer.create({
        data: {
          transferNo, transferDate, fromEntity: Entity.KR, toEntity: Entity.CN,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          krwAmount, usdAmount, cnyArrivalAmount: cnyArrival,
          fxRateUsdCny: fxUsdCny, bankFee, purpose, memo, createdBy: BigInt(user.id),
        },
      })

      // 송금수수료는 회사가 실제로 쓴 돈이다. 지출 전표로 남겨야
      // 통장에서도 빠지고 손익에도 잡힌다. 전표 없이 두면 손익에서 사라진다.
      if (bankFee.gt(0)) {
        const cat = await tx.expenseCategory.findFirst({ where: { code: 'BANK_FEE' } })
        if (!cat) throw new Error('송금·은행 수수료 비용분류(BANK_FEE)가 없습니다.')
        await tx.expense.create({
          data: {
            expenseNo: await nextDocNo(tx, 'EX', transferDate),
            entity: Entity.KR, expenseDate: transferDate, categoryId: cat.id,
            accountId: fromAccount.id, currency: Currency.KRW,
            amount: bankFee, amountKrw: roundKrw(bankFee, 'FLOOR'),
            paymentStatus: PaymentStatus.PAID, paidAt: transferDate,
            memo: `${transferNo} 내부 자금이동 송금수수료`, createdBy: BigInt(user.id),
          },
        })
      }

      await logCreate(tx, 'internal_transfers', t.id, {
        transferNo, usdAmount: usdAmount?.toString() ?? null,
        cnyArrival: cnyArrival.toString(), fxUsdCny: fxUsdCny?.toString() ?? null, purpose,
      }, ctx)
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/transfers')
  revalidate('/funds')
  return { ok: '내부 자금이동을 등록했습니다. 매출·마진에는 포함되지 않습니다.' }
}
