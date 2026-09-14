/**
 * 주문 단위 집계.
 *
 * 설계 문서: docs/04-계산공식.md
 *
 * 화면·리포트가 모두 이 함수만 쓴다. 같은 숫자가 화면마다 다르게 나오는 일을 막기 위해서다.
 */
import { Prisma, type RevenueBasis, type Currency } from '@prisma/client'
import { prisma } from './db'
import { D, marginRate, costMarkupRate, splitVat, type RoundingMode } from './money'

type Tx = Prisma.TransactionClient | typeof prisma

/** 주문 원가 분류 — 화면에 이 순서로 나온다 */
export const COST_GROUPS = [
  { key: 'goods', label: '상품비', codes: ['GOODS'] },
  { key: 'customs', label: '대행통관비', codes: ['CUSTOMS'] },
  { key: 'labor', label: '인건비', codes: ['LABOR_CN', 'TEMP_LABOR'] },
  { key: 'inspect', label: '검품비', codes: ['INSPECT'] },
  { key: 'packing', label: '포장비', codes: ['PACKING'] },
  { key: 'shipping', label: '운송비', codes: ['SHIPPING'] },
  { key: 'etc', label: '기타비', codes: ['ETC_ORDER', 'BANK_FEE'] },
] as const

export type CostKey = (typeof COST_GROUPS)[number]['key']

export interface OrderSummary {
  orderId: string
  currency: Currency
  revenueBasis: RevenueBasis

  /** 실제 통장에 들어온 금액 합계 (부가세·예치금 포함) */
  grossIn: Prisma.Decimal
  /** 공급가액 (SALES) */
  salesIn: Prisma.Decimal
  /** 구매대행 수수료 공급가액 (FEE) */
  feeIn: Prisma.Decimal
  /** 받은 부가세 — 국세청에 낼 돈 */
  vatIn: Prisma.Decimal
  /** 상품구매 예치금 — 고객 돈, 송금 대상 */
  depositGoodsIn: Prisma.Decimal
  /** 용도미지정 예치금 */
  depositGeneralIn: Prisma.Decimal

  /** 마진 계산의 분자 = SALES + FEE */
  revenue: Prisma.Decimal

  costs: Record<CostKey, Prisma.Decimal>
  totalCost: Prisma.Decimal
  /** NET 주문에서 예치금으로 나간 상품대금 — 회사 비용이 아니다 */
  depositFundedCost: Prisma.Decimal
  companyCost: Prisma.Decimal

  margin: Prisma.Decimal
  /** 매출 대비 (%) — 시스템 기본. 분모 0이면 null */
  marginRatePct: Prisma.Decimal | null
  /** 원가 대비 (%) — 기존 엑셀 `%` 열과 같은 값 */
  costMarkupPct: Prisma.Decimal | null

  /** 미수금 — 비용이 입금을 넘어선 금액 (진행중 주문만 의미 있다) */
  receivable: Prisma.Decimal
  /** 중국 송금 완료액 */
  remitted: Prisma.Decimal
  /** 송금 대기액 = 상품구매 예치금 − 송금완료 (0 미만은 0으로 본다) */
  remitPending: Prisma.Decimal
  /**
   * 예치금보다 더 보낸 금액. 0이어야 정상이다.
   * 대기액을 0으로 자르면 초과송금이 화면에서 사라지므로 따로 들고 다닌다.
   */
  remitExcess: Prisma.Decimal
  remitStatus: 'NONE' | 'PENDING' | 'PARTIAL' | 'DONE' | 'OVER'
}

const zero = () => new Prisma.Decimal(0)

const emptyCosts = (): Record<CostKey, Prisma.Decimal> =>
  Object.fromEntries(COST_GROUPS.map((g) => [g.key, zero()])) as Record<CostKey, Prisma.Decimal>

/** 주문의 정산통화에 맞는 컬럼을 고른다. 해외송금은 CNY, 그 외는 KRW. */
const pick = (currency: Currency, krw: Prisma.Decimal | null, cny: Prisma.Decimal | null): Prisma.Decimal =>
  currency === 'CNY' ? (cny ?? zero()) : (krw ?? zero())

/** 계산에 실제로 필요한 것만. 한 건씩 읽든 여러 건을 한 번에 읽든 이 모양으로 맞춘다 */
interface SummaryInput {
  currency: Currency
  basis: RevenueBasis
  receipts: { amountKrw: Prisma.Decimal; amountCny: Prisma.Decimal | null
    splits: { splitKind: string; amountKrw: Prisma.Decimal | null; amountCny: Prisma.Decimal | null }[] }[]
  allocs: { allocKrw: Prisma.Decimal | null; allocCny: Prisma.Decimal | null; categoryCode: string }[]
  remitAllocs: { allocKrw: Prisma.Decimal; allocCny: Prisma.Decimal | null }[]
}

/**
 * 주문 하나의 숫자를 낸다. DB 를 건드리지 않는 순수 계산이다.
 * 화면 한 건 조회(summarizeOrder)와 대시보드 일괄 집계(summarizeOrders)가 같은 함수를 써야
 * 「주문 상세의 마진」 과 「대시보드의 마진」 이 어긋나지 않는다.
 */
