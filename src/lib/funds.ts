/**
 * 자금현황 집계.
 *
 * 설계 문서: docs/04-계산공식.md 5장
 *
 * 핵심: 통장에 있는 돈이 전부 회사 돈이 아니다.
 *   계좌잔액 − 고객예치금 − 부가세예수금 − 미지급비용 = 실제 사용가능 자금
 */
import { Prisma, type Entity } from '@prisma/client'
import { prisma } from './db'
import { D } from './money'

const zero = () => new Prisma.Decimal(0)

export interface AccountBalance {
  id: string
  name: string
  entity: Entity
  currency: string
  /** 계좌 통화 기준 잔액 */
  balance: Prisma.Decimal
}

export interface PartnerDeposit {
  partnerId: string
  partnerName: string
  goodsFund: Prisma.Decimal
  general: Prisma.Decimal
  total: Prisma.Decimal
}

export interface Receivable {
  orderId: string
  orderNo: string
  partnerId: string
  partnerName: string
  currency: string
  amount: Prisma.Decimal
  amountKrw: Prisma.Decimal
  /** 마크업을 붙인 청구 예정액 */
  billableKrw: Prisma.Decimal
  firstDate: Date
  daysOld: number
}

export interface FundsSnapshot {
  accounts: AccountBalance[]
  /** ① 전체 계좌잔액 (KRW 환산) */
  totalBalanceKrw: Prisma.Decimal
  /** ② 고객 예치금 */
  customerDeposits: Prisma.Decimal
  /** ③ 그중 중국 송금대기금 */
  remitPending: Prisma.Decimal
  /** ④ 미지급 비용 */
  unpaidExpenses: Prisma.Decimal
  /**
   * ⑤ 부가세 예수금 — 아직 신고·납부하지 않아 갖고 있어야 하는 부가세.
   * 신고를 마친 기간 몫은 빠진다 (src/lib/vat.ts).
   */
  vatPayable: Prisma.Decimal
  /** 지금까지 받은 부가세 전부 — 정산분 포함 */
  vatCollectedTotal: Prisma.Decimal
  /** 신고를 마친 마지막 기간의 종료일 */
  vatSettledThrough: Date | null
  /** ⑥ 실제 사용가능 자금 */
  available: Prisma.Decimal
  /** ⑦ 미수금 — 잔액엔 없지만 받을 자산 */
  receivableTotal: Prisma.Decimal
  depositsByPartner: PartnerDeposit[]
  receivables: Receivable[]
}

/**
 * CNY 계좌를 KRW로 환산할 때 쓸 환율.
 * 최근 입금 전표의 실제 적용환율을 쓴다. 없으면 참고환율, 그것도 없으면 null.
 * 임의의 값을 지어내지 않는다 — 환산 불가는 화면에서 그대로 알린다.
 */
export async function latestFxRate(asOf?: Date): Promise<Prisma.Decimal | null> {
  const recent = await prisma.receipt.findFirst({
    where: {
      fxRate: { not: null }, isVoid: false,
      ...(asOf ? { receiptDate: { lte: asOf } } : {}),
    },
    orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }],
    select: { fxRate: true },
  })
  if (recent?.fxRate) return recent.fxRate

  const ref = await prisma.fxRateRef.findFirst({
    where: {
      baseCurrency: 'CNY', quoteCurrency: 'KRW',
      ...(asOf ? { rateDate: { lte: asOf } } : {}),
    },
    orderBy: { rateDate: 'desc' },
  })
  return ref?.rate ?? null
}

