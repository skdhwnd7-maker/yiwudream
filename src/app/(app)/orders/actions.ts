'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  Prisma, Route, Entity, Currency, OrderStatus, InvoiceStatus,
  ReceiptSource, SplitKind, DepositKind, DepositMovement, PaymentStatus,
  AuditAction, FxSource,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, logAction, AuditReasonRequiredError } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { computeSplits } from '@/lib/order-calc'
import { D, krwToCny, cnyToKrw, roundKrw, round2, type RoundingMode } from '@/lib/money'

export type ActionState = { error?: string; ok?: string; orderId?: string }

const dec = (v: FormDataEntryValue | null): Prisma.Decimal | null => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  if (!s) return null
  if (!Number.isFinite(Number(s))) return null
  return new Prisma.Decimal(s)
}

const decOrZero = (v: FormDataEntryValue | null): Prisma.Decimal => dec(v) ?? new Prisma.Decimal(0)

const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 정산통화 — 해외송금은 중국법인 CNY 기준, 나머지는 한국 KRW 기준 */
const settlementCurrencyFor = (route: Route): Currency =>
  route === Route.OVERSEAS ? Currency.CNY : Currency.KRW

const entityFor = (route: Route): Entity =>
  route === Route.OVERSEAS ? Entity.CN : Entity.KR

async function krwRounding(): Promise<RoundingMode> {
  const s = await prisma.setting.findUnique({ where: { key: 'krw_rounding' } })
  return (s?.value as RoundingMode) ?? 'FLOOR'
}

// ─────────────────────────────────────────────────────────────
// 새 거래 등록 — 주문 + 첫 입금을 한 트랜잭션으로 만든다
// ─────────────────────────────────────────────────────────────