function computeSummary(orderId: bigint, input: SummaryInput): OrderSummary {
  const { currency, basis, receipts, allocs, remitAllocs } = input

  let grossIn = zero(), salesIn = zero(), feeIn = zero(), vatIn = zero()
  let depGoods = zero(), depGeneral = zero()

  for (const r of receipts) {
    grossIn = grossIn.plus(pick(currency, r.amountKrw, r.amountCny))
    for (const s of r.splits) {
      const v = pick(currency, s.amountKrw, s.amountCny)
      if (s.splitKind === 'SALES') salesIn = salesIn.plus(v)
      else if (s.splitKind === 'FEE') feeIn = feeIn.plus(v)
      else if (s.splitKind === 'VAT') vatIn = vatIn.plus(v)
      else if (s.splitKind === 'DEPOSIT_GOODS') depGoods = depGoods.plus(v)
      else if (s.splitKind === 'DEPOSIT_GENERAL') depGeneral = depGeneral.plus(v)
    }
  }

  const costs = emptyCosts()
  let totalCost = zero()
  let goodsCost = zero()

  for (const a of allocs) {
    const v = pick(currency, a.allocKrw, a.allocCny)
    const code = a.categoryCode
    const group = COST_GROUPS.find((g) => (g.codes as readonly string[]).includes(code))
    const key: CostKey = group?.key ?? 'etc'
    costs[key] = costs[key].plus(v)
    totalCost = totalCost.plus(v)
    if (code === 'GOODS') goodsCost = goodsCost.plus(v)
  }

  // NET 주문(사이트 결제)에서는 상품대금이 고객 예치금에서 나간다.
  // 회사가 부담한 돈이 아니므로 마진 계산에서 뺀다.
  const depositFundedCost =
    basis === 'NET' ? (goodsCost.lte(depGoods) ? goodsCost : depGoods) : zero()
  const companyCost = totalCost.minus(depositFundedCost)

  const revenue = salesIn.plus(feeIn)
  const margin = revenue.minus(companyCost)

  const remitted = remitAllocs.reduce(
    (acc, x) => acc.plus(currency === 'CNY' ? (x.allocCny ?? zero()) : x.allocKrw),
    zero(),
  )
  const remitPending = depGoods.minus(remitted)

  const remitExcess = remitted.gt(depGoods) ? remitted.minus(depGoods) : zero()

  let remitStatus: OrderSummary['remitStatus'] = 'NONE'
  if (remitExcess.gt(0)) {
    // 예치금보다 많이 보냈다. 정상적으로는 나올 수 없는 상태다 — 숨기지 않고 드러낸다
    remitStatus = 'OVER'
  } else if (depGoods.gt(0)) {
    if (remitted.lte(0)) remitStatus = 'PENDING'
    else if (remitted.gte(depGoods)) remitStatus = 'DONE'
    else remitStatus = 'PARTIAL'
  }

  const receivable = companyCost.gt(revenue) ? companyCost.minus(revenue) : zero()

  return {
    orderId: orderId.toString(),
    currency,
    revenueBasis: basis,
    grossIn, salesIn, feeIn, vatIn,
    depositGoodsIn: depGoods,
    depositGeneralIn: depGeneral,
    revenue,
    costs, totalCost, depositFundedCost, companyCost,
    margin,
    marginRatePct: marginRate(margin, revenue),
    costMarkupPct: costMarkupRate(margin, companyCost),
    receivable,
    remitted,
    remitPending: remitPending.gt(0) ? remitPending : zero(),
    remitExcess,
    remitStatus,
  }
}

/** 주문 한 건 — 화면에서 쓴다 */
export async function summarizeOrder(orderId: bigint, tx: Tx = prisma): Promise<OrderSummary> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { dealType: true },
  })
  const [receipts, allocs, remitAllocs] = await Promise.all([
    tx.receipt.findMany({ where: { orderId, isVoid: false }, include: { splits: true } }),
    tx.expenseAllocation.findMany({
      where: { orderId, expense: { isVoid: false } },
      include: { expense: { include: { category: { select: { code: true } } } } },
    }),
    tx.remittanceAllocation.findMany({
      where: { orderId, remittance: { isVoid: false, status: { in: ['SENT', 'ARRIVED'] } } },
    }),
  ])
  return computeSummary(orderId, {
    currency: order.settlementCurrency,
    basis: order.dealType.revenueBasis,
    receipts,
    allocs: allocs.map((a) => ({
      allocKrw: a.allocKrw, allocCny: a.allocCny, categoryCode: a.expense.category.code,
    })),
    remitAllocs,
  })
}

/**
 * 주문 여러 건을 한 번에 — 대시보드·리포트에서 쓴다.
 *
 * 한 건씩 부르면 주문 수만큼 질의가 나간다. 실제 자료(주문 733건)에서 대시보드가
 * 6.7초 걸리던 이유다. 필요한 것을 세 번에 나눠 읽고 메모리에서 묶는다.
 */
