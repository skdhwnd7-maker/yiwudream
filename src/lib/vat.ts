/**
 * 부가세 예수금 — 받아서 갖고 있는 부가세.
 *
 * 설계 문서: docs/04-계산공식.md 5장
 *
 * 받은 부가세를 처음부터 전부 누적해 「사용가능 자금」에서 빼면,
 * 이미 신고·납부한 부가세까지 영원히 회사 돈이 아닌 것으로 잡힌다.
 * 신고를 마친 기간은 vat_periods 에 확정해 두고, 그 기간 몫은 예수금에서 뺀다.
 *
 * 숫자는 프로그램이 만들지 않는다 — 세무사님이 주신 신고서 값을 그대로 넣는다.
 * 신고할 금액을 프로그램이 계산해 주지 않는 이유는, 그게 세무 판단이기 때문이다.
 */
import { Prisma, VatPeriodStatus } from '@prisma/client'
import { prisma } from './db'
import { D } from './money'

const zero = () => new Prisma.Decimal(0)

export interface VatStanding {
  /** 지금까지 받은 부가세 전부 */
  collectedTotal: Prisma.Decimal
  /** 신고를 마친 기간에 속한 몫 (더 이상 예수금이 아니다) */
  settled: Prisma.Decimal
  /** 아직 신고 전이라 갖고 있어야 하는 돈 */
  payable: Prisma.Decimal
  /** 신고는 했는데 아직 안 낸 금액 — 곧 나갈 돈 */
  filedUnpaid: Prisma.Decimal
  /** 신고를 마친 마지막 기간의 종료일. 이 뒤로 받은 것이 예수금이다 */
  settledThrough: Date | null
}

/**
 * 부가세 예수금을 낸다.
 *
 * 신고 완료(FILED)·납부 완료(PAID) 기간의 종료일까지 받은 부가세는 정산된 것으로 본다.
 * 기간이 하나도 없으면 예전과 같이 전부 예수금으로 잡는다 — 아직 아무것도 신고 안 한 상태다.
 */
export async function vatStanding(asOf?: Date): Promise<VatStanding> {
  const [collectedAgg, periods] = await Promise.all([
    prisma.receiptSplit.aggregate({
      where: {
        splitKind: 'VAT',
        receipt: { isVoid: false, ...(asOf ? { receiptDate: { lte: asOf } } : {}) },
      },
      _sum: { amountKrw: true },
    }),
    prisma.vatPeriod.findMany({
      where: {
        status: { in: [VatPeriodStatus.FILED, VatPeriodStatus.PAID] },
        ...(asOf ? { periodTo: { lte: asOf } } : {}),
      },
      orderBy: { periodTo: 'desc' },
    }),
  ])

  const collectedTotal = D(collectedAgg._sum.amountKrw ?? 0)
  const settledThrough = periods[0]?.periodTo ?? null

  if (!settledThrough) {
    return {
      collectedTotal,
      settled: zero(),
      payable: collectedTotal,
      filedUnpaid: zero(),
      settledThrough: null,
    }
  }

  // 정산된 기간 안에서 받은 부가세
  const settledAgg = await prisma.receiptSplit.aggregate({
    where: {
      splitKind: 'VAT',
      receipt: { isVoid: false, receiptDate: { lte: settledThrough } },
    },
    _sum: { amountKrw: true },
  })
  const settled = D(settledAgg._sum.amountKrw ?? 0)

  const filedUnpaid = periods
    .filter((p) => p.status === VatPeriodStatus.FILED)
    .reduce((s, p) => s.plus(D(p.salesVat).minus(D(p.purchaseVat))), zero())

  return {
    collectedTotal,
    settled,
    // 정산 뒤로 받은 것 + 신고했지만 아직 안 낸 것 = 갖고 있어야 할 돈
    payable: collectedTotal.minus(settled).plus(filedUnpaid),
    filedUnpaid,
    settledThrough,
  }
}

/** 신고기간 목록 — 화면용 */
export async function listVatPeriods() {
  const periods = await prisma.vatPeriod.findMany({ orderBy: { periodFrom: 'desc' } })
  const out = []
  for (const p of periods) {
    const agg = await prisma.receiptSplit.aggregate({
      where: {
        splitKind: 'VAT',
        receipt: {
          isVoid: false,
          receiptDate: { gte: p.periodFrom, lte: p.periodTo },
        },
      },
      _sum: { amountKrw: true },
    })
    const collected = D(agg._sum.amountKrw ?? 0)
    const declared = D(p.salesVat)
    out.push({
      ...p,
      /** 이 기간에 시스템이 실제로 받은 부가세 */
      collected,
      /** 신고서 매출세액과의 차이 — 0이 아니면 확인이 필요하다 */
      diff: declared.minus(collected),
      netPayable: declared.minus(D(p.purchaseVat)),
    })
  }
  return out
}