export async function createOrderWithReceipt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.write')

  const partnerId = BigInt(String(formData.get('partnerId') ?? '0'))
  const routeRaw = String(formData.get('route') ?? '')
  if (!partnerId || !(routeRaw in Route)) return { error: '거래처와 루트를 선택하세요.' }
  const route = routeRaw as Route

  const dealTypeId = BigInt(String(formData.get('dealTypeId') ?? '0'))
  if (!dealTypeId) return { error: '거래유형을 선택하세요.' }

  const orderDate = dateOrNull(formData.get('orderDate'))
  if (!orderDate) return { error: '일자를 입력하세요.' }

  const accountId = BigInt(String(formData.get('accountId') ?? '0'))
  if (!accountId) return { error: '입금 계좌를 선택하세요.' }

  const title = String(formData.get('title') ?? '').trim() || null
  const externalRef = String(formData.get('externalRef') ?? '').trim() || null
  const memo = String(formData.get('memo') ?? '').trim() || null

  const amount = dec(formData.get('amount'))
  if (!amount || amount.lte(0)) return { error: '입금액을 올바르게 입력하세요.' }

  const fxRate = dec(formData.get('fxRate'))
  const usdAmount = dec(formData.get('usdAmount'))
  const depositGoods = dec(formData.get('depositGoods'))
  const asDeposit = formData.get('asDeposit') === 'on'       // 주문 없이 예치금만 적립
  const fromDeposit = formData.get('fromDeposit') === 'on'   // 예치금에서 충당
  const issueInvoice = formData.get('issueInvoice') === 'on'
  const vatCharged = formData.get('vatCharged') === 'on'

  const [dealType, account, partner, rounding] = await Promise.all([
    prisma.dealType.findUnique({ where: { id: dealTypeId } }),
    prisma.account.findUnique({ where: { id: accountId } }),
    prisma.partner.findUnique({ where: { id: partnerId } }),
    krwRounding(),
  ])
  if (!dealType || !account || !partner) return { error: '기준정보를 찾을 수 없습니다.' }

  const currency = settlementCurrencyFor(route)
  const entity = entityFor(route)

  // 환율은 계좌통화와 정산통화가 다를 때만 필수다.
  // KRW 계좌 → KRW 정산이면 환산할 일이 없다. 참고용으로 넣는 것은 자유.
  if (account.currency !== currency && (!fxRate || fxRate.lte(0))) {
    return { error: `적용환율을 입력하세요. ${account.currency} 입금을 ${currency} 기준으로 정산하려면 환율이 필요합니다.` }
  }

  // 사이트 루트는 예치금/수수료 분해가 필수
  if (route === Route.SITE) {
    if (!depositGoods || depositGoods.lt(0)) return { error: '상품구매 예치금 금액을 입력하세요.' }
    if (depositGoods.gt(amount)) return { error: '상품구매 예치금이 총 입금액보다 클 수 없습니다.' }
  }

  // 원통화 → KRW / CNY 환산. 저장 시점에 확정하고 이후 환율이 바뀌어도 다시 계산하지 않는다.
  const toKrw = (v: Prisma.Decimal) =>
    account.currency === Currency.KRW ? roundKrw(v, rounding) : cnyToKrw(v, fxRate ?? 1, rounding)
  // 환율을 안 넣었으면 CNY 환산값은 비워 둔다. 없는 환율을 지어내지 않는다.
  const toCny = (v: Prisma.Decimal): Prisma.Decimal | null =>
    account.currency === Currency.CNY ? round2(v) : fxRate ? krwToCny(v, fxRate) : null

  const splits = computeSplits({
    amount,
    vatMode: dealType.vatMode,
    vatRate: dealType.vatRate,
    rounding,
    depositGoods: route === Route.SITE ? (depositGoods ?? 0) : 0,
    depositGeneralOnly: asDeposit,
    vatCharged,
  })

  let newOrderId = ''

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user)

      // 예치금만 적립하는 경우 주문을 만들지 않는다
      if (asDeposit) {
        const receiptNo = await nextDocNo(tx, 'RC', orderDate)
        const receipt = await tx.receipt.create({
          data: {
            receiptNo, orderId: null, partnerId, accountId, route, entity,
            receiptDate: orderDate, source: ReceiptSource.DIRECT,
            currency: account.currency, amount,
            fxRate, fxRateSource: FxSource.MANUAL,
            amountKrw: toKrw(amount), amountCny: toCny(amount),
            usdAmount, memo, createdBy: BigInt(user.id),
          },
        })
        await tx.receiptSplit.create({
          data: {
            receiptId: receipt.id, splitKind: SplitKind.DEPOSIT_GENERAL,
            amount, amountKrw: toKrw(amount), amountCny: toCny(amount),
          },
        })
        await tx.depositLedger.create({
          data: {
            partnerId, depositKind: DepositKind.GENERAL, movement: DepositMovement.IN_RECEIPT,
            amountKrw: toKrw(amount), movementDate: orderDate,
            refTable: 'receipts', refId: receipt.id, createdBy: BigInt(user.id),
          },
        })
        await logCreate(tx, 'receipts', receipt.id, { receiptNo, amount: amount.toString(), kind: '예치금 적립' }, ctx)
        return
      }

      const orderNo = await nextDocNo(tx, 'ORDER', orderDate)
      const order = await tx.order.create({
        data: {
          orderNo, externalRef, partnerId, route, dealTypeId,
          accountingClass: dealType.accountingClass, entity, settlementCurrency: currency,
          title, orderDate,
          invoiceStatus: issueInvoice ? InvoiceStatus.PENDING : InvoiceStatus.NONE,
          usdInvoiceAmount: route === Route.OVERSEAS ? usdAmount : null,
          memo, createdBy: BigInt(user.id),
        },
      })
      newOrderId = order.id.toString()

      const receiptNo = await nextDocNo(tx, 'RC', orderDate)
      const receipt = await tx.receipt.create({
        data: {
          receiptNo, orderId: order.id, partnerId, accountId, route, entity,
          receiptDate: orderDate,
          source: fromDeposit ? ReceiptSource.FROM_DEPOSIT : ReceiptSource.DIRECT,
          currency: account.currency, amount,
          fxRate, fxRateSource: FxSource.MANUAL,
          amountKrw: toKrw(amount), amountCny: toCny(amount),
          usdAmount, memo: null, createdBy: BigInt(user.id),
        },
      })

      for (const s of splits) {
        await tx.receiptSplit.create({
          data: {
            receiptId: receipt.id, splitKind: s.kind as SplitKind,
            amount: s.amount, amountKrw: toKrw(s.amount), amountCny: toCny(s.amount),
          },
        })
      }

      // 상품구매 예치금은 고객 돈으로 원장에 쌓고, 중국 송금 대상이 된다
      const goodsSplit = splits.find((s) => s.kind === 'DEPOSIT_GOODS')
      if (goodsSplit) {
        await tx.depositLedger.create({
          data: {
            partnerId, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.IN_RECEIPT,
            amountKrw: toKrw(goodsSplit.amount), movementDate: orderDate,
            refTable: 'receipts', refId: receipt.id, orderId: order.id, createdBy: BigInt(user.id),
          },
        })
      }

      // 예치금에서 충당한 경우 그만큼 예치금이 줄어든다
      if (fromDeposit) {
        await tx.depositLedger.create({
          data: {
            partnerId, depositKind: DepositKind.GENERAL, movement: DepositMovement.USE_ORDER,
            amountKrw: toKrw(amount).negated(), movementDate: orderDate,
            refTable: 'receipts', refId: receipt.id, orderId: order.id,
            reason: `${orderNo} 정산 충당`, createdBy: BigInt(user.id),
          },
        })
      }

      await logCreate(tx, 'orders', order.id, {
        orderNo, partner: partner.name, route, dealType: dealType.code,
        orderDate: orderDate.toISOString().slice(0, 10),
      }, ctx)
      await logCreate(tx, 'receipts', receipt.id, {
        receiptNo, amount: amount.toString(), fxRate: fxRate?.toString() ?? null,
        splits: splits.map((s) => `${s.kind}:${s.amount}`).join(', '),
      }, ctx)
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/orders')
  revalidatePath('/partners')
  if (!newOrderId) return { ok: '예치금을 적립했습니다.' }
  redirect(`/orders/${newOrderId}?created=1`)
}

