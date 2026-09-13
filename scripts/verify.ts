/**
 * Phase 1 검증 — 설계 문서가 약속한 보호장치가 실제로 동작하는지 확인한다.
 * 실행: npx tsx scripts/verify.ts
 */
import { PrismaClient, Prisma, SplitKind, DepositKind, DepositMovement, Entity, Route, Currency, OrderStatus } from '@prisma/client'
import { splitVat, reverseVatFromTotal, krwToCny, marginRate, costMarkupRate, fmtKrw } from '../src/lib/money'
import { normalizeName, normalizeNameForMerge, splitTrailingNumber, toHalfWidth } from '../src/lib/normalize'

const prisma = new PrismaClient()
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}

async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    fail++; console.log(`  ✗ ${label} — 차단됐어야 하는데 통과함`)
  } catch {
    pass++; console.log(`  ✓ ${label} — 차단됨`)
  }
}

async function main() {
  console.log('\n━━ 1. 부가세 계산 (엑셀 실측 대조) ━━')
  // 법인통장 6행 아르미르샵49: C 3,142,691.27 / M 3,456,960.397
  const corp = splitVat('3142691', 'EXCLUDED', '0.10', 'FLOOR')
  check('법인통장 공급가액', corp.supply, '3142691')
  check('법인통장 부가세', corp.vat, '314269')
  check('법인통장 합계 (엑셀 M열 3,456,960)', corp.total, '3456960')

  // 사이트 수수료 100,000 — 부가세 포함 확정
  const site = splitVat('100000', 'INCLUDED', '0.10', 'FLOOR')
  check('사이트 수수료 공급가액', site.supply, '90909')
  check('사이트 수수료 부가세', site.vat, '9091')
  check('사이트 수수료 합계', site.total, '100000')

  // 통장 금액에서 되돌리기 — 이관에 쓴다
  const rev = reverseVatFromTotal('3456960', '0.10', 'FLOOR')
  check('실입금 → 공급가액 복원', rev.supply, '3142690')  // 절사 1원 차이는 정상
  check('실입금 → 부가세 복원', rev.vat, '314270')

  console.log('\n━━ 2. 환율 환산 (엑셀 수식 대조) ━━')
  // 일반통장 3행: =C3/218.22 → 16,006
  check('3,492,829.32 ÷ 218.22', krwToCny('3492829.32', '218.22'), '16006')
  // 법인통장 6행: =C6/218 → 14,416.015
  check('3,142,691.27 ÷ 218 (엑셀 14,416.015)', krwToCny('3142691.27', '218'), '14416.02')

  console.log('\n━━ 3. 마진율 — 엑셀과 분모가 다르다 ━━')
  // 해외송금 6행 케이에스글로벌: 입금 115,665 / 지출 102,416.51 / 마진 13,248.49
  check('마진율 (매출 대비, 시스템 기본)', marginRate('13248.49', '115665'), '11.45')
  check('원가대비 수익률 (엑셀 % 열)', costMarkupRate('13248.49', '102416.51'), '12.94')
  check('분모 0이면 null', marginRate('1000', '0'), 'null')

  console.log('\n━━ 4. 거래처명 정규화 ━━')
  check('코러스 코리아 ↔ 코러스코리아',
    normalizeName('코러스 코리아') === normalizeName('코러스코리아'), 'true')
  check('커스텀드리다 ↔ 커스텀 드리다',
    normalizeName('커스텀드리다') === normalizeName('커스텀 드리다'), 'true')
  const ar = splitTrailingNumber('아르미르샵133')
  check('아르미르샵133 → 거래처명', ar.baseName, '아르미르샵')
  check('아르미르샵133 → 기존관리번호', ar.externalRef, '아르미르샵133')
  check('49와 133이 같은 그룹',
    normalizeNameForMerge('아르미르샵49') === normalizeNameForMerge('아르미르샵133'), 'true')
  check('전각 기간 변환', toHalfWidth('１２／２８－１／３'), '12/28-1/3')

  console.log('\n━━ 5. 데이터베이스 보호장치 ━━')
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const dealType = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } })
  const account = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })

  const partner = await prisma.partner.create({
    data: { code: `TEST${Date.now() % 100000}`, name: '검증용거래처', nameNormalized: 'verify-temp', createdBy: owner.id },
  })

  // 예치금 원장 append-only
  const dep = await prisma.depositLedger.create({
    data: {
      partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, movement: DepositMovement.IN_RECEIPT,
      amountKrw: new Prisma.Decimal('1000000'), movementDate: new Date(), createdBy: owner.id,
    },
  })
  await expectThrow('예치금 원장 UPDATE 차단', () =>
    prisma.depositLedger.update({ where: { id: dep.id }, data: { amountKrw: new Prisma.Decimal('9999') } }))
  await expectThrow('예치금 원장 DELETE 차단', () =>
    prisma.depositLedger.delete({ where: { id: dep.id } }))
  const after = await prisma.depositLedger.findUniqueOrThrow({ where: { id: dep.id } })
  check('예치금 원장 값 보존', after.amountKrw.toString(), '1000000')

  // ADJUST 는 사유 없이 만들 수 없다
  await expectThrow('사유 없는 ADJUST 차단', () =>
    prisma.depositLedger.create({
      data: {
        partnerId: partner.id, depositKind: DepositKind.GENERAL, movement: DepositMovement.ADJUST,
        amountKrw: new Prisma.Decimal('100'), movementDate: new Date(), createdBy: owner.id,
      },
    }))

  // 입금 분해 합계 불일치 차단
  const order = await prisma.order.create({
    data: {
      orderNo: `T-${Date.now() % 1e9}`, partnerId: partner.id, route: Route.BANK_CORP, dealTypeId: dealType.id,
      accountingClass: '상품매출', entity: Entity.KR, settlementCurrency: Currency.KRW,
      orderDate: new Date(), createdBy: owner.id,
    },
  })
  const receipt = await prisma.receipt.create({
    data: {
      receiptNo: `RCT-${Date.now() % 1e9}`, orderId: order.id, partnerId: partner.id, accountId: account.id,
      route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date(), currency: Currency.KRW,
      amount: new Prisma.Decimal('3456960'), amountKrw: new Prisma.Decimal('3456960'), createdBy: owner.id,
    },
  })

  await expectThrow('분해 합계 ≠ 입금액 차단', () =>
    prisma.$transaction(async (tx) => {
      await tx.receiptSplit.create({
        data: { receiptId: receipt.id, splitKind: SplitKind.SALES, amount: new Prisma.Decimal('3142691'), amountKrw: new Prisma.Decimal('3142691') },
      })
      // VAT 314,269 를 빠뜨린 상태로 커밋 시도
    }))

  // 올바른 분해는 통과한다
  await prisma.$transaction(async (tx) => {
    await tx.receiptSplit.create({
      data: { receiptId: receipt.id, splitKind: SplitKind.SALES, amount: new Prisma.Decimal('3142691'), amountKrw: new Prisma.Decimal('3142691') },
    })
    await tx.receiptSplit.create({
      data: { receiptId: receipt.id, splitKind: SplitKind.VAT, amount: new Prisma.Decimal('314269'), amountKrw: new Prisma.Decimal('314269') },
    })
  })
  const splits = await prisma.receiptSplit.findMany({ where: { receiptId: receipt.id } })
  check('올바른 분해 저장됨 (SALES + VAT)', splits.length, 2)

  // 정산완료 주문은 잠긴다
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.SETTLED } })
  await expectThrow('정산완료 주문에 입금 추가 차단', () =>
    prisma.receipt.create({
      data: {
        receiptNo: `RCL-${Date.now() % 1e9}`, orderId: order.id, partnerId: partner.id, accountId: account.id,
        route: Route.BANK_CORP, entity: Entity.KR, receiptDate: new Date(), currency: Currency.KRW,
        amount: new Prisma.Decimal('1000'), amountKrw: new Prisma.Decimal('1000'), createdBy: owner.id,
      },
    }))

  // 변경이력은 고칠 수 없다
  const log = await prisma.auditLog.create({
    data: { tableName: 'partners', recordId: partner.id, action: 'CREATE', newValue: '원본', changedBy: owner.id },
  })
  await expectThrow('변경이력 UPDATE 차단', () =>
    prisma.auditLog.update({ where: { id: log.id }, data: { newValue: '조작됨' } }))
  const logAfter = await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })
  check('변경이력 값 보존', logAfter.newValue, '원본')

  // 정리
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.OPEN } })
  await prisma.receiptSplit.deleteMany({ where: { receiptId: receipt.id } })
  await prisma.receipt.delete({ where: { id: receipt.id } })
  await prisma.order.delete({ where: { id: order.id } })
  // 예치금 원장·변경이력은 설계상 지울 수 없다. 검증용 거래처는 비활성으로 남긴다.
  await prisma.partner.update({ where: { id: partner.id }, data: { isActive: false, name: '[검증용] 삭제대상' } })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
