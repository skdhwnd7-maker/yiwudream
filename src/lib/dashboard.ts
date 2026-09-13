/**
 * 월별 대시보드 집계.
 *
 * 설계 문서: docs/04-계산공식.md 7장
 *
 * 대표님이 이 한 화면에서 알아야 할 것:
 *   이번 달 얼마 벌었나 / 고객 돈을 얼마 갖고 있나 / 중국에 얼마 보내야 하나
 *   거래처별로 얼마 남나 / 중국 운영비가 얼마인가 / 세금계산서 얼마 발행하나
 */
import { Prisma, type Route } from '@prisma/client'
import { prisma } from './db'
import { summarizeOrder } from './order-calc'
import { fundsSnapshot, latestFxRate } from './funds'
import { D } from './money'

const zero = () => new Prisma.Decimal(0)

export interface MonthRange { from: Date; to: Date; label: string }

export function monthRange(ym: string): MonthRange {
  const [y, m] = ym.split('-').map(Number)
  return {
    from: new Date(y, m - 1, 1),
    to: new Date(y, m, 0, 23, 59, 59, 999),
    label: `${y}년 ${String(m).padStart(2, '0')}월`,
  }
}

export function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export interface PartnerRank {
  partnerId: string
  partnerName: string
  revenue: Prisma.Decimal
  margin: Prisma.Decimal
  marginRate: Prisma.Decimal | null
  orderCount: number
}

export interface DashboardData {
  ym: string
  label: string

  /** 루트별 거래액 (매출인식액, KRW 환산) */
  byRoute: { route: Route; label: string; revenue: Prisma.Decimal; orderCount: number }[]
  totalRevenue: Prisma.Decimal
  totalCost: Prisma.Decimal
  orderMargin: Prisma.Decimal

  /** 수익 구성 */
  agencyFee: Prisma.Decimal
  customsRevenue: Prisma.Decimal
  goodsPurchase: Prisma.Decimal

  /** 중국 운영비 (주문 미귀속) */
  opSalary: Prisma.Decimal
  opInsurance: Prisma.Decimal
  opTempLabor: Prisma.Decimal
  opOffice: Prisma.Decimal
  opEtc: Prisma.Decimal
  opTotal: Prisma.Decimal

  /** 아직 입금이 한 푼도 없는 주문 — 비용만 나간 건. 마진 집계에서 빼고 따로 알린다 */
  unbilledOrderCount: number
  unbilledOrderCost: Prisma.Decimal

  /** 최종 영업마진 = 주문마진 − 중국 운영비 */
  operatingMargin: Prisma.Decimal
  operatingMarginRate: Prisma.Decimal | null

  /** 내부 자금이동 — 거래액에 넣지 않고 별도 표시 */
  internalTransferUsd: Prisma.Decimal
  internalTransferCny: Prisma.Decimal

  /** 고객 자금 (월말 시점) */
  customerDeposits: Prisma.Decimal
  remitPending: Prisma.Decimal
  vatPayable: Prisma.Decimal
  available: Prisma.Decimal
  receivableTotal: Prisma.Decimal

  /** 세금계산서 */
  invoicePending: Prisma.Decimal
  invoiceIssued: Prisma.Decimal
  unbilledVatCount: number
  unbilledVatAmount: Prisma.Decimal

  ranks: PartnerRank[]
  /** 최근 12개월 추이 */
  trend: { ym: string; revenue: Prisma.Decimal; margin: Prisma.Decimal }[]
  /** 이번 달 잠금해제 건수 — 관리 신호 */
  unlockCount: number
}

const ROUTE_LABELS: Record<string, string> = {
  OVERSEAS: '해외송금', BANK_GEN: '일반통장', BANK_CORP: '법인통장', SITE: '사이트 결제',
}

