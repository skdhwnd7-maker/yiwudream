/**
 * 시연용 데이터.
 *
 * 엑셀에서 확인한 실제 패턴을 축소해 넣는다 — 네 루트, 부가세, 예치금,
 * 미수금, 중국 운영비. 대시보드가 무엇을 보여주는지 확인하는 용도다.
 * 운영 DB 에는 넣지 말 것.
 */
import {
  PrismaClient, Prisma, Route, Entity, Currency, SplitKind,
  DepositKind, DepositMovement, PaymentStatus, InvoiceStatus, OrderStatus,
} from '@prisma/client'
import { normalizeName } from '../src/lib/normalize'
import { cnyToKrw, krwToCny } from '../src/lib/money'
import { draftInvoice } from '../src/lib/invoice-calc'

const prisma = new PrismaClient()
const D2 = (v: string | number) => new Prisma.Decimal(v)

async function docNo(prefix: string, year: number): Promise<string> {
  const r = await prisma.$queryRaw<{ next_doc_no: string }[]>`
    SELECT next_doc_no(${prefix}::text, ${year}::int) AS next_doc_no`
  return r[0].next_doc_no
}

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const by = owner.id

  const dt = Object.fromEntries(
    (await prisma.dealType.findMany()).map((d) => [d.code, d]),
  )
  const acc = Object.fromEntries(
    (await prisma.account.findMany()).map((a) => [a.route, a]),
  )
  const cat = Object.fromEntries(
    (await prisma.expenseCategory.findMany()).map((c) => [c.code, c]),
  )

  // 거래처 — 엑셀에 실제로 있던 이름
  const names: [string, Route, string][] = [
    ['케이에스글로벌', Route.OVERSEAS, 'OVERSEAS_DIRECT'],
    ['네일의품격', Route.BANK_CORP, 'CORP_FULL'],
    ['아르미르샵', Route.BANK_CORP, 'CORP_NOBILL'],
    ['에이스', Route.BANK_GEN, 'GEN_DEPOSIT'],
    ['더놀자', Route.BANK_GEN, 'GEN_DEPOSIT'],
    ['도도하라', Route.SITE, 'SITE_AGENCY'],
  ]
  const partners: Record<string, bigint> = {}
  for (const [name, route, dealCode] of names) {
    const exists = await prisma.partner.findFirst({ where: { nameNormalized: normalizeName(name) } })
    if (exists) { partners[name] = exists.id; continue }
    const count = await prisma.partner.count()
    const p = await prisma.partner.create({
      data: {
        code: `P${String(count + 1).padStart(4, '0')}`,
        name, nameNormalized: normalizeName(name),
        defaultRoute: route, defaultDealTypeId: dt[dealCode].id,
        taxInvoiceDefault: dealCode === 'CORP_FULL' || dealCode === 'SITE_AGENCY',
        defaultMarkupRate: name === '에이스' ? D2('8.89') : null,
        createdBy: by,
      },
    })
    partners[name] = p.id
  }

  const now = new Date()
  const Y = now.getFullYear()
  const thisMonth = (day: number) => new Date(Y, now.getMonth(), day)
  const lastMonth = (day: number) => new Date(Y, now.getMonth() - 1, day)
  const FX = D2('218')

  let made = 0

  async function makeOrder(opts: {
    partner: string; route: Route; dealCode: string; date: Date
    amount: string; depositGoods?: string; vatCharged: boolean
    costs: [string, string][]   // [categoryCode, cny]
    externalRef?: string; title?: string; settle?: boolean
  }) {
    const dealType = dt[opts.dealCode]
    const account = acc[opts.route]
    const cur = opts.route === Route.OVERSEAS ? Currency.CNY : Currency.KRW
    const entity = opts.route === Route.OVERSEAS ? Entity.CN : Entity.KR
    const issue = dealType.invoiceDefault

    const orderNo = await docNo('ORDER', opts.date.getFullYear())
    const order = await prisma.order.create({
      data: {
        orderNo, externalRef: opts.externalRef ?? null, partnerId: partners[opts.partner],
        route: opts.route, dealTypeId: dealType.id, accountingClass: dealType.accountingClass,
        entity, settlementCurrency: cur, title: opts.title ?? null, orderDate: opts.date,
        invoiceStatus: issue ? InvoiceStatus.PENDING : InvoiceStatus.NONE, createdBy: by,
      },
    })

    const amount = D2(opts.amount)
    const dep = D2(opts.depositGoods ?? '0')
    const remainder = amount.minus(dep)

    const toKrw = (v: Prisma.Decimal) => (cur === Currency.KRW ? v : cnyToKrw(v, FX, 'FLOOR'))
    const toCny = (v: Prisma.Decimal) => (cur === Currency.CNY ? v : krwToCny(v, FX))

    const receiptNo = await docNo('RC', opts.date.getFullYear())
    const receipt = await prisma.receipt.create({
      data: {
        receiptNo, orderId: order.id, partnerId: partners[opts.partner], accountId: account.id,
        route: opts.route, entity, receiptDate: opts.date, currency: cur, amount,
        fxRate: cur === Currency.KRW ? FX : null,
        amountKrw: toKrw(amount), amountCny: toCny(amount), createdBy: by,
      },
    })

    const splits: [SplitKind, Prisma.Decimal][] = []
    if (dep.gt(0)) splits.push([SplitKind.DEPOSIT_GOODS, dep])
    if (remainder.gt(0)) {
      const kind = dep.gt(0) ? SplitKind.FEE : SplitKind.SALES
      if (opts.vatCharged) {
        const supply = remainder.div(D2('1.1')).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR)
        splits.push([kind, supply])
        splits.push([SplitKind.VAT, remainder.minus(supply)])
      } else {
        splits.push([kind, remainder])
      }
    }
    // 분해 합계 = 입금액 검사는 트랜잭션 커밋 시점에 걸리는 지연 제약이므로
    // 여러 행을 한 트랜잭션 안에서 넣어야 한다.
    await prisma.$transaction(async (tx) => {
      for (const [k, v] of splits) {
        await tx.receiptSplit.create({
          data: { receiptId: receipt.id, splitKind: k, amount: v, amountKrw: toKrw(v), amountCny: toCny(v) },
        })
      }
    })
    if (dep.gt(0)) {
      await prisma.depositLedger.create({
        data: {
          partnerId: partners[opts.partner], depositKind: DepositKind.GOODS_FUND,
          movement: DepositMovement.IN_RECEIPT, amountKrw: toKrw(dep), movementDate: opts.date,
          refTable: 'receipts', refId: receipt.id, orderId: order.id, createdBy: by,
        },
      })
    }

    for (const [code, cny] of opts.costs) {
      const expenseNo = await docNo('EX', opts.date.getFullYear())
      const ex = await prisma.expense.create({
        data: {
          expenseNo, entity: Entity.CN, expenseDate: opts.date, categoryId: cat[code].id,
          accountId: acc[Route.OVERSEAS].id,
          currency: Currency.CNY, amount: D2(cny), fxRate: FX,
          amountKrw: cnyToKrw(cny, FX, 'FLOOR'), amountCny: D2(cny),
          paymentStatus: PaymentStatus.PAID, paidAt: opts.date, createdBy: by,
        },
      })
      await prisma.expenseAllocation.create({
        data: {
          expenseId: ex.id, orderId: order.id, allocAmount: D2(cny),
          allocKrw: cnyToKrw(cny, FX, 'FLOOR'), allocCny: D2(cny),
        },
      })
    }

    if (opts.settle) {
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.SETTLED, settledAt: new Date() } })
    }
    made++
    return order
  }

  // 해외송금 — CNY 정산
  await makeOrder({
    partner: '케이에스글로벌', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: lastMonth(6), amount: '115665', vatCharged: false,
    costs: [['GOODS', '102416.51']], title: '5월 1차 의류',
  })
  await makeOrder({
    partner: '케이에스글로벌', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: thisMonth(3), amount: '128073', vatCharged: false,
    costs: [['GOODS', '118866.48'], ['LABOR_CN', '1115.60']],
  })
  await makeOrder({
    partner: '케이에스글로벌', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: thisMonth(12), amount: '103240', vatCharged: false,
    costs: [['GOODS', '93880.20'], ['LABOR_CN', '1240'], ['INSPECT', '380']],
  })
  await makeOrder({
    partner: '케이에스글로벌', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: thisMonth(18), amount: '87530', vatCharged: false,
    costs: [['GOODS', '79120.40'], ['LABOR_CN', '960']],
  })
  await makeOrder({
    partner: '더놀자', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: thisMonth(22), amount: '121480', vatCharged: false,
    costs: [['GOODS', '110640.80'], ['LABOR_CN', '1480']],
  })
  await makeOrder({
    partner: '케이에스글로벌', route: Route.OVERSEAS, dealCode: 'OVERSEAS_DIRECT',
    date: thisMonth(26), amount: '94660', vatCharged: false,
    costs: [['GOODS', '86120.50'], ['LABOR_CN', '1020']],
  })

  // 법인통장 — 부가세 포함 입금, 계산서 발행
  await makeOrder({
    partner: '네일의품격', route: Route.BANK_CORP, dealCode: 'CORP_FULL',
    date: lastMonth(12), amount: '3456960', vatCharged: true,
    costs: [['GOODS', '13109.65']], externalRef: '네일의품격53',
  })
  await makeOrder({
    partner: '네일의품격', route: Route.BANK_CORP, dealCode: 'CORP_FULL',
    date: thisMonth(5), amount: '1368041', vatCharged: true,
    costs: [['GOODS', '5661.33'], ['CUSTOMS', '340']],
  })
  await makeOrder({
    partner: '네일의품격', route: Route.BANK_CORP, dealCode: 'CORP_FULL',
    date: thisMonth(15), amount: '4290000', vatCharged: true,
    costs: [['GOODS', '16120'], ['CUSTOMS', '420']],
  })

  // 법인통장 미발행 — 부가세는 받았으나 계산서 없음
  await makeOrder({
    partner: '아르미르샵', route: Route.BANK_CORP, dealCode: 'CORP_NOBILL',
    date: lastMonth(4), amount: '3456960', vatCharged: true,
    costs: [['GOODS', '13109.65']], externalRef: '아르미르샵49',
  })
  await makeOrder({
    partner: '아르미르샵', route: Route.BANK_CORP, dealCode: 'CORP_NOBILL',
    date: thisMonth(8), amount: '614454', vatCharged: true,
    costs: [['GOODS', '2502']], externalRef: '아르미르샵133',
  })

  // 일반통장 — 부가세 무관
  await makeOrder({
    partner: '더놀자', route: Route.BANK_GEN, dealCode: 'GEN_DEPOSIT',
    date: thisMonth(2), amount: '5023869', vatCharged: false,
    costs: [['GOODS', '21341']],
  })

  // 대행통관 용역 — 상품대금은 고객이 직접 결제, 우리는 통관·물류 수수료만 받는다
  await makeOrder({
    partner: '네일의품격', route: Route.BANK_CORP, dealCode: 'CORP_CUSTOMS',
    date: thisMonth(11), amount: '1782000', vatCharged: true,
    costs: [['CUSTOMS', '3200'], ['SHIPPING', '1450']],
    title: '대행통관 9월분',
  })

  // 에이스 — 입금 없이 지출만 (미수금)
  const aceOrder = await prisma.order.create({
    data: {
      orderNo: await docNo('ORDER', Y), partnerId: partners['에이스'], route: Route.BANK_GEN,
      dealTypeId: dt['GEN_DEPOSIT'].id, accountingClass: '용역매출', entity: Entity.KR,
      settlementCurrency: Currency.KRW, orderDate: lastMonth(8),
      title: '미청구 지출 모음', createdBy: by,
    },
  })
  for (const cny of ['50850', '18000', '12338']) {
    const expenseNo = await docNo('EX', Y)
    const ex = await prisma.expense.create({
      data: {
        expenseNo, entity: Entity.CN, expenseDate: lastMonth(10), categoryId: cat['GOODS'].id,
        currency: Currency.CNY, amount: D2(cny), fxRate: FX,
        amountKrw: cnyToKrw(cny, FX, 'FLOOR'), amountCny: D2(cny),
        paymentStatus: PaymentStatus.PAID, paidAt: lastMonth(10), createdBy: by,
      },
    })
    await prisma.expenseAllocation.create({
      data: {
        expenseId: ex.id, orderId: aceOrder.id, allocAmount: D2(cny),
        allocKrw: cnyToKrw(cny, FX, 'FLOOR'), allocCny: D2(cny),
      },
    })
  }
  made++

  // 사이트 결제 — 예치금 + 수수료 + 부가세
  await makeOrder({
    partner: '도도하라', route: Route.SITE, dealCode: 'SITE_AGENCY',
    date: thisMonth(1), amount: '1100000', depositGoods: '1000000', vatCharged: true,
    costs: [['PACKING', '68.8']],
  })
  await makeOrder({
    partner: '도도하라', route: Route.SITE, dealCode: 'SITE_AGENCY',
    date: thisMonth(9), amount: '2200000', depositGoods: '2000000', vatCharged: true,
    costs: [['PACKING', '120']],
  })

  // 중국 운영비 — 주문 미귀속
  for (const [code, cny, desc] of [
    ['SALARY', '11150', '중국 직원 급여'],
    ['INSURANCE', '4664', '사회보험 社保'],
    ['TEMP_LABOR', '14408', '창고 작업'],
    ['OFFICE', '10000', '사무실 월세'],
    ['OFFICE', '420', '전기·수도'],
  ] as const) {
    const expenseNo = await docNo('EX', Y)
    await prisma.expense.create({
      data: {
        expenseNo, entity: Entity.CN, expenseDate: thisMonth(5), categoryId: cat[code].id,
        accountId: acc[Route.OVERSEAS].id,
        currency: Currency.CNY, amount: D2(cny), fxRate: FX,
        amountKrw: cnyToKrw(cny, FX, 'FLOOR'), amountCny: D2(cny), workDesc: desc,
        paymentStatus: PaymentStatus.PAID, paidAt: thisMonth(5), createdBy: by,
      },
    })
  }

  // 내부 자금이동
  await prisma.internalTransfer.create({
    data: {
      transferNo: await docNo('IT', Y), transferDate: thisMonth(4),
      fromEntity: Entity.KR, toEntity: Entity.CN,
      fromAccountId: acc[Route.BANK_CORP].id, toAccountId: acc[Route.OVERSEAS].id,
      usdAmount: D2('22000'), cnyArrivalAmount: D2('149380'),
      fxRateUsdCny: D2('149380').div(D2('22000')).toDecimalPlaces(6),
      purpose: '운영자금', createdBy: by,
    },
  })

  // 세금계산서 — 발행 대상인 거래유형만. 한 건은 미발행으로 남겨 '발행 예정'을 보여준다.
  const billable = await prisma.order.findMany({
    where: { dealType: { invoiceBase: { not: 'NONE' } } },
    include: { dealType: true },
    orderBy: { orderDate: 'asc' },
  })
  let invMade = 0
  for (const o of billable) {
    if (o.dealType.code === 'CORP_NOBILL') continue // 대표님 확인: 부가세는 받았지만 계산서는 안 끊은 건
    const draft = await draftInvoice([o.id])
    if (!draft || draft.manual || draft.targetAmount.lte(0)) continue
    const issueNow = invMade % 4 !== 3 // 네 건 중 한 건은 미발행으로 남긴다
    const inv = await prisma.invoice.create({
      data: {
        invoiceNo: await docNo('TX', o.orderDate.getFullYear()),
        partnerId: o.partnerId, dealTypeId: o.dealTypeId,
        accountingClass: o.accountingClass,
        totalReceiptAmount: draft.totalReceiptAmount,
        targetAmount: draft.targetAmount, targetAmountSource: 'AUTO',
        vatMode: draft.vatMode,
        supplyAmount: draft.supplyAmount, vatAmount: draft.vatAmount, totalAmount: draft.totalAmount,
        issueStatus: issueNow ? InvoiceStatus.ISSUED : InvoiceStatus.PENDING,
        issueDate: issueNow ? o.orderDate : null,
        createdBy: by,
      },
    })
    await prisma.invoiceOrder.create({
      data: { invoiceId: inv.id, orderId: o.id, amount: draft.targetAmount },
    })
    await prisma.order.update({
      where: { id: o.id },
      data: { invoiceStatus: issueNow ? InvoiceStatus.ISSUED : InvoiceStatus.PENDING },
    })
    invMade++
  }

  console.log(`시연 데이터 생성 완료 — 주문 ${made}건, 거래처 ${names.length}곳, 세금계산서 ${invMade}건`)
  console.log('운영 DB 에서는 npm run db:purge-test 로 정리하세요.')
}

main().finally(() => prisma.$disconnect())