// ─────────────────────────────────────────────────────────────
// 입금 추가 — 기존 주문에 붙인다
// ─────────────────────────────────────────────────────────────

export async function addReceipt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.write')
  const orderId = BigInt(String(formData.get('orderId') ?? '0'))
  const accountId = BigInt(String(formData.get('accountId') ?? '0'))
  const receiptDate = dateOrNull(formData.get('receiptDate'))
  const amount = dec(formData.get('amount'))
  const fxRate = dec(formData.get('fxRate'))
  const usdAmount = dec(formData.get('usdAmount'))
  const depositGoods = dec(formData.get('depositGoods'))
  const fromDeposit = formData.get('fromDeposit') === 'on'
  const vatCharged = formData.get('vatCharged') === 'on'
  const memo = String(formData.get('memo') ?? '').trim() || null

  if (!receiptDate) return { error: '일자를 입력하세요.' }
  if (!amount || amount.lte(0)) return { error: '입금액을 올바르게 입력하세요.' }

  const [order, account, rounding] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, include: { dealType: true } }),
    prisma.account.findUnique({ where: { id: accountId } }),
    krwRounding(),
  ])
  if (!order || !account) return { error: '주문 또는 계좌를 찾을 수 없습니다.' }
  if (order.status === OrderStatus.SETTLED) return { error: '정산완료된 주문입니다. 잠금해제 후 진행하세요.' }

  if (account.currency !== order.settlementCurrency && (!fxRate || fxRate.lte(0))) {
    return { error: '적용환율을 입력하세요.' }
  }
  if (depositGoods && depositGoods.gt(amount)) {
    return { error: '상품구매 예치금이 입금액보다 클 수 없습니다.' }
  }

  const toKrw = (v: Prisma.Decimal) =>
    account.currency === Currency.KRW ? roundKrw(v, rounding) : cnyToKrw(v, fxRate ?? 1, rounding)
  const toCny = (v: Prisma.Decimal): Prisma.Decimal | null =>
    account.currency === Currency.CNY ? round2(v) : fxRate ? krwToCny(v, fxRate) : null

  const splits = computeSplits({
    amount, vatMode: order.dealType.vatMode, vatRate: order.dealType.vatRate, rounding,
    depositGoods: depositGoods ?? 0, vatCharged,
  })

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user)
      const receiptNo = await nextDocNo(tx, 'RC', receiptDate)
      const receipt = await tx.receipt.create({
        data: {
          receiptNo, orderId, partnerId: order.partnerId, accountId,
          route: order.route, entity: order.entity, receiptDate,
          source: fromDeposit ? ReceiptSource.FROM_DEPOSIT : ReceiptSource.DIRECT,
          currency: account.currency, amount, fxRate, fxRateSource: FxSource.MANUAL,
          amountKrw: toKrw(amount), amountCny: toCny(amount), usdAmount, memo,
          createdBy: BigInt(user.id),
        },
      })
      for (const s of splits) {
        await tx.receiptSplit.create({
          data: {
            receiptId: receipt.id, splitKind: s.kind as SplitKind,
            amount: s.amount, amountKrw: toKrw(s.amount), amountCny: toCny(s.amount),
          },
        })
      }
      const goodsSplit = splits.find((s) => s.kind === 'DEPOSIT_GOODS')
      if (goodsSplit) {
        await tx.depositLedger.create({
          data: {
            partnerId: order.partnerId, depositKind: DepositKind.GOODS_FUND,
            movement: DepositMovement.IN_RECEIPT, amountKrw: toKrw(goodsSplit.amount),
            movementDate: receiptDate, refTable: 'receipts', refId: receipt.id, orderId,
            createdBy: BigInt(user.id),
          },
        })
      }
      if (fromDeposit) {
        await tx.depositLedger.create({
          data: {
            partnerId: order.partnerId, depositKind: DepositKind.GENERAL,
            movement: DepositMovement.USE_ORDER, amountKrw: toKrw(amount).negated(),
            movementDate: receiptDate, refTable: 'receipts', refId: receipt.id, orderId,
            reason: `${order.orderNo} 정산 충당`, createdBy: BigInt(user.id),
          },
        })
      }
      await logCreate(tx, 'receipts', receipt.id, {
        receiptNo, orderNo: order.orderNo, amount: amount.toString(),
        splits: splits.map((s) => `${s.kind}:${s.amount}`).join(', '),
      }, ctx)
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath(`/orders/${orderId}`)
  return { ok: '입금을 추가했습니다.' }
}

