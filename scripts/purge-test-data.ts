/**
 * 검증 스크립트가 남긴 데이터를 지운다.
 * 예치금 원장은 설계상 지울 수 없으므로 상쇄행을 넣어 잔액을 0으로 만든다.
 */
import { PrismaClient, Prisma, DepositMovement } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const owner = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const testPartners = await prisma.partner.findMany({
    where: { OR: [{ code: { startsWith: 'V' } }, { code: { startsWith: 'F' } }, { code: { startsWith: 'TEST' } }] },
    select: { id: true, name: true, code: true },
  })
  if (testPartners.length === 0) { console.log('정리할 검증 데이터가 없습니다.'); return }
  const ids = testPartners.map((p) => p.id)

  // 전표 제거
  await prisma.remittance.updateMany({ where: { allocs: { some: { partnerId: { in: ids } } } }, data: { status: 'DRAFT' } })
  await prisma.remittanceAllocation.deleteMany({ where: { partnerId: { in: ids } } })
  await prisma.remittance.deleteMany({ where: { allocs: { none: {} }, remitNo: { not: { startsWith: 'RM-' } } } })
  await prisma.expenseAllocation.deleteMany({ where: { order: { partnerId: { in: ids } } } })
  await prisma.receiptSplit.deleteMany({ where: { receipt: { partnerId: { in: ids } } } })
  await prisma.receipt.deleteMany({ where: { partnerId: { in: ids } } })
  await prisma.order.updateMany({ where: { partnerId: { in: ids } }, data: { status: 'OPEN' } })

  // 예치금 잔액을 상쇄행으로 0으로 만든다
  const balances = await prisma.depositLedger.groupBy({
    by: ['partnerId', 'depositKind'], where: { partnerId: { in: ids } }, _sum: { amountKrw: true },
  })
  for (const b of balances) {
    const bal = new Prisma.Decimal(b._sum.amountKrw ?? 0)
    if (bal.isZero()) continue
    await prisma.depositLedger.create({
      data: {
        partnerId: b.partnerId, depositKind: b.depositKind, movement: DepositMovement.ADJUST,
        amountKrw: bal.negated(), movementDate: new Date(),
        reason: '검증 데이터 정리 — 잔액 0 처리', createdBy: owner.id,
      },
    })
  }

  await prisma.order.deleteMany({ where: { partnerId: { in: ids }, depositMoves: { none: {} } } })
  await prisma.partner.updateMany({
    where: { id: { in: ids } },
    data: { isActive: false, memo: '검증 스크립트가 만든 계정. 원장 참조로 삭제 불가.' },
  })

  console.log(`검증 거래처 ${testPartners.length}건 정리 완료 (예치금 잔액 0, 비활성 처리)`)
}
main().finally(() => prisma.$disconnect())
