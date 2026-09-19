/**
 * 월별 대시보드 집계.
 *
 * 설계 문서: docs/04-계산공식.md 7장
 *
 * 대표님이 이 한 화면에서 알아야 할 것:
 *   이번 달 얼마 벌었나 / 고객 돈을 얼마 갖고 있나 / 중국에 얼마 보내야 하나
 *   거래처별로 얼마 남나 / 중국 운영비가 얼마인가 / 세금계산서 얼마 발행하나
 */
import { Prisma, type Route, type Currency } from '@prisma/client'
import { prisma } from './db'
import { summarizeOrders } from './order-calc'
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

  /** 루트별 거래액 — 그 달에 들어온 입금 기준 (KRW 환산) */
  byRoute: { route: Route; label: string; revenue: Prisma.Decimal; orderCount: number }[]
  totalRevenue: Prisma.Decimal
  totalCost: Prisma.Decimal
  orderMargin: Prisma.Decimal

  /** 매출 구성 — 전부 입금일 기준 */
  salesRevenue: Prisma.Decimal
  feeRevenue: Prisma.Decimal
  /** 이 달에 받은 부가세 (매출이 아니다) */
  vatCollected: Prisma.Decimal
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

  /**
   * 이 달에 시작된 주문의 전 생애 수익성.
   * 기간 손익과 뜻이 다르다 — 나중에 입금·지출이 붙으면 이 숫자는 바뀐다.
   */
  orderStarted: {
    orderCount: number
    revenue: Prisma.Decimal
    cost: Prisma.Decimal
    margin: Prisma.Decimal
    marginRate: Prisma.Decimal | null
    unbilledOrderCount: number
    unbilledOrderCost: Prisma.Decimal
  }
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
  OVERSEAS: '해외송금', BANK_GEN: '일반통장', BANK_CORP: '법인통장', SITE: '사이트통장',
}

/**
 * ⓵ 기간 손익 — 전표에 적힌 날짜를 기준으로 집계한다.
 *
 * 이 달의 매출은 이 달에 들어온 입금이고, 이 달의 비용은 이 달에 나간 지출이다.
 * 주문을 기준으로 그 주문의 전 생애를 합산하면, 6월에 입금이 하나 더 들어왔을 때
 * 이미 끝난 5월 숫자가 바뀐다. 월별 손익은 그러면 안 된다.
 *
 * 주문 하나의 수익성은 따로 본다 (aggregateOrdersStarted).
 */
