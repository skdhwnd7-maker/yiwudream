/**
 * Phase 4 검증 — 세금계산서·급여·운영비
 */
import {
  PrismaClient, Prisma, Route, Entity, Currency, SplitKind, InvoiceStatus, PaymentStatus,
} from '@prisma/client'
import { draftInvoice, listUnbilledVat, recompute } from '../src/lib/invoice-calc'

const prisma = new PrismaClient()
let pass = 0, fail = 0
const D2 = (v: string | number) => new Prisma.Decimal(v)

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const by = owner.id
  const stamp = Date.now() % 1e6

  const dtCorp = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } })
  const dtNobill = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_NOBILL' } })
  const dtSite = await prisma.dealType.findFirstOrThrow({ where: { code: 'SITE_AGENCY' } })
  const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accSite = await prisma.account.findFirstOrThrow({ where: { route: Route.SITE } })

  const partner = await prisma.partner.create({
    data: { code: `T${stamp}`, name: `세무검증${stamp}`, nameNormalized: `t${stamp}`, createdBy: by },
  })

  console.log('\n━━ 1. 법인통장 전액발행 — 대상금액 = 총입금액 ━━')
  const o1 = await prisma.order.create({
    data: {
      orderNo: `X1-${stamp}`, partnerId: partner.id, route: Route.BANK_CORP, dealTypeId: dtCorp.id,
      accountingClass: '상품매출', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(), invoiceStatus: InvoiceStatus.PENDING, createdBy: by,
    },
  })
  const r1 = await prisma.receipt.create({
    data: {
      receiptNo: `X1R-${stamp}`, orderId: o1.id, partnerId: partner.id, accountId: accCorp.id,
      route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date(),
      currency: Currency.KRW, amount: D2('3456960'), amountKrw: D2('3456960'), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    await tx.receiptSplit.create({
      data: { receiptId: r1.id, splitKind: SplitKind.SALES, amount: D2('3142690'), amountKrw: D2('3142690') },
    })
    await tx.receiptSplit.create({
      data: { receiptId: r1.id, splitKind: SplitKind.VAT, amount: D2('314270'), amountKrw: D2('314270') },
    })
  })

  const d1 = await draftInvoice([o1.id])
  check('대상금액 기준', d1?.basisLabel, '주문 총입금액')
  check('대상금액 = 공급가액 (부가세 제외)', d1?.targetAmount, '3142690')
  check('공급가액', d1?.supplyAmount, '3142690')
  check('부가세 = 실제 받은 금액', d1?.vatAmount, '314270')
  check('합계 = 통장에 찍힌 금액', d1?.totalAmount, '3456960')
  check('  총입금 참고값', d1?.totalReceiptAmount, '3456960')
  console.log('    ⓘ 통장 금액에 이미 부가세가 있으므로 다시 붙이지 않는다')

  console.log('\n━━ 2. 사이트 — 대상금액 = 수수료 공급가액만 ━━')
  const o2 = await prisma.order.create({
    data: {
      orderNo: `X2-${stamp}`, partnerId: partner.id, route: Route.SITE, dealTypeId: dtSite.id,
      accountingClass: '중개수수료', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(), invoiceStatus: InvoiceStatus.PENDING, createdBy: by,
    },
  })
  const r2 = await prisma.receipt.create({
    data: {
      receiptNo: `X2R-${stamp}`, orderId: o2.id, partnerId: partner.id, accountId: accSite.id,
      route: Route.SITE, entity: Entity.KR, receiptDate: new Date(),
      currency: Currency.KRW, amount: D2('1100000'), amountKrw: D2('1100000'), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    for (const [k, a] of [
      [SplitKind.DEPOSIT_GOODS, '1000000'], [SplitKind.FEE, '90909'], [SplitKind.VAT, '9091'],
    ] as const) {
      await tx.receiptSplit.create({
        data: { receiptId: r2.id, splitKind: k, amount: D2(a), amountKrw: D2(a) },
      })
    }
  })

  const d2 = await draftInvoice([o2.id])
  check('대상금액 기준', d2?.basisLabel, '구매대행 수수료')
  check('대상금액 (수수료 공급가액)', d2?.targetAmount, '90909')
  check('  총입금은 참고값', d2?.totalReceiptAmount, '1100000')
  check('공급가액', d2?.supplyAmount, '90909')
  check('부가세 = 실제 받은 금액', d2?.vatAmount, '9091')
  check('합계', d2?.totalAmount, '100000')
  console.log('    ⓘ 수수료 100,000 = 공급가액 90,909 + 부가세 9,091 (실제 수취액 그대로)')

  console.log('\n━━ 3. 미발행·부가세 수취 목록 ━━')
  const o3 = await prisma.order.create({
    data: {
      orderNo: `X3-${stamp}`, partnerId: partner.id, route: Route.BANK_CORP, dealTypeId: dtNobill.id,
      accountingClass: '상품매출', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(Date.now() - 120 * 86400000),
      invoiceStatus: InvoiceStatus.NONE, createdBy: by,
    },
  })
  const r3 = await prisma.receipt.create({
    data: {
      receiptNo: `X3R-${stamp}`, orderId: o3.id, partnerId: partner.id, accountId: accCorp.id,
      route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date(),
      currency: Currency.KRW, amount: D2('1100000'), amountKrw: D2('1100000'), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    await tx.receiptSplit.create({
      data: { receiptId: r3.id, splitKind: SplitKind.SALES, amount: D2('1000000'), amountKrw: D2('1000000') },
    })
    await tx.receiptSplit.create({
      data: { receiptId: r3.id, splitKind: SplitKind.VAT, amount: D2('100000'), amountKrw: D2('100000') },
    })
  })

  const unbilled = await listUnbilledVat()
  const mine = unbilled.find((u) => u.orderId === o3.id.toString())
  check('미발행 목록에 잡힘', !!mine, 'true')
  check('  받은 부가세', mine?.vatKrw, '100000')
  check('  공급가액', mine?.supplyKrw, '1000000')
  check('  경과일', (mine?.daysOld ?? 0) >= 119, 'true')

  console.log('\n━━ 4. 부가세 재계산 (담당자가 금액 수정) ━━')
  const re = recompute('3142690', 'EXCLUDED', '0.10', 'FLOOR')
  check('공급가액 3,142,690 → 부가세', re.vat, '314269')
  check('  합계', re.total, '3456959')

  console.log('\n━━ 5. 급여 — 실지급 기준 집계 ━━')
  const emp = await prisma.employee.create({
    data: { empCode: `E${stamp}`, name: '검증직원', nameCn: '沈丹凤', baseSalary: D2('1650') },
  })
  const catSalary = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'SALARY' } })
  const exSalary = await prisma.expense.create({
    data: {
      expenseNo: `XS-${stamp}`, entity: Entity.CN, expenseDate: new Date(), categoryId: catSalary.id,
      currency: Currency.CNY, amount: D2('6000'), fxRate: D2('218'),
      amountKrw: D2('6000').mul(218).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR),
      amountCny: D2('6000'), paymentStatus: PaymentStatus.PAID, paidAt: new Date(), createdBy: by,
    },
  })
  const pay = await prisma.payroll.create({
    data: {
      yearMonth: '2026-01', employeeId: emp.id,
      baseSalary: D2('1650'), actualPaid: D2('6000'),
      insuranceCompany: D2('1416'), currency: Currency.CNY,
      expenseId: exSalary.id, createdBy: by,
    },
  })
  check('기본급', pay.baseSalary, '1650')
  check('실지급 (집계 기준)', pay.actualPaid, '6000')
  check('  차액', pay.actualPaid.minus(pay.baseSalary), '4350')
  console.log('    ⓘ 엑셀 刘彦红 사례. 합계를 기본급으로 내면 4,350 CNY 가 빠진다')

  // 귀속월 중복 방지
  let dup = false
  try {
    await prisma.payroll.create({
      data: {
        yearMonth: '2026-01', employeeId: emp.id, baseSalary: D2('1'), actualPaid: D2('1'),
        currency: Currency.CNY, createdBy: by,
      },
    })
  } catch { dup = true }
  check('같은 월 중복 입력 차단', dup, 'true')

  console.log('\n━━ 6. 임시공 귀속 여부에 따른 분류 ━━')
  const catTemp = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'TEMP_LABOR' } })
  const exAttributed = await prisma.expense.create({
    data: {
      expenseNo: `XT1-${stamp}`, entity: Entity.CN, expenseDate: new Date(), categoryId: catTemp.id,
      currency: Currency.CNY, amount: D2('10035'), fxRate: D2('218'),
      amountKrw: D2('10035').mul(218).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR),
      amountCny: D2('10035'), workDesc: '검품·포장',
      paymentStatus: PaymentStatus.PAID, createdBy: by,
    },
  })
  await prisma.expenseAllocation.create({
    data: {
      expenseId: exAttributed.id, orderId: o1.id, allocAmount: D2('10035'),
      allocKrw: D2('10035').mul(218).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR), allocCny: D2('10035'),
    },
  })
  const exOperating = await prisma.expense.create({
    data: {
      expenseNo: `XT2-${stamp}`, entity: Entity.CN, expenseDate: new Date(), categoryId: catTemp.id,
      currency: Currency.CNY, amount: D2('14408'), fxRate: D2('218'),
      amountKrw: D2('14408').mul(218).toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR),
      amountCny: D2('14408'), workDesc: '창고 작업',
      paymentStatus: PaymentStatus.PAID, createdBy: by,
    },
  })

  const attributed = await prisma.expense.count({
    where: { categoryId: catTemp.id, allocs: { some: {} }, id: { in: [exAttributed.id, exOperating.id] } },
  })
  const operating = await prisma.expense.count({
    where: { categoryId: catTemp.id, allocs: { none: {} }, id: { in: [exAttributed.id, exOperating.id] } },
  })
  check('주문 귀속분', attributed, 1)
  check('운영비 처리분', operating, 1)

  // 정리
  await prisma.expenseAllocation.deleteMany({ where: { expenseId: { in: [exAttributed.id] } } })
  await prisma.expense.deleteMany({ where: { expenseNo: { contains: `${stamp}` } } })
  await prisma.payroll.delete({ where: { id: pay.id } })
  await prisma.employee.delete({ where: { id: emp.id } })
  await prisma.receiptSplit.deleteMany({ where: { receiptId: { in: [r1.id, r2.id, r3.id] } } })
  await prisma.receipt.deleteMany({ where: { id: { in: [r1.id, r2.id, r3.id] } } })
  await prisma.order.deleteMany({ where: { id: { in: [o1.id, o2.id, o3.id] } } })
  await prisma.partner.delete({ where: { id: partner.id } })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