export async function accountBalances(asOf?: Date): Promise<AccountBalance[]> {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    orderBy: [{ entity: 'asc' }, { name: 'asc' }],
  })
  const dateFilter = asOf ? { lte: asOf } : undefined

  const out: AccountBalance[] = []
  for (const a of accounts) {
    const [inflow, outflow, remitOut, remitIn, transferOut, transferIn] = await Promise.all([
      prisma.receipt.aggregate({
        where: { accountId: a.id, isVoid: false, ...(dateFilter ? { receiptDate: dateFilter } : {}) },
        _sum: { amount: true },
      }),
      // 송금수수료는 BANK_FEE 지출 전표로 남아 여기 이미 포함된다.
      // remittance.bankFeeKrw 를 또 빼면 같은 수수료가 두 번 빠진다.
      prisma.expense.aggregate({
        where: {
          accountId: a.id, isVoid: false, paymentStatus: 'PAID',
          ...(dateFilter ? { paidAt: dateFilter } : {}),
        },
        _sum: { amount: true },
      }),
      // DRAFT 는 아직 은행에 넣지 않은 전표다. 통장에서 빠지지 않았다.
      prisma.remittance.aggregate({
        where: {
          fromAccountId: a.id, isVoid: false, status: { in: ['SENT', 'ARRIVED'] },
          ...(dateFilter ? { remitDate: dateFilter } : {}),
        },
        _sum: { krwAmount: true },
      }),
      prisma.remittance.aggregate({
        where: { toAccountId: a.id, isVoid: false, status: 'ARRIVED', ...(dateFilter ? { remitDate: dateFilter } : {}) },
        _sum: { cnyArrivalAmount: true },
      }),
      prisma.internalTransfer.aggregate({
        where: { fromAccountId: a.id, isVoid: false, ...(dateFilter ? { transferDate: dateFilter } : {}) },
        _sum: { krwAmount: true, bankFee: true },
      }),
      prisma.internalTransfer.aggregate({
        where: { toAccountId: a.id, isVoid: false, ...(dateFilter ? { transferDate: dateFilter } : {}) },
        _sum: { cnyArrivalAmount: true },
      }),
    ])

    let bal = D(a.openingBalance)
      .plus(inflow._sum.amount ?? 0)
      .minus(outflow._sum.amount ?? 0)

    if (a.currency === 'KRW') {
      // 송금수수료(bankFeeKrw)는 여기서 빼지 않는다 — 위 outflow 의 BANK_FEE 전표가 이미 뺐다
      bal = bal
        .minus(remitOut._sum.krwAmount ?? 0)
        .minus(transferOut._sum.krwAmount ?? 0)
        .minus(transferOut._sum.bankFee ?? 0)
    } else if (a.currency === 'CNY') {
      bal = bal
        .plus(remitIn._sum.cnyArrivalAmount ?? 0)
        .plus(transferIn._sum.cnyArrivalAmount ?? 0)
    }

    out.push({
      id: a.id.toString(), name: a.name, entity: a.entity,
      currency: a.currency, balance: bal,
    })
  }
  return out
}

export async function fundsSnapshot(asOf?: Date): Promise<FundsSnapshot> {
  // asOf 를 주면 그 시점의 장부를 본다 — 환율도 그때까지 알려진 것을 쓴다.
  // 오늘 환율로 과거 잔액을 환산하면 지난 달 숫자가 오늘마다 바뀐다.
  const [accounts, fxRate] = await Promise.all([accountBalances(asOf), latestFxRate(asOf)])

  let totalBalanceKrw = zero()
  for (const a of accounts) {
    if (a.currency === 'KRW') totalBalanceKrw = totalBalanceKrw.plus(a.balance)
    else if (a.currency === 'CNY' && fxRate) totalBalanceKrw = totalBalanceKrw.plus(a.balance.mul(fxRate))
    // 환율을 모르는 외화 계좌는 합계에서 빼고 화면에서 따로 알린다
  }

  const { vatStanding } = await import('./vat')
  const [depositRows, vat, unpaidAgg] = await Promise.all([
    prisma.depositLedger.groupBy({
      by: ['partnerId', 'depositKind'],
      _sum: { amountKrw: true },
      ...(asOf ? { where: { movementDate: { lte: asOf } } } : {}),
    }),
    vatStanding(asOf),
    // ⚠ 지급여부는 지금 상태다. 나중에 지급한 건도 과거 시점 조회에서는
    //    「미지급」 으로 나오지 않는다 — 상태 변경 이력을 따로 남기지 않기 때문이다.
    //    지금 미지급인 것만 센다.
    prisma.expense.aggregate({
      where: { paymentStatus: 'PLANNED', isVoid: false, ...(asOf ? { expenseDate: { lte: asOf } } : {}) },
      _sum: { amountKrw: true },
    }),
  ])

  const byPartner = new Map<string, { goodsFund: Prisma.Decimal; general: Prisma.Decimal }>()
  for (const row of depositRows) {
    const key = row.partnerId.toString()
    const cur = byPartner.get(key) ?? { goodsFund: zero(), general: zero() }
    const v = D(row._sum.amountKrw ?? 0)
    if (row.depositKind === 'GOODS_FUND') cur.goodsFund = cur.goodsFund.plus(v)
    else cur.general = cur.general.plus(v)
    byPartner.set(key, cur)
  }

  const partnerIds = [...byPartner.keys()].map((k) => BigInt(k))
  const partners = partnerIds.length
    ? await prisma.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(partners.map((p) => [p.id.toString(), p.name]))

  const depositsByPartner: PartnerDeposit[] = [...byPartner.entries()]
    .map(([id, v]) => ({
      partnerId: id,
      partnerName: nameOf.get(id) ?? '(알 수 없음)',
      goodsFund: v.goodsFund,
      general: v.general,
      total: v.goodsFund.plus(v.general),
    }))
    .filter((d) => !d.total.isZero())
    .sort((a, b) => b.total.comparedTo(a.total))

  const customerDeposits = depositsByPartner.reduce((s, d) => s.plus(d.total), zero())
  const remitPending = depositsByPartner.reduce((s, d) => s.plus(d.goodsFund), zero())
  const vatPayable = vat.payable
  const unpaidExpenses = D(unpaidAgg._sum.amountKrw ?? 0)

  const receivables = await listReceivables(asOf)
  const receivableTotal = receivables.reduce((s, r) => s.plus(r.amountKrw), zero())

  return {
    accounts,
    totalBalanceKrw,
    customerDeposits,
    remitPending,
    unpaidExpenses,
    vatPayable,
    vatCollectedTotal: vat.collectedTotal,
    vatSettledThrough: vat.settledThrough,
    available: totalBalanceKrw.minus(customerDeposits).minus(vatPayable).minus(unpaidExpenses),
    receivableTotal,
    depositsByPartner,
    receivables,
  }
}

