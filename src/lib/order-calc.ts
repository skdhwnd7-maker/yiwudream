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
  /** 송금 대기액 = 상품구매 예치금 − 송금완료 */
  remitPending: Prisma.Decimal
  remitStatus: 'NONE' | 'PENDING' | 'PARTIAL' | 'DONE'
}

const zero = () => new Prisma.Decimal(0)

const emptyCosts = (): Record<CostKey, Prisma.Decimal> =>
  Object.fromEntries(COST_GROUPS.map((g) => [g.key, zero()])) as Record<CostKey, Prisma.Decimal>

/** 주문의 정산통화에 맞는 컬럼을 고른다. 해외송금은 CNY, 그 외는 KRW. */
const pick = (currency: Currency, krw: Prisma.Decimal | null, cny: Prisma.Decimal | null): Prisma.Decimal =>
  currency === 'CNY' ? (cny ?? zero()) : (krw ?? zero())

export async function summarizeOrder(orderId: bigint, tx: Tx = prisma): Promise<OrderSummary> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { dealType: true },
  })
  const currency = order.settlementCurrency
  const basis = order.dealType.revenueBasis

  const [receipts, allocs, remitAllocs] = await Promise.all([
    tx.receipt.findMany({
      where: { orderId, isVoid: false },
      include: { splits: true },
    }),
    tx.expenseAllocation.findMany({
      where: { orderId, expense: { isVoid: false } },
      include: { expense: { include: { category: true } } },
    }),
    tx.remittanceAllocation.findMany({
      where: { orderId, remittance: { isVoid: false, status: { in: ['SENT', 'ARRIVED'] } } },
    }),
  ])

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
    const code = a.expense.category.code
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

  let remitStatus: OrderSummary['remitStatus'] = 'NONE'
  if (depGoods.gt(0)) {
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
    remitStatus,
  }
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
