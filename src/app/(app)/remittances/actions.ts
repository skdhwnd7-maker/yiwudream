'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  Prisma, RemitStatus, DepositKind, DepositMovement, Entity,
  Currency, PaymentStatus, AuditAction,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logAction } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { round2, roundKrw } from '@/lib/money'

export type ActionState = { error?: string; ok?: string }

const dec = (v: FormDataEntryValue | null | undefined): Prisma.Decimal | null => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  if (!s || !Number.isFinite(Number(s))) return null
  return new Prisma.Decimal(s)
}
const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00`)
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

      for (const a of allocs) {
        const o = orderMap.get(a.orderId.toString())
        if (!o) throw new Error('주문을 찾을 수 없습니다.')
        const allocCny = cnyArrival && krwAmount.gt(0)
          ? round2(cnyArrival.mul(a.krw).div(krwAmount))
          : null
        await tx.remittanceAllocation.create({
          data: {
            remittanceId: remit.id, partnerId: o.partnerId, orderId: a.orderId,
            allocKrw: a.krw, allocCny,
          },
        })
        // 고객 예치금에서 그만큼 빠져나간다
        await tx.depositLedger.create({
          data: {
            partnerId: o.partnerId, depositKind: DepositKind.GOODS_FUND,
            movement: DepositMovement.USE_REMIT, amountKrw: a.krw.negated(),
            movementDate: remitDate, refTable: 'remittances', refId: remit.id,
            orderId: a.orderId, createdBy: BigInt(user.id),
          },
        })
      }

      await tx.remittance.update({ where: { id: remit.id }, data: { status } })

      // 송금수수료는 회사 비용이다
      if (bankFee.gt(0)) {
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
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/remittances')
  revalidatePath('/funds')
  redirect(`/remittances?created=${newId}`)
}

/** 도착 확인 — 중국 계좌 잔액에 반영된다 */
export async function markArrived(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')
  const id = BigInt(String(formData.get('remittanceId') ?? '0'))
  const cnyArrival = dec(formData.get('cnyArrivalAmount'))

  const remit = await prisma.remittance.findUnique({ where: { id } })
  if (!remit) return { error: '송금 전표를 찾을 수 없습니다.' }
  if (!cnyArrival || cnyArrival.lte(0)) return { error: 'CNY 실제 도착금액을 입력하세요.' }

  const effectiveRate = remit.krwAmount.div(cnyArrival).toDecimalPlaces(6)

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, '송금 도착 확인')
    await tx.remittance.update({
      where: { id },
      data: {
        status: RemitStatus.ARRIVED, cnyArrivalAmount: cnyArrival,
        fxRateKrwCny: effectiveRate, updatedBy: BigInt(user.id),
      },
    })
    await logAction(tx, 'remittances', id, AuditAction.UPDATE, ctx, {
      field: 'status',
      oldValue: remit.status,
      newValue: `ARRIVED (CNY ${cnyArrival}, 실효환율 ${effectiveRate})`,
    })
  })

  revalidatePath('/remittances')
  revalidatePath('/funds')
  return { ok: '도착 확인했습니다.' }
}

export async function voidRemittance(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('remittance.execute')
  const id = BigInt(String(formData.get('remittanceId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '취소 사유를 입력하세요.' }

  const remit = await prisma.remittance.findUnique({ where: { id }, include: { allocs: true } })
  if (!remit) return { error: '송금 전표를 찾을 수 없습니다.' }
  if (remit.isVoid) return { error: '이미 취소된 전표입니다.' }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    await tx.remittance.update({
      where: { id },
      data: { isVoid: true, voidReason: reason, status: RemitStatus.CANCELLED, updatedBy: BigInt(user.id) },
    })
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
    }
    await logAction(tx, 'remittances', id, AuditAction.VOID, ctx, {
      field: 'isVoid', oldValue: 'false', newValue: 'true',
    })
  })

  revalidatePath('/remittances')
  revalidatePath('/funds')
  return { ok: '송금 전표를 취소하고 예치금을 되돌렸습니다.' }
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
  if (!usdAmount && !krwAmount) return { error: 'USD 또는 KRW 금액 중 하나는 입력해야 합니다.' }
  if (!cnyArrival || cnyArrival.lte(0)) return { error: 'CNY 도착금액을 입력하세요.' }

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
          fromAccountId: fromAccountIdRaw ? BigInt(fromAccountIdRaw) : null,
          toAccountId: toAccountIdRaw ? BigInt(toAccountIdRaw) : null,
          krwAmount, usdAmount, cnyArrivalAmount: cnyArrival,
          fxRateUsdCny: fxUsdCny, bankFee, purpose, memo, createdBy: BigInt(user.id),
        },
      })
      await logCreate(tx, 'internal_transfers', t.id, {
        transferNo, usdAmount: usdAmount?.toString() ?? null,
        cnyArrival: cnyArrival.toString(), fxUsdCny: fxUsdCny?.toString() ?? null, purpose,
      }, ctx)
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/transfers')
  revalidatePath('/funds')
  return { ok: '내부 자금이동을 등록했습니다. 매출·마진에는 포함되지 않습니다.' }
}
