/**
 * Phase 5 검증 — 대시보드 집계
 *
 * 대시보드는 "대표님이 이 한 화면만 봐도 되는" 화면이라 숫자가 틀리면 안 된다.
 * 검증 대상은 집계 규칙이다:
 *   ① 자사(이우드림) 거래는 거래액에서 빠진다
 *   ② 내부 자금이동은 거래액에 들어가지 않고 따로 표시된다
 *   ③ 입금이 한 푼도 없는 주문은 마진에서 빠지고 '미청구'로 따로 세어진다
 *   ④ 주문에 귀속된 비용은 중국 운영비에 잡히지 않는다
 *   ⑤ 최종 영업마진 = 주문마진 − 중국 운영비
 *   ⑥ CNY 정산 주문은 KRW로 환산해 합산된다
 */
import {
  PrismaClient, Prisma, Route, Entity, Currency, SplitKind, PaymentStatus, InvoiceStatus,
} from '@prisma/client'
import { dashboardData, monthRange } from '../src/lib/dashboard'
import { latestFxRate } from '../src/lib/funds'
import { cnyToKrw } from '../src/lib/money'

const prisma = new PrismaClient()
let pass = 0, fail = 0
const D2 = (v: string | number) => new Prisma.Decimal(v)

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}

/** 검증 전용 달 — 시연·운영 데이터와 섞이지 않도록 과거의 빈 달을 쓴다 */
const YM = '2019-03'
const { from } = monthRange(YM)
const day = (n: number) => new Date(2019, 2, n)

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const by = owner.id
  const stamp = Date.now() % 1e6

  const before = await dashboardData(YM)
  check('검증용 달이 비어 있다', before.totalRevenue.toString(), '0')

  // CNY 정산 주문을 원화로 환산할 때 대시보드가 쓰는 환율.
  // 최근 입금 전표에서 가져오므로 DB 상태에 따라 달라진다 — 고정값으로 기대하면 안 된다.
  const fx = await latestFxRate()
  if (!fx) throw new Error('환산환율을 구할 수 없습니다. 입금 전표가 하나도 없습니다.')
  const cnyKrw = (v: string) => D2(v).mul(fx).toString()
  console.log(`  (CNY 환산환율 ${fx.toString()})`)

  const dtCorp = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } })
  const dtOver = await prisma.dealType.findFirstOrThrow({ where: { code: 'OVERSEAS_DIRECT' } })
  const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accCn = await prisma.account.findFirstOrThrow({ where: { route: Route.OVERSEAS } })
  const catGoods = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'GOODS' } })
  const catSalary = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'SALARY' } })

  const outside = await prisma.partner.create({
    data: { code: `V${stamp}A`, name: `대시검증${stamp}`, nameNormalized: `v${stamp}a`, createdBy: by },
  })
  const inside = await prisma.partner.create({
    data: {
      code: `V${stamp}B`, name: `대시자사${stamp}`, nameNormalized: `v${stamp}b`,
      isInternal: true, createdBy: by,
    },
  })

  const mkOrder = async (partnerId: bigint, route: Route, dealTypeId: bigint, cur: Currency, d: Date) =>
    prisma.order.create({
      data: {
        orderNo: `V${stamp}-${Math.random().toString(36).slice(2, 8)}`,
        partnerId, route, dealTypeId, accountingClass: '상품매출',
        entity: route === Route.OVERSEAS ? Entity.CN : Entity.KR,
        settlementCurrency: cur, orderDate: d, invoiceStatus: InvoiceStatus.NONE, createdBy: by,
      },
    })

  const mkReceipt = async (
    order: { id: bigint; partnerId: bigint; route: Route }, accountId: bigint,
    cur: Currency, amount: string, splits: [SplitKind, string][], d: Date,
  ) => {
    const fx = D2('218')
    const krw = (v: string) => (cur === Currency.KRW ? D2(v) : cnyToKrw(v, fx, 'FLOOR'))
    const r = await prisma.receipt.create({
      data: {
        receiptNo: `V${stamp}R${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id, partnerId: order.partnerId, accountId,
        route: order.route, entity: order.route === Route.OVERSEAS ? Entity.CN : Entity.KR,
        receiptDate: d, currency: cur, amount: D2(amount),
        fxRate: fx, amountKrw: krw(amount), amountCny: cur === Currency.CNY ? D2(amount) : null,
        createdBy: by,
      },
    })
    await prisma.$transaction(async (tx) => {
      for (const [kind, v] of splits) {
        await tx.receiptSplit.create({
          data: {
            receiptId: r.id, splitKind: kind, amount: D2(v),
            amountKrw: krw(v), amountCny: cur === Currency.CNY ? D2(v) : null,
          },
        })
      }
    })
    return r
  }

  const mkExpense = async (categoryId: bigint, cny: string, d: Date, orderId?: bigint) => {
    const fx = D2('218')
    const ex = await prisma.expense.create({
      data: {
        expenseNo: `V${stamp}E${Math.random().toString(36).slice(2, 8)}`,
        entity: Entity.CN, expenseDate: d, categoryId, accountId: accCn.id,
        currency: Currency.CNY, amount: D2(cny), fxRate: fx,
        amountKrw: cnyToKrw(cny, fx, 'FLOOR'), amountCny: D2(cny),
        paymentStatus: PaymentStatus.PAID, paidAt: d, createdBy: by,
      },
    })
    if (orderId) {
      await prisma.expenseAllocation.create({
        data: {
          expenseId: ex.id, orderId, allocAmount: D2(cny),
          allocKrw: cnyToKrw(cny, fx, 'FLOOR'), allocCny: D2(cny),
        },
      })
    }
    return ex
  }

  console.log('\n━━ 1. 법인통장 주문 — 공급가액만 매출로 잡힌다 ━━')
  // 1,100,000 입금 = 공급가액 1,000,000 + 부가세 100,000. 부가세는 매출이 아니다.
  const o1 = await mkOrder(outside.id, Route.BANK_CORP, dtCorp.id, Currency.KRW, day(3))
  await mkReceipt(o1, accCorp.id, Currency.KRW, '1100000',
    [[SplitKind.SALES, '1000000'], [SplitKind.VAT, '100000']], day(3))
  const e1 = await mkExpense(catGoods.id, '3000', day(4), o1.id) // 654,000원

  let d = await dashboardData(YM)
  check('매출인식액', d.totalRevenue.toString(), '1000000')
  check('주문마진', d.orderMargin.toString(), '346000')
  check('부가세는 매출이 아니다', d.totalRevenue.plus(100000).toString(), '1100000')

  console.log('\n━━ 2. CNY 정산 주문 — KRW로 환산해 합산 ━━')
  // 10,000 CNY 입금, 9,000 CNY 원가 → 마진 1,000 CNY = 218,000원
  const o2 = await mkOrder(outside.id, Route.OVERSEAS, dtOver.id, Currency.CNY, day(5))
  await mkReceipt(o2, accCn.id, Currency.CNY, '10000', [[SplitKind.SALES, '10000']], day(5))
  const e2 = await mkExpense(catGoods.id, '9000', day(6), o2.id)

  d = await dashboardData(YM)
  check('CNY 주문 환산 매출',
    d.byRoute.find((r) => r.route === 'OVERSEAS')?.revenue.toString(), cnyKrw('10000'))
  check('합산 매출', d.totalRevenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())
  check('합산 주문마진', d.orderMargin.toString(), D2('346000').plus(cnyKrw('1000')).toString())

  console.log('\n━━ 3. 자사(이우드림) 거래는 거래액에서 빠진다 ━━')
  const o3 = await mkOrder(inside.id, Route.BANK_CORP, dtCorp.id, Currency.KRW, day(7))
  await mkReceipt(o3, accCorp.id, Currency.KRW, '5000000', [[SplitKind.SALES, '5000000']], day(7))

  d = await dashboardData(YM)
  check('자사 거래 제외 후 매출', d.totalRevenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())
  check('자사 거래는 순위에도 없다', d.ranks.some((r) => r.partnerName.includes('대시자사')), 'false')

  console.log('\n━━ 4. 입금 없는 주문 — 마진에서 빼고 미청구로 센다 ━━')
  const o4 = await mkOrder(outside.id, Route.BANK_CORP, dtCorp.id, Currency.KRW, day(8))
  const e4 = await mkExpense(catGoods.id, '5000', day(9), o4.id) // 1,090,000원

  d = await dashboardData(YM)
  check('매출은 그대로', d.totalRevenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())
  check('마진도 그대로 (적자로 안 보인다)',
    d.orderMargin.toString(), D2('346000').plus(cnyKrw('1000')).toString())
  check('미청구 건수', d.unbilledOrderCount, 1)
  check('미청구 비용', d.unbilledOrderCost.toString(), '1090000')

  console.log('\n━━ 5. 중국 운영비 — 주문 귀속분은 빠진다 ━━')
  const e5 = await mkExpense(catSalary.id, '10000', day(10)) // 주문에 붙이지 않는다

  d = await dashboardData(YM)
  check('직원 급여', d.opSalary.toString(), '2180000')
  check('운영비 합계 (귀속분 제외)', d.opTotal.toString(), '2180000')
  check('최종 영업마진 = 주문마진 − 운영비',
    d.operatingMargin.toString(), d.orderMargin.minus(d.opTotal).toString())

  console.log('\n━━ 6. 내부 자금이동 — 거래액에 넣지 않고 따로 표시 ━━')
  const it = await prisma.internalTransfer.create({
    data: {
      transferNo: `V${stamp}T`, transferDate: day(11),
      fromEntity: Entity.KR, toEntity: Entity.CN,
      fromAccountId: accCorp.id, toAccountId: accCn.id,
      usdAmount: D2('10000'), cnyArrivalAmount: D2('67900'),
      fxRateUsdCny: D2('6.79'), purpose: '검증', createdBy: by,
    },
  })

  d = await dashboardData(YM)
  check('내부이동 후에도 매출 불변',
    d.totalRevenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())
  check('내부이동 USD', d.internalTransferUsd.toString(), '10000')
  check('내부이동 CNY', d.internalTransferCny.toString(), '67900')

  console.log('\n━━ 7. 거래처 순위 ━━')
  check('순위 거래처 수', d.ranks.length, 1)
  check('1위 매출', d.ranks[0].revenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())
  check('1위 마진율(%)', d.ranks[0].marginRate?.toString(),
    d.orderMargin.div(d.totalRevenue).mul(100).toDecimalPlaces(2).toString())

  console.log('\n━━ 8. 추세 — 12개월, 마지막이 조회월 ━━')
  check('추세 길이', d.trend.length, 12)
  check('추세 마지막 달', d.trend[11].ym, YM)
  check('추세 마지막 매출', d.trend[11].revenue.toString(), D2('1000000').plus(cnyKrw('10000')).toString())

  console.log('\n━━ 9. 다른 달에는 잡히지 않는다 ━━')
  const other = await dashboardData('2019-04')
  check('다음 달 매출', other.totalRevenue.toString(), '0')
  check('다음 달 운영비', other.opTotal.toString(), '0')

  // 정리
  await prisma.internalTransfer.delete({ where: { id: it.id } })
  await prisma.expenseAllocation.deleteMany({
    where: { expenseId: { in: [e1.id, e2.id, e4.id] } },
  })
  await prisma.expense.deleteMany({ where: { id: { in: [e1.id, e2.id, e4.id, e5.id] } } })
  const orderIds = [o1.id, o2.id, o3.id, o4.id]
  const receipts = await prisma.receipt.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
  await prisma.receiptSplit.deleteMany({ where: { receiptId: { in: receipts.map((r) => r.id) } } })
  await prisma.receipt.deleteMany({ where: { id: { in: receipts.map((r) => r.id) } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.partner.deleteMany({ where: { id: { in: [outside.id, inside.id] } } })

  const after = await dashboardData(YM)
  check('정리 후 원상복구', after.totalRevenue.toString(), '0')

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