async function aggregateByPeriod(from: Date, to: Date, fx: Prisma.Decimal | null) {
  const toKrw = (v: Prisma.Decimal, currency: Currency) =>
    currency === 'CNY' ? (fx ? v.mul(fx) : zero()) : v

  // ── 매출: 입금일 기준, 입금 분해의 SALES + FEE
  const splitRows = await prisma.receiptSplit.findMany({
    where: {
      splitKind: { in: ['SALES', 'FEE', 'VAT'] },
      receipt: {
        isVoid: false,
        receiptDate: { gte: from, lte: to },
        partner: { isInternal: false }, // 이우드림 자체 거래 제외
      },
    },
    select: {
      splitKind: true, amountKrw: true, amountCny: true,
      receipt: {
        select: {
          route: true, currency: true,
          partnerId: true, partner: { select: { name: true } },
        },
      },
    },
  })

  const byRoute = new Map<string, { revenue: Prisma.Decimal; orderCount: number }>()
  const byPartner = new Map<string, PartnerRank>()
  const routeOrders = new Map<string, Set<string>>()

  let salesRevenue = zero(), feeRevenue = zero(), vatCollected = zero()

  for (const r of splitRows) {
    const cur = r.receipt.currency
    const v = toKrw(D(cur === 'CNY' ? (r.amountCny ?? 0) : (r.amountKrw ?? 0)), cur)
    if (r.splitKind === 'VAT') { vatCollected = vatCollected.plus(v); continue }
    if (r.splitKind === 'SALES') salesRevenue = salesRevenue.plus(v)
    else feeRevenue = feeRevenue.plus(v)

    const rt = byRoute.get(r.receipt.route) ?? { revenue: zero(), orderCount: 0 }
    rt.revenue = rt.revenue.plus(v)
    byRoute.set(r.receipt.route, rt)

    const pk = r.receipt.partnerId.toString()
    const p = byPartner.get(pk) ?? {
      partnerId: pk, partnerName: r.receipt.partner.name,
      revenue: zero(), margin: zero(), marginRate: null, orderCount: 0,
    }
    p.revenue = p.revenue.plus(v)
    byPartner.set(pk, p)
  }

  // 루트별 주문 건수 — 그 달에 입금이 있었던 주문의 수
  const receiptsInMonth = await prisma.receipt.findMany({
    where: {
      isVoid: false, receiptDate: { gte: from, lte: to },
      partner: { isInternal: false }, orderId: { not: null },
    },
    select: { route: true, orderId: true, partnerId: true },
  })
  for (const r of receiptsInMonth) {
    const set = routeOrders.get(r.route) ?? new Set<string>()
    set.add(r.orderId!.toString())
    routeOrders.set(r.route, set)
  }
  for (const [route, set] of routeOrders) {
    const rt = byRoute.get(route) ?? { revenue: zero(), orderCount: 0 }
    rt.orderCount = set.size
    byRoute.set(route, rt)
  }

  // ── 비용: 지출일 기준
  const expenses = await prisma.expense.findMany({
    where: { isVoid: false, expenseDate: { gte: from, lte: to } },
    select: {
      amountKrw: true, amountCny: true, currency: true,
      category: { select: { code: true, costType: true } },
      allocs: {
        select: {
          allocKrw: true, allocCny: true,
          order: { select: { partnerId: true, settlementCurrency: true, partner: { select: { name: true, isInternal: true } } } },
        },
      },
    },
  })

  let orderCost = zero(), goodsPurchase = zero()
  let opSalary = zero(), opInsurance = zero(), opTempLabor = zero(), opOffice = zero(), opEtc = zero()

  for (const e of expenses) {
    const cur = e.currency
    const amountKrw = toKrw(D(cur === 'CNY' ? (e.amountCny ?? 0) : (e.amountKrw ?? 0)), cur)
    if (e.category.code === 'GOODS') goodsPurchase = goodsPurchase.plus(amountKrw)

    if (e.allocs.length > 0) {
      // 주문에 붙은 지출 — 그 주문의 원가다
      for (const a of e.allocs) {
        const ac = a.order.settlementCurrency
        const av = toKrw(D(ac === 'CNY' ? (a.allocCny ?? 0) : (a.allocKrw ?? 0)), ac)
        orderCost = orderCost.plus(av)
        if (a.order.partner.isInternal) continue
        const pk = a.order.partnerId.toString()
        const p = byPartner.get(pk) ?? {
          partnerId: pk, partnerName: a.order.partner.name,
          revenue: zero(), margin: zero(), marginRate: null, orderCount: 0,
        }
        p.margin = p.margin.minus(av)
        byPartner.set(pk, p)
      }
      continue
    }

    // 부가세 납부는 국세청에 예수금을 넘겨주는 일이다.
    // 통장에서는 빠지지만 회사가 쓴 돈이 아니라 영업손익에 넣지 않는다.
    if (e.category.code === 'VAT_PAYMENT') continue

    // 주문에 안 붙은 지출 — 회사 운영비
    switch (e.category.code) {
      case 'SALARY': opSalary = opSalary.plus(amountKrw); break
      case 'INSURANCE': opInsurance = opInsurance.plus(amountKrw); break
      case 'TEMP_LABOR': opTempLabor = opTempLabor.plus(amountKrw); break
      case 'OFFICE': opOffice = opOffice.plus(amountKrw); break
      default:
        if (e.category.costType === 'ORDER_COST') orderCost = orderCost.plus(amountKrw)
        else opEtc = opEtc.plus(amountKrw)
    }
  }

  // 거래처별 마진 = 그 달 매출 − 그 달 원가
  for (const p of byPartner.values()) {
    p.margin = p.margin.plus(p.revenue)
    p.marginRate = p.revenue.gt(0) ? p.margin.div(p.revenue).mul(100).toDecimalPlaces(2) : null
  }
  // 그 달 주문 건수
  const partnerOrders = new Map<string, Set<string>>()
  for (const r of receiptsInMonth) {
    const set = partnerOrders.get(r.partnerId.toString()) ?? new Set<string>()
    set.add(r.orderId!.toString())
    partnerOrders.set(r.partnerId.toString(), set)
  }
  for (const [pk, set] of partnerOrders) {
    const p = byPartner.get(pk)
    if (p) p.orderCount = set.size
  }

  const opTotal = opSalary.plus(opInsurance).plus(opTempLabor).plus(opOffice).plus(opEtc)
  const revenue = salesRevenue.plus(feeRevenue)
  const margin = revenue.minus(orderCost).minus(opTotal)

  return {
    byRoute, byPartner,
    revenue, salesRevenue, feeRevenue, vatCollected,
    orderCost, goodsPurchase,
    opSalary, opInsurance, opTempLabor, opOffice, opEtc, opTotal,
    margin,
    marginRate: revenue.gt(0) ? margin.div(revenue).mul(100).toDecimalPlaces(2) : null,
  }
}

/**
 * ⓶ 주문 기준 — 그 달에 **시작된** 주문의 전 생애 수익성.
 *
 * 「이 달에 받은 일이 남는 장사였나」 를 본다. 나중에 입금·지출이 붙으면
 * 이 숫자는 바뀐다 — 그게 맞다. 기간 손익과 섞지 않으려고 따로 둔다.
 */