// ─────────────────────────────────────────────────────────────
// 지출 추가 — 주문에 귀속시키거나(원가), 비워두면 운영비가 된다
// ─────────────────────────────────────────────────────────────

export async function addExpense(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.write')

  const categoryId = BigInt(String(formData.get('categoryId') ?? '0'))
  const expenseDate = dateOrNull(formData.get('expenseDate'))
  const amount = dec(formData.get('amount'))
  const fxRate = dec(formData.get('fxRate'))
  const currencyRaw = String(formData.get('currency') ?? 'CNY')
  const currency = (currencyRaw in Currency ? currencyRaw : 'CNY') as Currency
  const vendorName = String(formData.get('vendorName') ?? '').trim() || null
  const accountIdRaw = String(formData.get('accountId') ?? '')
  const paymentMethod = String(formData.get('paymentMethod') ?? '').trim() || null
  const paid = formData.get('paymentStatus') !== 'PLANNED'
  const memo = String(formData.get('memo') ?? '').trim() || null
  const workFrom = dateOrNull(formData.get('workPeriodFrom'))
  const workTo = dateOrNull(formData.get('workPeriodTo'))
  const workDesc = String(formData.get('workDesc') ?? '').trim() || null

  if (!categoryId) return { error: '비용분류를 선택하세요.' }
  if (!expenseDate) return { error: '일자를 입력하세요.' }
  if (!amount || amount.lte(0)) return { error: '금액을 올바르게 입력하세요.' }

  // 배분 — orderIds[] 와 allocAmounts[] 를 짝지어 받는다
  const orderIds = formData.getAll('allocOrderId').map((v) => String(v)).filter(Boolean)
  const allocAmounts = formData.getAll('allocAmount').map((v) => String(v))

  const [category, rounding] = await Promise.all([
    prisma.expenseCategory.findUnique({ where: { id: categoryId } }),
    krwRounding(),
  ])
  if (!category) return { error: '비용분류를 찾을 수 없습니다.' }

  if (currency === Currency.CNY && (!fxRate || fxRate.lte(0))) {
    return { error: 'CNY 지출에는 적용환율이 필요합니다. 원화 환산에 쓰입니다.' }
  }

  const toKrw = (v: Prisma.Decimal) =>
    currency === Currency.KRW ? roundKrw(v, rounding) : cnyToKrw(v, fxRate ?? 1, rounding)
  const toCny = (v: Prisma.Decimal) =>
    currency === Currency.CNY ? round2(v) : krwToCny(v, fxRate ?? 1)

  // 배분 합계가 지출액을 넘지 않는지 먼저 확인한다 (DB 트리거도 막지만 메시지를 친절하게)
  const allocs: { orderId: bigint; amount: Prisma.Decimal }[] = []
  let allocSum = new Prisma.Decimal(0)
  for (let i = 0; i < orderIds.length; i++) {
    const a = dec(allocAmounts[i] ?? null)
    if (!a || a.lte(0)) continue
    allocs.push({ orderId: BigInt(orderIds[i]), amount: a })
    allocSum = allocSum.plus(a)
  }
  if (allocSum.gt(amount)) {
    return { error: `배분 합계(${allocSum})가 지출액(${amount})을 초과했습니다.` }
  }

  // 정산완료 주문에는 배분할 수 없다
  if (allocs.length > 0) {
    const locked = await prisma.order.findMany({
      where: { id: { in: allocs.map((a) => a.orderId) }, status: OrderStatus.SETTLED },
      select: { orderNo: true },
    })
    if (locked.length > 0) {
      return { error: `정산완료된 주문에는 배분할 수 없습니다: ${locked.map((l) => l.orderNo).join(', ')}` }
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user)
      const expenseNo = await nextDocNo(tx, 'EX', expenseDate)
      const expense = await tx.expense.create({
        data: {
          expenseNo, entity: category.defaultEntity, expenseDate, categoryId,
          vendorName, accountId: accountIdRaw ? BigInt(accountIdRaw) : null,
          paymentMethod, currency, amount, fxRate, fxRateSource: FxSource.MANUAL,
          amountKrw: toKrw(amount), amountCny: toCny(amount),
          paymentStatus: paid ? PaymentStatus.PAID : PaymentStatus.PLANNED,
          paidAt: paid ? expenseDate : null,
          workPeriodFrom: workFrom, workPeriodTo: workTo, workDesc,
          memo, createdBy: BigInt(user.id),
        },
      })
      for (const a of allocs) {
        await tx.expenseAllocation.create({
          data: {
            expenseId: expense.id, orderId: a.orderId,
            allocAmount: a.amount, allocKrw: toKrw(a.amount), allocCny: toCny(a.amount),
          },
        })
      }
      await logCreate(tx, 'expenses', expense.id, {
        expenseNo, category: category.name, amount: amount.toString(), currency,
        fxRate: fxRate?.toString() ?? null,
        allocated: allocs.length > 0 ? `${allocs.length}개 주문` : '운영비(미귀속)',
      }, ctx)
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  for (const a of allocs) revalidatePath(`/orders/${a.orderId}`)
  revalidatePath('/orders')
  return { ok: '지출을 등록했습니다.' }
}

// ─────────────────────────────────────────────────────────────
// 정산완료 · 잠금해제 · 취소
// ─────────────────────────────────────────────────────────────

export async function settleOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.write')
  const orderId = BigInt(String(formData.get('orderId') ?? '0'))

  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return { error: '주문을 찾을 수 없습니다.' }
  if (order.status === OrderStatus.SETTLED) return { error: '이미 정산완료된 주문입니다.' }

  // 확정 시점의 마진을 스냅샷으로 남긴다. 나중에 재계산값과 어긋나면 경고할 수 있다.
  const { summarizeOrder } = await import('@/lib/order-calc')
  const summary = await summarizeOrder(orderId)

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, '정산완료 처리')
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.SETTLED, settledAt: new Date(), settledBy: BigInt(user.id),
        settledMargin: summary.margin, updatedBy: BigInt(user.id),
      },
    })
    await logAction(tx, 'orders', orderId, AuditAction.SETTLE, ctx, {
      field: 'status', oldValue: 'OPEN', newValue: `SETTLED (마진 ${summary.margin})`,
    })
  })

  revalidatePath(`/orders/${orderId}`)
  revalidatePath('/orders')
  return { ok: '정산완료 처리했습니다. 이 주문의 전표는 이제 잠깁니다.' }
}