/** 주문 하나를 KRW 기준으로 환산해 집계한다 */
async function aggregateOrders(from: Date, to: Date, fx: Prisma.Decimal | null) {
  const orders = await prisma.order.findMany({
    where: {
      isVoid: false,
      orderDate: { gte: from, lte: to },
      partner: { isInternal: false }, // 이우드림 자체 거래 제외
    },
    include: { partner: { select: { id: true, name: true } }, dealType: { select: { code: true } } },
  })

  const byRoute = new Map<string, { revenue: Prisma.Decimal; count: number }>()
  const byPartner = new Map<string, PartnerRank>()
  let totalRevenue = zero(), totalCost = zero(), margin = zero(), customsRev = zero()
  let unbilledCost = zero(), unbilledCount = 0

  for (const o of orders) {
    const s = await summarizeOrder(o.id)
    // CNY 정산 주문은 KRW로 환산해 합산한다. 환율이 없으면 0으로 두고 화면에서 알린다.
    const toKrw = (v: Prisma.Decimal) =>
      o.settlementCurrency === 'KRW' ? v : fx ? v.mul(fx) : zero()

    const rev = toKrw(s.revenue)
    const cost = toKrw(s.companyCost)
    const mar = toKrw(s.margin)

    // 아직 한 푼도 안 들어온 주문(미청구)은 마진에 넣지 않는다.
    // 비용만 있어 그 달을 큰 적자로 보이게 하지만, 돈은 나중에 받는다.
    // 숨기지는 않는다 — 아래 '미청구' 로 따로 세어 화면에 그대로 보여준다.
    if (s.grossIn.isZero()) {
      unbilledCost = unbilledCost.plus(cost)
      unbilledCount += 1
      continue
    }

    totalRevenue = totalRevenue.plus(rev)
    totalCost = totalCost.plus(cost)
    margin = margin.plus(mar)

    if (o.dealType.code === 'CORP_CUSTOMS') customsRev = customsRev.plus(mar)

    const r = byRoute.get(o.route) ?? { revenue: zero(), count: 0 }
    r.revenue = r.revenue.plus(rev)
    r.count += 1
    byRoute.set(o.route, r)

    const key = o.partner.id.toString()
    const p = byPartner.get(key) ?? {
      partnerId: key, partnerName: o.partner.name,
      revenue: zero(), margin: zero(), marginRate: null, orderCount: 0,
    }
    p.revenue = p.revenue.plus(rev)
    p.margin = p.margin.plus(mar)
    p.orderCount += 1
    byPartner.set(key, p)
  }

  for (const p of byPartner.values()) {
    p.marginRate = p.revenue.gt(0) ? p.margin.div(p.revenue).mul(100).toDecimalPlaces(2) : null
  }

  return { byRoute, byPartner, totalRevenue, totalCost, margin, customsRev, unbilledCost, unbilledCount }
}