export async function summarizeOrders(
  orderIds: bigint[], tx: Tx = prisma,
  /**
   * 이 날짜까지의 전표만 센다. 「그때 시점의 장부」 를 볼 때 쓴다.
   * 안 주면 지금까지 전부.
   */
  asOf?: Date,
): Promise<Map<string, OrderSummary>> {
  const out = new Map<string, OrderSummary>()
  if (orderIds.length === 0) return out

  const [orders, receipts, allocs, remitAllocs] = await Promise.all([
    tx.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, settlementCurrency: true, dealType: { select: { revenueBasis: true } } },
    }),
    tx.receipt.findMany({
      where: {
        orderId: { in: orderIds }, isVoid: false,
        ...(asOf ? { receiptDate: { lte: asOf } } : {}),
      },
      select: { orderId: true, amountKrw: true, amountCny: true, splits: true },
    }),
    tx.expenseAllocation.findMany({
      where: {
        orderId: { in: orderIds },
        expense: { isVoid: false, ...(asOf ? { expenseDate: { lte: asOf } } : {}) },
      },
      select: {
        orderId: true, allocKrw: true, allocCny: true,
        expense: { select: { category: { select: { code: true } } } },
      },
    }),
    tx.remittanceAllocation.findMany({
      where: {
        orderId: { in: orderIds },
        remittance: {
          isVoid: false, status: { in: ['SENT', 'ARRIVED'] },
          ...(asOf ? { remitDate: { lte: asOf } } : {}),
        },
      },
      select: { orderId: true, allocKrw: true, allocCny: true },
    }),
  ])

  const group = <T extends { orderId: bigint | null }>(rows: T[]) => {
    const m = new Map<string, T[]>()
    for (const r of rows) {
      if (r.orderId === null) continue
      const k = r.orderId.toString()
      const arr = m.get(k)
      if (arr) arr.push(r)
      else m.set(k, [r])
    }
    return m
  }
  const rByOrder = group(receipts)
  const aByOrder = group(allocs)
  const mByOrder = group(remitAllocs)

  for (const o of orders) {
    const k = o.id.toString()
    out.set(k, computeSummary(o.id, {
      currency: o.settlementCurrency,
      basis: o.dealType.revenueBasis,
      receipts: rByOrder.get(k) ?? [],
      allocs: (aByOrder.get(k) ?? []).map((a) => ({
        allocKrw: a.allocKrw, allocCny: a.allocCny, categoryCode: a.expense.category.code,
      })),
      remitAllocs: mByOrder.get(k) ?? [],
    }))
  }
  return out
}

/**
 * 입금액을 루트·거래유형에 맞게 분해한다.
 *
 * 법인통장  3,456,960 → SALES 3,142,691 + VAT 314,269
 * 사이트    1,100,000 → DEPOSIT_GOODS 1,000,000 + FEE 90,909 + VAT 9,091
 * 일반통장/해외송금     → SALES 전액 (부가세 무관)
 */
export interface SplitInput {
  amount: Prisma.Decimal.Value
  vatMode: 'INCLUDED' | 'EXCLUDED' | 'EXEMPT' | 'ZERO' | 'NONE'
  vatRate: Prisma.Decimal.Value
  rounding: RoundingMode
  /** 사이트 루트: 상품구매 예치금으로 잡을 금액 */
  depositGoods?: Prisma.Decimal.Value
  /** 주문 없이 예치금만 적립하는 경우 */
  depositGeneralOnly?: boolean
  /** 세금계산서 발행 여부와 무관하게 부가세를 받았는지 */
  vatCharged: boolean
}

export interface SplitResult {
  kind: 'SALES' | 'FEE' | 'VAT' | 'DEPOSIT_GOODS' | 'DEPOSIT_GENERAL'
  amount: Prisma.Decimal
}

export function computeSplits(input: SplitInput): SplitResult[] {
  const total = D(input.amount)

  if (input.depositGeneralOnly) {
    return [{ kind: 'DEPOSIT_GENERAL', amount: total }]
  }

  const depositGoods = D(input.depositGoods ?? 0)
  const remainder = total.minus(depositGoods) // 수수료 또는 매출로 잡힐 부분

  const out: SplitResult[] = []
  if (depositGoods.gt(0)) out.push({ kind: 'DEPOSIT_GOODS', amount: depositGoods })

  if (remainder.lte(0)) return out

  const revenueKind = depositGoods.gt(0) ? 'FEE' : 'SALES'

  if (!input.vatCharged || input.vatMode === 'NONE' || input.vatMode === 'EXEMPT' || input.vatMode === 'ZERO') {
    out.push({ kind: revenueKind, amount: remainder })
    return out
  }

  // 부가세를 받은 경우: 남은 금액 안에 부가세가 들어 있다.
  // EXCLUDED 유형이라도 통장에 찍힌 금액에는 이미 부가세가 포함돼 들어온다.
  const { supply, vat } = splitVat(remainder, 'INCLUDED', input.vatRate, input.rounding)
  out.push({ kind: revenueKind, amount: supply })
  if (vat.gt(0)) out.push({ kind: 'VAT', amount: vat })
  return out
}