/**
 * 미수금 — 진행중 주문에서 회사부담 비용이 매출인식액을 넘은 금액.
 * asOf 를 주면 그 시점 기준으로 본다 (그 뒤에 들어온 입금은 세지 않는다).
 */
export async function listReceivables(asOf?: Date): Promise<Receivable[]> {
  const { summarizeOrders } = await import('./order-calc')
  const orders = await prisma.order.findMany({
    where: {
      status: 'OPEN', isVoid: false,
      ...(asOf ? { orderDate: { lte: asOf } } : {}),
    },
    include: { partner: { select: { id: true, name: true, defaultMarkupRate: true } } },
    orderBy: { orderDate: 'asc' },
  })

  const [fx, summaries] = await Promise.all([
    latestFxRate(asOf),
    summarizeOrders(orders.map((o) => o.id), prisma, asOf),
  ])
  const out: Receivable[] = []
  const now = Date.now()

  for (const o of orders) {
    const s = summaries.get(o.id.toString())
    if (!s || s.receivable.lte(0)) continue

    const amountKrw =
      o.settlementCurrency === 'KRW'
        ? s.receivable
        : fx
          ? s.receivable.mul(fx)
          : zero()

    const markup = D(o.partner.defaultMarkupRate ?? 0)
    const billableKrw = amountKrw.mul(markup.div(100).plus(1)).toDecimalPlaces(0)

    out.push({
      orderId: o.id.toString(),
      orderNo: o.orderNo,
      partnerId: o.partner.id.toString(),
      partnerName: o.partner.name,
      currency: o.settlementCurrency,
      amount: s.receivable,
      amountKrw,
      billableKrw,
      firstDate: o.orderDate,
      daysOld: Math.floor((now - o.orderDate.getTime()) / 86_400_000),
    })
  }

  return out.sort((a, b) => b.amountKrw.comparedTo(a.amountKrw))
}

/** 중국으로 보내야 할 돈 — 주문별 송금대기 목록 */
export interface RemitPendingRow {
  orderId: string
  orderNo: string
  partnerId: string
  partnerName: string
  goodsFund: Prisma.Decimal
  remitted: Prisma.Decimal
  pending: Prisma.Decimal
  /** 예치금보다 많이 보낸 금액. 0이어야 정상이다 */
  excess: Prisma.Decimal
  status: 'PENDING' | 'PARTIAL' | 'DONE' | 'OVER'
  orderDate: Date
}

export async function listRemitPending(includeDone = false): Promise<RemitPendingRow[]> {
  const { summarizeOrders } = await import('./order-calc')
  const orders = await prisma.order.findMany({
    where: {
      isVoid: false,
      receipts: { some: { isVoid: false, splits: { some: { splitKind: 'DEPOSIT_GOODS' } } } },
    },
    include: { partner: { select: { id: true, name: true } } },
    orderBy: { orderDate: 'asc' },
  })

  const summaries = await summarizeOrders(orders.map((o) => o.id))
  const out: RemitPendingRow[] = []
  for (const o of orders) {
    const s = summaries.get(o.id.toString())
    if (!s || s.depositGoodsIn.lte(0)) continue
    if (!includeDone && s.remitStatus === 'DONE') continue
    out.push({
      orderId: o.id.toString(), orderNo: o.orderNo,
      partnerId: o.partner.id.toString(), partnerName: o.partner.name,
      goodsFund: s.depositGoodsIn, remitted: s.remitted, pending: s.remitPending,
      excess: s.remitExcess,
      status: s.remitStatus === 'NONE' ? 'PENDING' : s.remitStatus,
      orderDate: o.orderDate,
    })
  }
  return out
}