export async function dashboardData(ym: string): Promise<DashboardData> {
  const { from, to, label } = monthRange(ym)
  const fx = await latestFxRate()

  const agg = await aggregateOrders(from, to, fx)

  // 수수료·상품구매액
  const [feeAgg, goodsAgg, transferAgg, invPending, invIssued, unlockCount] = await Promise.all([
    prisma.receiptSplit.aggregate({
      where: {
        splitKind: 'FEE',
        receipt: { isVoid: false, receiptDate: { gte: from, lte: to }, partner: { isInternal: false } },
      },
      _sum: { amountKrw: true },
    }),
    prisma.expense.aggregate({
      where: { isVoid: false, expenseDate: { gte: from, lte: to }, category: { code: 'GOODS' } },
      _sum: { amountKrw: true },
    }),
    prisma.internalTransfer.aggregate({
      where: { isVoid: false, transferDate: { gte: from, lte: to } },
      _sum: { usdAmount: true, cnyArrivalAmount: true },
    }),
    prisma.invoice.aggregate({
      where: { isVoid: false, issueStatus: 'PENDING' },
      _sum: { totalAmount: true },
    }),
    prisma.invoice.aggregate({
      where: { isVoid: false, issueStatus: 'ISSUED', issueDate: { gte: from, lte: to } },
      _sum: { totalAmount: true },
    }),
    prisma.auditLog.count({
      where: { action: 'UNLOCK', changedAt: { gte: from, lte: to } },
    }),
  ])

  // 중국 운영비 — 주문에 귀속되지 않은 지출만
  const opRows = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: {
      isVoid: false,
      expenseDate: { gte: from, lte: to },
      allocs: { none: {} },
      category: { costType: { in: ['OPERATING', 'BOTH'] } },
    },
    _sum: { amountKrw: true },
  })
  const cats = await prisma.expenseCategory.findMany({
    where: { id: { in: opRows.map((r) => r.categoryId) } },
    select: { id: true, code: true },
  })
  const codeOf = new Map(cats.map((c) => [c.id.toString(), c.code]))

  let opSalary = zero(), opInsurance = zero(), opTempLabor = zero(), opOffice = zero(), opEtc = zero()
  for (const r of opRows) {
    const v = D(r._sum.amountKrw ?? 0)
    switch (codeOf.get(r.categoryId.toString())) {
      case 'SALARY': opSalary = opSalary.plus(v); break
      case 'INSURANCE': opInsurance = opInsurance.plus(v); break
      case 'TEMP_LABOR': opTempLabor = opTempLabor.plus(v); break
      case 'OFFICE': opOffice = opOffice.plus(v); break
      default: opEtc = opEtc.plus(v)
    }
  }
  const opTotal = opSalary.plus(opInsurance).plus(opTempLabor).plus(opOffice).plus(opEtc)
  const operatingMargin = agg.margin.minus(opTotal)

  // 월말 시점 자금
  const funds = await fundsSnapshot(to)

  // 미발행 부가세
  const { listUnbilledVat } = await import('./invoice-calc')
  const unbilled = await listUnbilledVat()
  const unbilledVatAmount = unbilled.reduce((s, r) => s.plus(r.vatKrw), zero())

  // 최근 12개월 추이
  const trend: DashboardData['trend'] = []
  const [cy, cm] = ym.split('-').map(Number)
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cy, cm - 1 - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const r = monthRange(key)
    const a = await aggregateOrders(r.from, r.to, fx)
    trend.push({ ym: key, revenue: a.totalRevenue, margin: a.margin })
  }

  return {
    ym, label,
    byRoute: (['OVERSEAS', 'BANK_GEN', 'BANK_CORP', 'SITE'] as Route[]).map((route) => ({
      route,
      label: ROUTE_LABELS[route],
      revenue: agg.byRoute.get(route)?.revenue ?? zero(),
      orderCount: agg.byRoute.get(route)?.count ?? 0,
    })),
    totalRevenue: agg.totalRevenue,
    totalCost: agg.totalCost,
    orderMargin: agg.margin,
    agencyFee: D(feeAgg._sum.amountKrw ?? 0),
    customsRevenue: agg.customsRev,
    unbilledOrderCount: agg.unbilledCount,
    unbilledOrderCost: agg.unbilledCost,
    goodsPurchase: D(goodsAgg._sum.amountKrw ?? 0),
    opSalary, opInsurance, opTempLabor, opOffice, opEtc, opTotal,
    operatingMargin,
    operatingMarginRate: agg.totalRevenue.gt(0)
      ? operatingMargin.div(agg.totalRevenue).mul(100).toDecimalPlaces(2)
      : null,
    internalTransferUsd: D(transferAgg._sum.usdAmount ?? 0),
    internalTransferCny: D(transferAgg._sum.cnyArrivalAmount ?? 0),
    customerDeposits: funds.customerDeposits,
    remitPending: funds.remitPending,
    vatPayable: funds.vatPayable,
    available: funds.available,
    receivableTotal: funds.receivableTotal,
    invoicePending: D(invPending._sum.totalAmount ?? 0),
    invoiceIssued: D(invIssued._sum.totalAmount ?? 0),
    unbilledVatCount: unbilled.length,
    unbilledVatAmount,
    ranks: [...agg.byPartner.values()].sort((a, b) => b.margin.comparedTo(a.margin)).slice(0, 10),
    trend,
    unlockCount,
  }
}
