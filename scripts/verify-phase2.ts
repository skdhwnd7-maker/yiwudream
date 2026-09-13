/**
 * Phase 2 검증 — 엑셀 실제 거래를 그대로 넣고 계산이 맞는지 본다.
 * 실행: npx tsx scripts/verify-phase2.ts
 */
import {
  PrismaClient, Prisma, Route, Entity, Currency, OrderStatus,
  SplitKind, DepositKind, DepositMovement, ReceiptSource, PaymentStatus, FxSource,
} from '@prisma/client'
import { summarizeOrder, computeSplits } from '../src/lib/order-calc'
import { krwToCny, cnyToKrw, roundKrw, round2 } from '../src/lib/money'

const prisma = new PrismaClient()
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}
async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try { await fn(); fail++; console.log(`  ✗ ${label} — 차단됐어야 함`) }
  catch { pass++; console.log(`  ✓ ${label} — 차단됨`) }
}

const D2 = (v: string | number) => new Prisma.Decimal(v)

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const by = owner.id
  const stamp = Date.now() % 1e6

  const [dtCorpFull, dtSite, dtOverseas, dtGen] = await Promise.all([
    prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } }),
    prisma.dealType.findFirstOrThrow({ where: { code: 'SITE_AGENCY' } }),
    prisma.dealType.findFirstOrThrow({ where: { code: 'OVERSEAS_DIRECT' } }),
    prisma.dealType.findFirstOrThrow({ where: { code: 'GEN_DEPOSIT' } }),
  ])
  const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accSite = await prisma.account.findFirstOrThrow({ where: { route: Route.SITE } })
  const accCn = await prisma.account.findFirstOrThrow({ where: { route: Route.OVERSEAS } })
  const catGoods = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'GOODS' } })
  const catLabor = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'LABOR_CN' } })
  const catPacking = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'PACKING' } })

  const partner = await prisma.partner.create({
    data: { code: `V${stamp}`, name: `검증거래처${stamp}`, nameNormalized: `v${stamp}`, createdBy: by },
  })

  // ── 1. 입금 분해 로직 ──────────────────────────────────────
  console.log('\n━━ 1. 입금 분해 (엑셀 실측 대조) ━━')

  // 법인통장 6행 아르미르샵49: 통장 3,456,960 = 공급가액 3,142,691 + 부가세 314,269
  const corpSplits = computeSplits({
    amount: '3456960', vatMode: 'EXCLUDED', vatRate: '0.10', rounding: 'FLOOR', vatCharged: true,
  })
  check('법인통장 분해 항목 수', corpSplits.length, 2)
  check('  공급가액(SALES)', corpSplits.find((s) => s.kind === 'SALES')?.amount, '3142690')
  check('  부가세(VAT)', corpSplits.find((s) => s.kind === 'VAT')?.amount, '314270')

  // 사이트 1,100,000 = 예치금 1,000,000 + 수수료 90,909 + 부가세 9,091
  const siteSplits = computeSplits({
    amount: '1100000', vatMode: 'INCLUDED', vatRate: '0.10', rounding: 'FLOOR',
    depositGoods: '1000000', vatCharged: true,
  })
  check('사이트 분해 항목 수', siteSplits.length, 3)
  check('  상품구매 예치금', siteSplits.find((s) => s.kind === 'DEPOSIT_GOODS')?.amount, '1000000')
  check('  수수료 공급가액', siteSplits.find((s) => s.kind === 'FEE')?.amount, '90909')
  check('  부가세', siteSplits.find((s) => s.kind === 'VAT')?.amount, '9091')

  // 일반통장 — 부가세 무관
  const genSplits = computeSplits({
    amount: '3492829', vatMode: 'NONE', vatRate: '0.10', rounding: 'FLOOR', vatCharged: false,
  })
  check('일반통장 분해 항목 수 (VAT 없음)', genSplits.length, 1)
  check('  전액 SALES', genSplits[0].kind, 'SALES')

  // ── 2. 법인통장 주문 — 엑셀 6행 재현 ──────────────────────
  console.log('\n━━ 2. 법인통장 주문 (엑셀 아르미르샵49 재현) ━━')
  const o1 = await prisma.order.create({
    data: {
      orderNo: `T1-${stamp}`, externalRef: '아르미르샵49', partnerId: partner.id,
      route: Route.BANK_CORP, dealTypeId: dtCorpFull.id, accountingClass: '상품매출',
      entity: Entity.KR, settlementCurrency: Currency.KRW, orderDate: new Date('2026-05-04'),
      createdBy: by,
    },
  })
  const fx1 = D2('218')
  const r1 = await prisma.receipt.create({
    data: {
      receiptNo: `T1R-${stamp}`, orderId: o1.id, partnerId: partner.id, accountId: accCorp.id,
      route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date('2026-05-04'),
      currency: Currency.KRW, amount: D2('3456960'), fxRate: fx1, fxRateSource: FxSource.MANUAL,
      amountKrw: D2('3456960'), amountCny: krwToCny('3456960', fx1), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    for (const s of corpSplits) {
      await tx.receiptSplit.create({
        data: {
          receiptId: r1.id, splitKind: s.kind as SplitKind, amount: s.amount,
          amountKrw: s.amount, amountCny: krwToCny(s.amount, fx1),
        },
      })
    }
  })
  // 지출 CNY 13,109.65
  const e1 = await prisma.expense.create({
    data: {
      expenseNo: `T1E-${stamp}`, entity: Entity.CN, expenseDate: new Date('2026-05-06'),
      categoryId: catGoods.id, currency: Currency.CNY, amount: D2('13109.65'),
      fxRate: fx1, amountKrw: cnyToKrw('13109.65', fx1), amountCny: D2('13109.65'),
      paymentStatus: PaymentStatus.PAID, createdBy: by,
    },
  })
  await prisma.expenseAllocation.create({
    data: {
      expenseId: e1.id, orderId: o1.id, allocAmount: D2('13109.65'),
      allocKrw: cnyToKrw('13109.65', fx1), allocCny: D2('13109.65'),
    },
  })

  const s1 = await summarizeOrder(o1.id)
  check('총 입금액 (통장 금액)', s1.grossIn, '3456960')
  check('매출인식액 (공급가액)', s1.revenue, '3142690')
  check('부가세 (국세청 돈)', s1.vatIn, '314270')
  check('총비용 KRW', s1.totalCost, cnyToKrw('13109.65', fx1).toString())
  console.log(`    ⓘ 엑셀: 공급가액 3,142,691 / 부가세 314,269 / 합계 3,456,960`)
  console.log(`    ⓘ 절사 방향 차이로 공급가액 1원 낮게, 부가세 1원 높게 잡힌다`)

  // ── 3. 사이트 주문 — 예치금·부가세·NET 마진 ────────────────
  console.log('\n━━ 3. 사이트 결제 주문 (NET 인식) ━━')
  const o2 = await prisma.order.create({
    data: {
      orderNo: `T2-${stamp}`, partnerId: partner.id, route: Route.SITE, dealTypeId: dtSite.id,
      accountingClass: '중개수수료', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date('2026-05-01'), createdBy: by,
    },
  })
  const r2 = await prisma.receipt.create({
    data: {
      receiptNo: `T2R-${stamp}`, orderId: o2.id, partnerId: partner.id, accountId: accSite.id,
      route: Route.SITE, entity: Entity.KR, receiptDate: new Date('2026-05-01'),
      currency: Currency.KRW, amount: D2('1100000'), amountKrw: D2('1100000'), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    for (const s of siteSplits) {
      await tx.receiptSplit.create({
        data: { receiptId: r2.id, splitKind: s.kind as SplitKind, amount: s.amount, amountKrw: s.amount },
      })
    }
    await tx.depositLedger.create({
      data: {
        partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.IN_RECEIPT,
        amountKrw: D2('1000000'), movementDate: new Date('2026-05-01'),
        refTable: 'receipts', refId: r2.id, orderId: o2.id, createdBy: by,
      },
    })
  })
  // 포장비 15,000 (회사 부담)
  const e2 = await prisma.expense.create({
    data: {
      expenseNo: `T2E-${stamp}`, entity: Entity.KR, expenseDate: new Date('2026-05-02'),
      categoryId: catPacking.id, currency: Currency.KRW, amount: D2('15000'),
      amountKrw: D2('15000'), paymentStatus: PaymentStatus.PAID, createdBy: by,
    },
  })
  await prisma.expenseAllocation.create({
    data: { expenseId: e2.id, orderId: o2.id, allocAmount: D2('15000'), allocKrw: D2('15000') },
  })

  const s2 = await summarizeOrder(o2.id)
  check('총 입금액', s2.grossIn, '1100000')
  check('상품구매 예치금 (고객 돈)', s2.depositGoodsIn, '1000000')
  check('수수료 공급가액 (회사 돈)', s2.feeIn, '90909')
  check('부가세 (국세청 돈)', s2.vatIn, '9091')
  check('매출인식액 = 수수료 공급가액', s2.revenue, '90909')
  check('최종 마진 (90,909 − 15,000)', s2.margin, '75909')
  check('마진율', s2.marginRatePct, '83.5')
  check('송금대기금', s2.remitPending, '1000000')
  check('송금 상태', s2.remitStatus, 'PENDING')

  // ── 4. 해외송금 주문 — CNY 정산, 지출 여러 건 ──────────────
  console.log('\n━━ 4. 해외송금 주문 (엑셀 코러스코리아 재현) ━━')
  const o3 = await prisma.order.create({
    data: {
      orderNo: `T3-${stamp}`, partnerId: partner.id, route: Route.OVERSEAS, dealTypeId: dtOverseas.id,
      accountingClass: '해외매출', entity: Entity.CN, settlementCurrency: Currency.CNY,
      orderDate: new Date('2026-05-29'), usdInvoiceAmount: D2('5918.88'), createdBy: by,
    },
  })
  const r3 = await prisma.receipt.create({
    data: {
      receiptNo: `T3R-${stamp}`, orderId: o3.id, partnerId: partner.id, accountId: accCn.id,
      route: Route.OVERSEAS, entity: Entity.CN, receiptDate: new Date('2026-05-29'),
      currency: Currency.CNY, amount: D2('39733'), amountKrw: cnyToKrw('39733', 218),
      amountCny: D2('39733'), usdAmount: D2('5918.88'), createdBy: by,
    },
  })
  await prisma.receiptSplit.create({
    data: {
      receiptId: r3.id, splitKind: SplitKind.SALES, amount: D2('39733'),
      amountKrw: cnyToKrw('39733', 218), amountCny: D2('39733'),
    },
  })
  // 엑셀의 5개 지출 행을 한 주문에 묶는다
  const overseasCosts: [string, bigint][] = [
    ['8384', catGoods.id], ['3726', catGoods.id], ['2066.90', catGoods.id],
    ['11540', catGoods.id], ['36007.90', catGoods.id], ['1809', catLabor.id],
  ]
  for (const [amt, catId] of overseasCosts) {
    const ex = await prisma.expense.create({
      data: {
        expenseNo: `T3E${amt.replace('.', '')}-${stamp}`.slice(0, 20), entity: Entity.CN,
        expenseDate: new Date('2026-05-29'), categoryId: catId, currency: Currency.CNY,
        amount: D2(amt), fxRate: D2('218'), amountKrw: cnyToKrw(amt, 218), amountCny: D2(amt),
        paymentStatus: PaymentStatus.PAID, createdBy: by,
      },
    })
    await prisma.expenseAllocation.create({
      data: { expenseId: ex.id, orderId: o3.id, allocAmount: D2(amt), allocKrw: cnyToKrw(amt, 218), allocCny: D2(amt) },
    })
  }

  const s3 = await summarizeOrder(o3.id)
  check('CNY 도착금액', s3.grossIn, '39733')
  check('상품비 합계', s3.costs.goods, '61724.8')
  check('인건비', s3.costs.labor, '1809')
  check('총비용', s3.totalCost, '63533.8')
  check('최종 마진 (적자)', s3.margin, '-23800.8')
  check('미수금 (받을 돈)', s3.receivable, '23800.8')
  console.log('    ⓘ 엑셀에서는 −100% 행 4개 + 5% 행 1개로 흩어져 있던 거래다')

  // ── 5. 정산완료 잠금 ───────────────────────────────────────
  console.log('\n━━ 5. 정산완료 잠금 ━━')
  await prisma.order.update({
    where: { id: o1.id },
    data: { status: OrderStatus.SETTLED, settledMargin: s1.margin, settledAt: new Date() },
  })
  await expectThrow('정산완료 주문에 입금 추가', () =>
    prisma.receipt.create({
      data: {
        receiptNo: `T1X-${stamp}`, orderId: o1.id, partnerId: partner.id, accountId: accCorp.id,
        route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date(),
        currency: Currency.KRW, amount: D2('1000'), amountKrw: D2('1000'), createdBy: by,
      },
    }))
  await expectThrow('정산완료 주문에 지출 배분', () =>
    prisma.expenseAllocation.create({
      data: { expenseId: e2.id, orderId: o1.id, allocAmount: D2('1'), allocKrw: D2('1') },
    }))

  // ── 6. 예치금 원장 잔액 ────────────────────────────────────
  console.log('\n━━ 6. 예치금 원장 ━━')
  const bal = await prisma.depositLedger.aggregate({
    where: { partnerId: partner.id },
    _sum: { amountKrw: true },
  })
  check('거래처 예치금 잔액', bal._sum.amountKrw, '1000000')

  // 송금하면 줄어든다
  await prisma.depositLedger.create({
    data: {
      partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.USE_REMIT,
      amountKrw: D2('-600000'), movementDate: new Date(), reason: '중국 송금 집행', createdBy: by,
    },
  })
  const bal2 = await prisma.depositLedger.aggregate({
    where: { partnerId: partner.id }, _sum: { amountKrw: true },
  })
  check('송금 60만원 후 잔액', bal2._sum.amountKrw, '400000')

  // ── 정리 ──────────────────────────────────────────────────
  await prisma.order.update({ where: { id: o1.id }, data: { status: OrderStatus.OPEN } })
  for (const o of [o1, o2, o3]) {
    await prisma.expenseAllocation.deleteMany({ where: { orderId: o.id } })
    await prisma.receiptSplit.deleteMany({ where: { receipt: { orderId: o.id } } })
    await prisma.receipt.deleteMany({ where: { orderId: o.id } })
  }
  await prisma.expense.deleteMany({ where: { expenseNo: { contains: `${stamp}` } } })
  // 예치금 원장이 참조하는 주문은 설계상 지울 수 없다. 취소 처리로 남긴다.
  for (const o of [o1, o2, o3]) {
    const referenced = await prisma.depositLedger.count({ where: { orderId: o.id } })
    if (referenced > 0) {
      await prisma.order.update({
        where: { id: o.id },
        data: { isVoid: true, status: OrderStatus.CANCELLED, voidReason: '검증 스크립트 정리' },
      })
    } else {
      await prisma.order.delete({ where: { id: o.id } })
    }
  }
  await prisma.partner.update({
    where: { id: partner.id },
    data: { isActive: false, name: '[검증용] 삭제금지 — 예치금원장 참조' },
  })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