export async function unlockOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.void')
  const orderId = BigInt(String(formData.get('orderId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '잠금해제 사유를 입력하세요.' }

  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return { error: '주문을 찾을 수 없습니다.' }
  if (order.status !== OrderStatus.SETTLED) return { error: '정산완료 상태가 아닙니다.' }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.OPEN, updatedBy: BigInt(user.id) },
    })
    await logAction(tx, 'orders', orderId, AuditAction.UNLOCK, ctx, {
      field: 'status', oldValue: 'SETTLED', newValue: 'OPEN',
    })
  })

  revalidatePath(`/orders/${orderId}`)
  return { ok: '잠금을 해제했습니다. 이 기록은 변경이력에 남습니다.' }
}

/** 입금 취소 — 행을 지우지 않고 무효화하고, 예치금은 상쇄행으로 되돌린다 */
export async function voidReceipt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.void')
  const receiptId = BigInt(String(formData.get('receiptId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '취소 사유를 입력하세요.' }

  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    include: { splits: true, order: true },
  })
  if (!receipt) return { error: '입금 전표를 찾을 수 없습니다.' }
  if (receipt.isVoid) return { error: '이미 취소된 전표입니다.' }
  if (receipt.order?.status === OrderStatus.SETTLED) {
    return { error: '정산완료된 주문의 전표입니다. 잠금해제 후 진행하세요.' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, reason)
      await tx.receipt.update({
        where: { id: receiptId },
        data: {
          isVoid: true, voidReason: reason, voidedBy: BigInt(user.id), voidedAt: new Date(),
          updatedBy: BigInt(user.id),
        },
      })

      // 예치금 원장은 고칠 수 없다. 반대부호 행을 추가해 되돌린다.
      const goods = receipt.splits.find((s) => s.splitKind === SplitKind.DEPOSIT_GOODS)
      const general = receipt.splits.find((s) => s.splitKind === SplitKind.DEPOSIT_GENERAL)
      for (const [split, kind] of [
        [goods, DepositKind.GOODS_FUND] as const,
        [general, DepositKind.GENERAL] as const,
      ]) {
        if (!split) continue
        await tx.depositLedger.create({
          data: {
            partnerId: receipt.partnerId, depositKind: kind, movement: DepositMovement.ADJUST,
            amountKrw: split.amountKrw.negated(), movementDate: new Date(),
            refTable: 'receipts', refId: receiptId, orderId: receipt.orderId,
            reason: `${receipt.receiptNo} 취소에 따른 복원 — ${reason}`,
            createdBy: BigInt(user.id),
          },
        })
      }
      if (receipt.source === ReceiptSource.FROM_DEPOSIT) {
        await tx.depositLedger.create({
          data: {
            partnerId: receipt.partnerId, depositKind: DepositKind.GENERAL,
            movement: DepositMovement.ADJUST, amountKrw: receipt.amountKrw,
            movementDate: new Date(), refTable: 'receipts', refId: receiptId,
            orderId: receipt.orderId,
            reason: `${receipt.receiptNo} 취소에 따른 예치금 복원 — ${reason}`,
            createdBy: BigInt(user.id),
          },
        })
      }

      await logAction(tx, 'receipts', receiptId, AuditAction.VOID, ctx, {
        field: 'isVoid', oldValue: 'false', newValue: 'true',
      })
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '취소 중 오류가 발생했습니다.' }
  }

  if (receipt.orderId) revalidatePath(`/orders/${receipt.orderId}`)
  return { ok: '입금 전표를 취소했습니다. 행은 이력으로 남습니다.' }
}