async function aggregateOrdersStarted(from: Date, to: Date, fx: Prisma.Decimal | null) {
  const orders = await prisma.order.findMany({
    where: {
      isVoid: false,
      orderDate: { gte: from, lte: to },
      partner: { isInternal: false },
    },
    select: { id: true, settlementCurrency: true, dealType: { select: { code: true } } },
  })
  const summaries = await summarizeOrders(orders.map((o) => o.id))

  let revenue = zero(), cost = zero(), margin = zero(), customsRev = zero()
  let unbilledCost = zero(), unbilledCount = 0

  for (const o of orders) {
    const s = summaries.get(o.id.toString())
    if (!s) continue
    const toKrw = (v: Prisma.Decimal) =>
      o.settlementCurrency === 'KRW' ? v : fx ? v.mul(fx) : zero()

    // 아직 한 푼도 안 들어온 주문은 마진에 넣지 않는다 — 비용만 있어 적자로 보인다
    if (s.grossIn.isZero()) {
      unbilledCost = unbilledCost.plus(toKrw(s.companyCost))
      unbilledCount += 1
      continue
    }
    revenue = revenue.plus(toKrw(s.revenue))
    cost = cost.plus(toKrw(s.companyCost))
    margin = margin.plus(toKrw(s.margin))
    if (o.dealType.code === 'CORP_CUSTOMS') customsRev = customsRev.plus(toKrw(s.margin))
  }

  return {
    orderCount: orders.length - unbilledCount,
    revenue, cost, margin,
    marginRate: revenue.gt(0) ? margin.div(revenue).mul(100).toDecimalPlaces(2) : null,
    customsRev, unbilledCost, unbilledCount,
  }
}

export async function dashboardData(ym: string): Promise<DashboardData> {
  const { from, to, label } = monthRange(ym)
  const fx = await latestFxRate()

  const [period, started] = await Promise.all([
    aggregateByPeriod(from, to, fx),
    aggregateOrdersStarted(from, to, fx),
  ])

  const [transferAgg, invPending, invIssued, unlockCount] = await Promise.all([
    prisma.internalTransfer.aggregate({
      where: { isVoid: false, transferDate: { gte: from, lte: to } },
      _sum: { usdAmount: true, cnyArrivalAmount: true },
    }),
    // 발행 예정은 시점 개념이 아니다 — 지금 남아 있는 미발행분 전체를 본다
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

  // 월말 시점 자금
  const funds = await fundsSnapshot(to)

  // 미발행 부가세 — 그 달까지 받은 것만
  const { listUnbilledVat } = await import('./invoice-calc')
  const unbilled = await listUnbilledVat(to)
  const unbilledVatAmount = unbilled.reduce((s2, r) => s2.plus(r.vatKrw), zero())

  // 최근 12개월 추이 — 기간 기준이라 과거 달은 바뀌지 않는다
  const trend: DashboardData['trend'] = []
  const [cy, cm] = ym.split('-').map(Number)
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cy, cm - 1 - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const r = monthRange(key)
    const a = await aggregateByPeriod(r.from, r.to, fx)
    trend.push({ ym: key, revenue: a.revenue, margin: a.margin })
  }

  const byRoute = (Object.keys(ROUTE_LABELS) as Route[])
    .map((route) => ({
      route,
      label: ROUTE_LABELS[route],
      revenue: period.byRoute.get(route)?.revenue ?? zero(),
      orderCount: period.byRoute.get(route)?.orderCount ?? 0,
    }))

  return {
    ym, label,

    byRoute,
    totalRevenue: period.revenue,
    salesRevenue: period.salesRevenue,
    feeRevenue: period.feeRevenue,
    vatCollected: period.vatCollected,
    totalCost: period.orderCost,
    goodsPurchase: period.goodsPurchase,

    opSalary: period.opSalary,
    opInsurance: period.opInsurance,
    opTempLabor: period.opTempLabor,
    opOffice: period.opOffice,
    opEtc: period.opEtc,
    opTotal: period.opTotal,

    operatingMargin: period.margin,
    operatingMarginRate: period.marginRate,

    agencyFee: period.feeRevenue,
    customsRevenue: started.customsRev,

    orderStarted: {
      orderCount: started.orderCount,
      revenue: started.revenue,
      cost: started.cost,
      margin: started.margin,
      marginRate: started.marginRate,
      unbilledOrderCount: started.unbilledCount,
      unbilledOrderCost: started.unbilledCost,
    },
    orderMargin: started.margin,
    unbilledOrderCount: started.unbilledCount,
    unbilledOrderCost: started.unbilledCost,

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

    ranks: [...period.byPartner.values()]
      .filter((p) => p.revenue.gt(0) || p.margin.abs().gt(0))
      .sort((a, b) => b.margin.comparedTo(a.margin))
      .slice(0, 10),
    trend,
    unlockCount,
  }
}
