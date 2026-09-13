/**
 * Phase 3 검증 — 자금현황·해외송금·내부 자금이동
 */
import {
  PrismaClient, Prisma, Route, Entity, Currency,
  SplitKind, DepositKind, DepositMovement, RemitStatus, PaymentStatus,
} from '@prisma/client'
import { fundsSnapshot, listRemitPending, listReceivables } from '../src/lib/funds'

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

  const dtSite = await prisma.dealType.findFirstOrThrow({ where: { code: 'SITE_AGENCY' } })
  const dtCorp = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } })
  const accSite = await prisma.account.findFirstOrThrow({ where: { route: Route.SITE } })
  const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accCn = await prisma.account.findFirstOrThrow({ where: { route: Route.OVERSEAS } })

  const partner = await prisma.partner.create({
    data: { code: `F${stamp}`, name: `자금검증${stamp}`, nameNormalized: `f${stamp}`, createdBy: by },
  })

  console.log('\n━━ 1. 사이트 입금 → 예치금·부가세가 회사 자금에서 빠지는가 ━━')
  const order = await prisma.order.create({
    data: {
      orderNo: `F1-${stamp}`, partnerId: partner.id, route: Route.SITE, dealTypeId: dtSite.id,
      accountingClass: '중개수수료', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(), createdBy: by,
    },
  })
  const receipt = await prisma.receipt.create({
    data: {
      receiptNo: `F1R-${stamp}`, orderId: order.id, partnerId: partner.id, accountId: accSite.id,
      route: Route.SITE, entity: Entity.KR, receiptDate: new Date(),
      currency: Currency.KRW, amount: D2('1100000'), amountKrw: D2('1100000'), createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    for (const [kind, amt] of [
      [SplitKind.DEPOSIT_GOODS, '1000000'], [SplitKind.FEE, '90909'], [SplitKind.VAT, '9091'],
    ] as const) {
      await tx.receiptSplit.create({
        data: { receiptId: receipt.id, splitKind: kind, amount: D2(amt), amountKrw: D2(amt) },
      })
    }
    await tx.depositLedger.create({
      data: {
        partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.IN_RECEIPT,
        amountKrw: D2('1000000'), movementDate: new Date(),
        refTable: 'receipts', refId: receipt.id, orderId: order.id, createdBy: by,
      },
    })
  })

  let f = await fundsSnapshot()
  const baseDeposits = f.customerDeposits
  const baseVat = f.vatPayable
  check('고객 예치금에 1,000,000 반영', baseDeposits.gte(1000000), 'true')
  check('부가세 예수금에 9,091 반영', baseVat.gte(9091), 'true')
  console.log(`    계좌잔액 ${f.totalBalanceKrw} / 예치금 ${f.customerDeposits} / 부가세 ${f.vatPayable}`)
  console.log(`    실제 사용가능 = ${f.available}`)

  console.log('\n━━ 2. 송금대기 목록 ━━')
  let pendingRows = await listRemitPending()
  const mine = pendingRows.find((r) => r.orderId === order.id.toString())
  check('송금대기 목록에 잡힘', !!mine, 'true')
  check('  대기액', mine?.pending, '1000000')
  check('  상태', mine?.status, 'PENDING')

  console.log('\n━━ 3. 60만원 송금 → 예치금 차감, 일부송금 상태 ━━')
  const remit = await prisma.remittance.create({
    data: {
      remitNo: `F1M-${stamp}`, remitDate: new Date(), fromAccountId: accSite.id, toAccountId: accCn.id,
      krwAmount: D2('600000'), cnyArrivalAmount: D2('3076.92'),
      fxRateKrwCny: D2('600000').div(D2('3076.92')).toDecimalPlaces(6),
      bankFeeKrw: D2('15000'), status: RemitStatus.DRAFT, createdBy: by,
    },
  })
  await prisma.$transaction(async (tx) => {
    await tx.remittanceAllocation.create({
      data: {
        remittanceId: remit.id, partnerId: partner.id, orderId: order.id,
        allocKrw: D2('600000'), allocCny: D2('3076.92'),
      },
    })
    await tx.depositLedger.create({
      data: {
        partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.USE_REMIT,
        amountKrw: D2('-600000'), movementDate: new Date(),
        refTable: 'remittances', refId: remit.id, orderId: order.id, createdBy: by,
      },
    })
    await tx.remittance.update({ where: { id: remit.id }, data: { status: RemitStatus.SENT } })
  })

  pendingRows = await listRemitPending()
  const after = pendingRows.find((r) => r.orderId === order.id.toString())
  check('송금완료액', after?.remitted, '600000')
  check('송금대기 잔액', after?.pending, '400000')
  check('상태', after?.status, 'PARTIAL')

  f = await fundsSnapshot()
  check('예치금이 60만원 줄었는가', baseDeposits.minus(f.customerDeposits), '600000')

  console.log('\n━━ 4. 배분 합계 ≠ 송금액이면 확정되지 않는가 ━━')
  const badRemit = await prisma.remittance.create({
    data: {
      remitNo: `F2M-${stamp}`, remitDate: new Date(), fromAccountId: accSite.id, toAccountId: accCn.id,
      krwAmount: D2('500000'), status: RemitStatus.DRAFT, createdBy: by,
    },
  })
  await prisma.remittanceAllocation.create({
    data: { remittanceId: badRemit.id, partnerId: partner.id, orderId: order.id, allocKrw: D2('300000') },
  })
  let blocked = false
  try {
    // 배분 30만 / 송금 50만 인 상태로 확정 시도
    await prisma.$transaction(async (tx) => {
      await tx.remittance.update({ where: { id: badRemit.id }, data: { status: RemitStatus.SENT } })
      await tx.remittanceAllocation.update({
        where: { id: (await tx.remittanceAllocation.findFirstOrThrow({ where: { remittanceId: badRemit.id } })).id },
        data: { allocKrw: D2('300000') },
      })
    })
  } catch { blocked = true }
  check('불일치 배분 확정 차단', blocked, 'true')

  console.log('\n━━ 5. 내부 자금이동은 매출에 안 들어가는가 ━━')
  const t = await prisma.internalTransfer.create({
    data: {
      transferNo: `F1T-${stamp}`, transferDate: new Date(), fromEntity: Entity.KR, toEntity: Entity.CN,
      fromAccountId: accCorp.id, toAccountId: accCn.id,
      usdAmount: D2('99000'), cnyArrivalAmount: D2('672190'),
      fxRateUsdCny: D2('672190').div(D2('99000')).toDecimalPlaces(6),
      purpose: '운영자금', createdBy: by,
    },
  })
  check('USD/CNY 환율 (엑셀 6.7898)', t.fxRateUsdCny?.toDecimalPlaces(4), '6.7898')
  const orderCount = await prisma.order.count({ where: { partnerId: partner.id } })
  check('자금이동은 주문을 만들지 않는다', orderCount, 1)

  console.log('\n━━ 6. 미수금 집계 ━━')
  const o2 = await prisma.order.create({
    data: {
      orderNo: `F2-${stamp}`, partnerId: partner.id, route: Route.BANK_CORP, dealTypeId: dtCorp.id,
      accountingClass: '상품매출', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(Date.now() - 100 * 86400000), createdBy: by,
    },
  })
  const cat = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'GOODS' } })
  const ex = await prisma.expense.create({
    data: {
      expenseNo: `F2E-${stamp}`, entity: Entity.CN, expenseDate: new Date(), categoryId: cat.id,
      currency: Currency.KRW, amount: D2('800000'), amountKrw: D2('800000'),
      paymentStatus: PaymentStatus.PAID, createdBy: by,
    },
  })
  await prisma.expenseAllocation.create({
    data: { expenseId: ex.id, orderId: o2.id, allocAmount: D2('800000'), allocKrw: D2('800000') },
  })

  const recv = await listReceivables()
  const mineR = recv.find((r) => r.orderId === o2.id.toString())
  check('입금 없이 지출만 → 미수금', mineR?.amountKrw, '800000')
  check('  경과일 계산', (mineR?.daysOld ?? 0) >= 99, 'true')

  // 정리
  await prisma.expenseAllocation.deleteMany({ where: { orderId: { in: [order.id, o2.id] } } })
  await prisma.expense.deleteMany({ where: { expenseNo: { contains: `${stamp}` } } })
  // 확정된 송금의 배분은 지울 수 없다(합계 트리거). 작성중으로 되돌린 뒤 정리한다.
  await prisma.remittance.updateMany({
    where: { id: { in: [remit.id, badRemit.id] } }, data: { status: RemitStatus.DRAFT },
  })
  await prisma.remittanceAllocation.deleteMany({ where: { remittanceId: { in: [remit.id, badRemit.id] } } })
  await prisma.remittance.deleteMany({ where: { id: { in: [remit.id, badRemit.id] } } })
  await prisma.internalTransfer.delete({ where: { id: t.id } })
  await prisma.receiptSplit.deleteMany({ where: { receiptId: receipt.id } })
  await prisma.receipt.delete({ where: { id: receipt.id } })
  await prisma.order.update({ where: { id: order.id }, data: { isVoid: true, status: 'CANCELLED', voidReason: '검증 정리' } })
  await prisma.order.delete({ where: { id: o2.id } })
  await prisma.partner.update({
    where: { id: partner.id },
    data: { isActive: false, name: '[검증용] 삭제금지 — 예치금원장 참조' },
  })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