export async function voidExpense(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.void')
  const expenseId = BigInt(String(formData.get('expenseId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '취소 사유를 입력하세요.' }

  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: { allocs: { include: { order: true } } },
  })
  if (!expense) return { error: '지출 전표를 찾을 수 없습니다.' }
  if (expense.isVoid) return { error: '이미 취소된 전표입니다.' }

  const locked = expense.allocs.filter((a) => a.order.status === OrderStatus.SETTLED)
  if (locked.length > 0) {
    return { error: `정산완료된 주문에 배분된 지출입니다: ${locked.map((l) => l.order.orderNo).join(', ')}` }
  }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    await tx.expense.update({
      where: { id: expenseId },
      data: {
        isVoid: true, voidReason: reason, voidedBy: BigInt(user.id), voidedAt: new Date(),
        updatedBy: BigInt(user.id),
      },
    })
    await logAction(tx, 'expenses', expenseId, AuditAction.VOID, ctx, {
      field: 'isVoid', oldValue: 'false', newValue: 'true',
    })
  })

  for (const a of expense.allocs) revalidatePath(`/orders/${a.orderId}`)
  return { ok: '지출 전표를 취소했습니다.' }
}

/** 금액 수정 — 사유 없이는 저장되지 않는다 */
export async function updateReceiptAmount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('transaction.write')
  const receiptId = BigInt(String(formData.get('receiptId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim() || undefined
  const amount = dec(formData.get('amount'))
  const fxRate = dec(formData.get('fxRate'))

  if (!amount || amount.lte(0)) return { error: '금액을 올바르게 입력하세요.' }

  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    include: { order: { include: { dealType: true } }, splits: true, account: true },
  })
  if (!receipt) return { error: '입금 전표를 찾을 수 없습니다.' }
  if (receipt.isVoid) return { error: '취소된 전표는 수정할 수 없습니다.' }
  if (receipt.order?.status === OrderStatus.SETTLED) {
    return { error: '정산완료된 주문입니다. 잠금해제 후 진행하세요.' }
  }

  const rounding = await krwRounding()
  const toKrw = (v: Prisma.Decimal) =>
    receipt.account.currency === Currency.KRW ? roundKrw(v, rounding) : cnyToKrw(v, fxRate ?? receipt.fxRate ?? 1, rounding)
  const toCny = (v: Prisma.Decimal) =>
    receipt.account.currency === Currency.CNY ? round2(v) : krwToCny(v, fxRate ?? receipt.fxRate ?? 1)

  // 금액이 바뀌면 분해도 같은 비율로 다시 만든다
  const ratio = amount.div(receipt.amount)

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, reason)
      await logUpdate(tx, 'receipts', receiptId,
        { amount: receipt.amount, fxRate: receipt.fxRate },
        { amount, fxRate: fxRate ?? receipt.fxRate },
        ctx)

      await tx.receiptSplit.deleteMany({ where: { receiptId } })
      let assigned = new Prisma.Decimal(0)
      const scaled = receipt.splits.map((s, i) => {
        const isLast = i === receipt.splits.length - 1
        // 마지막 항목이 잔액을 흡수해 합계가 정확히 맞도록 한다
        const v = isLast ? amount.minus(assigned) : roundKrw(s.amount.mul(ratio), rounding)
        assigned = assigned.plus(v)
        return { kind: s.splitKind, amount: v }
      })
      for (const s of scaled) {
        await tx.receiptSplit.create({
          data: {
            receiptId, splitKind: s.kind, amount: s.amount,
            amountKrw: toKrw(s.amount), amountCny: toCny(s.amount),
          },
        })
      }

      await tx.receipt.update({
        where: { id: receiptId },
        data: {
          amount, fxRate: fxRate ?? receipt.fxRate,
          amountKrw: toKrw(amount), amountCny: toCny(amount),
          updatedBy: BigInt(user.id),
        },
      })
    })
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '수정 중 오류가 발생했습니다.' }
  }

  if (receipt.orderId) revalidatePath(`/orders/${receipt.orderId}`)
  return { ok: '금액을 수정했습니다.' }
}
