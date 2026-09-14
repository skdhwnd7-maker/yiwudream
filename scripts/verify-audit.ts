/**
 * 운영 전 감사 — 회귀 검증
 *
 * 여기 있는 것은 전부 실제로 발견한 버그다. 고치기 전에는 실패하고,
 * 고친 뒤에는 통과한다. 서버 액션(createRemittance 등)을 화면에서 부르는 것과
 * 똑같이 호출해 확인한다.
 */
import { useTestDatabase } from '../src/lib/test-guard'
useTestDatabase()

import {
  PrismaClient, Prisma, Route, Entity, Currency, SplitKind, RemitStatus,
  DepositKind, DepositMovement, PaymentStatus, InvoiceStatus, Role,
} from '@prisma/client'
import { runAsUser } from '../src/lib/request-context'
import type { SessionUser } from '../src/lib/auth'

const prisma = new PrismaClient()
const D = (v: string | number) => new Prisma.Decimal(v)
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}
function checkLike(label: string, actual: string | undefined, needle: string) {
  if (actual && actual.includes(needle)) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label} — "${needle}" 가 없음. 실제: ${actual ?? '(없음)'}`) }
}

/** 서버 액션은 FormData 를 받는다. 화면에서 보내는 것과 같은 모양으로 만든다 */
function fd(obj: Record<string, string | string[]>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x)
    else f.append(k, v)
  }
  return f
}

/**
 * 검증 뒤처리용. 예치금 원장은 지울 수 없게 막혀 있는데(그게 맞다),
 * 검증이 만든 자국까지 남길 수는 없어 잠깐만 풀고 지운다.
 */
async function withLedgerTriggersOff<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('ALTER TABLE deposit_ledger DISABLE TRIGGER USER')
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE deposit_ledger ENABLE TRIGGER USER')
  }
}

/** redirect() 는 예외로 동작한다. 성공 신호로 받아 준다 */
async function call<T>(fn: () => Promise<T>): Promise<T | { redirected: true }> {
  try {
    return await fn()
  } catch (e) {
    const digest = (e as { digest?: string }).digest
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) return { redirected: true }
    throw e
  }
}

const stamp = Date.now() % 1e6
let owner: SessionUser

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.OWNER } })
  owner = { id: admin.id.toString(), loginId: admin.loginId, name: admin.name, role: admin.role }

  const { createRemittance, sendRemittance, markArrived, voidRemittance } =
    await import('../src/app/(app)/remittances/actions')

  const accKr = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accCn = await prisma.account.findFirstOrThrow({ where: { route: Route.OVERSEAS } })
  const accSite = await prisma.account.findFirstOrThrow({ where: { route: Route.SITE } })
  const dtSite = await prisma.dealType.findFirstOrThrow({ where: { code: 'SITE_AGENCY' } })

  const partner = await prisma.partner.create({
    data: { code: `A${stamp}`, name: `감사검증${stamp}`, nameNormalized: `a${stamp}`, createdBy: admin.id },
  })

  /** 예치금 있는 주문 하나를 만든다 */
  async function makeDepositOrder(goods: string, no: string) {
    const order = await prisma.order.create({
      data: {
        orderNo: `AD${stamp}-${no}`, partnerId: partner.id, route: Route.SITE,
        dealTypeId: dtSite.id, accountingClass: '용역매출', entity: Entity.KR,
        settlementCurrency: Currency.KRW, orderDate: new Date(),
        invoiceStatus: InvoiceStatus.NONE, createdBy: admin.id,
      },
    })
    const receipt = await prisma.receipt.create({
      data: {
        receiptNo: `ADR${stamp}-${no}`, orderId: order.id, partnerId: partner.id,
        accountId: accSite.id, route: Route.SITE, entity: Entity.KR, receiptDate: new Date(),
        currency: Currency.KRW, amount: D(goods), amountKrw: D(goods), createdBy: admin.id,
      },
    })
    await prisma.$transaction(async (tx) => {
      await tx.receiptSplit.create({
        data: {
          receiptId: receipt.id, splitKind: SplitKind.DEPOSIT_GOODS,
          amount: D(goods), amountKrw: D(goods),
        },
      })
      await tx.depositLedger.create({
        data: {
          partnerId: partner.id, depositKind: DepositKind.GOODS_FUND,
          movement: DepositMovement.IN_RECEIPT, amountKrw: D(goods),
          movementDate: new Date(), refTable: 'receipts', refId: receipt.id,
          orderId: order.id, createdBy: admin.id,
        },
      })
    })
    return order
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 1. 송금수수료 이중차감 ━━')
  // 예치금 1,000,000 / 송금 1,000,000 / 수수료 15,000
  // 통장에서 빠지는 돈은 1,015,000 이어야 한다. 1,030,000 이면 수수료를 두 번 뺀 것이다.
  {
    const { accountBalances } = await import('../src/lib/funds')
    const order = await makeDepositOrder('1000000', 'f1')
    const before = (await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance

    const r = await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '1000000', cnyArrivalAmount: '5000', bankFeeKrw: '15000',
      status: 'SENT',
      allocOrderId: [order.id.toString()], allocKrw: ['1000000'],
    }))))
    check('송금 등록 성공', 'redirected' in (r as object) ? 'ok' : JSON.stringify(r), 'ok')

    const after = (await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance
    check('통장에서 빠진 금액 (송금 1,000,000 + 수수료 15,000)',
      before.minus(after).toString(), '1015000')

    const feeExpenses = await prisma.expense.count({
      where: { category: { code: 'BANK_FEE' }, isVoid: false, memo: { contains: '송금수수료' } },
    })
    check('수수료 지출 전표는 그대로 남는다 (손익 집계용)', feeExpenses >= 1, true)
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 2. 예치금 초과 송금 금지 ━━')
  {
    const order = await makeDepositOrder('1000000', 'd1')

    // 600,000 송금 — 통과해야 한다
    const ok = await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '600000', cnyArrivalAmount: '3000', status: 'SENT',
      allocOrderId: [order.id.toString()], allocKrw: ['600000'],
    }))))
    check('예치금 안에서는 송금된다', 'redirected' in (ok as object) ? 'ok' : JSON.stringify(ok), 'ok')

    // 남은 400,000 인데 500,000 송금 — 반드시 거절
    const bad = await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '500000', cnyArrivalAmount: '2500', status: 'SENT',
      allocOrderId: [order.id.toString()], allocKrw: ['500000'],
    })))) as { error?: string }
    checkLike('남은 예치금 400,000 에 500,000 송금은 거절된다', bad.error, '모자랍니다')
    checkLike('얼마가 모자란지 알려 준다', bad.error, '100,000원 부족')

    const bal = await prisma.depositLedger.aggregate({
      where: { partnerId: partner.id, depositKind: DepositKind.GOODS_FUND, orderId: order.id },
      _sum: { amountKrw: true },
    })
    check('거절된 뒤 예치금은 그대로', bal._sum.amountKrw?.toString(), '400000')
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 3. DB 수준 방어 — 애플리케이션을 건너뛰어도 막힌다 ━━')
  {
    const order = await makeDepositOrder('100000', 'd2')
    let blocked = false
    let message = ''
    try {
      await prisma.depositLedger.create({
        data: {
          partnerId: partner.id, depositKind: DepositKind.GOODS_FUND,
          movement: DepositMovement.USE_REMIT, amountKrw: D('-100001'),
          movementDate: new Date(), orderId: order.id, createdBy: admin.id,
        },
      })
    } catch (e) {
      blocked = true
      message = e instanceof Error ? e.message : String(e)
    }
    check('원장에 직접 넣어도 마이너스는 막힌다', blocked, true)
    checkLike('무엇이 문제인지 한국어로 알려 준다', message, '예치금')
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 4. 송금 상태 처리 ━━')
  {
    const order = await makeDepositOrder('1000000', 's1')
    const beforeLedger = await prisma.depositLedger.count({ where: { orderId: order.id } })

    // DRAFT 로 등록 — 예치금과 통장에 영향이 없어야 한다
    const { accountBalances } = await import('../src/lib/funds')
    const balBefore = (await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance

    await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '700000', cnyArrivalAmount: '3500', bankFeeKrw: '10000', status: 'DRAFT',
      allocOrderId: [order.id.toString()], allocKrw: ['700000'],
    }))))
    const draft = await prisma.remittance.findFirstOrThrow({
      where: { allocs: { some: { orderId: order.id } } }, orderBy: { id: 'desc' },
    })
    check('작성중으로 저장된다', draft.status, 'DRAFT')
    check('작성중은 예치금을 건드리지 않는다',
      await prisma.depositLedger.count({ where: { orderId: order.id } }), beforeLedger)
    check('작성중은 통장 잔액에 영향이 없다',
      (await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance.toString(),
      balBefore.toString())

    // 도착확인은 보내기 전에는 불가
    const early = await runAsUser(owner, () => call(() => markArrived({}, fd({
      remittanceId: draft.id.toString(), cnyArrivalAmount: '3500',
    })))) as { error?: string }
    checkLike('작성중에서 바로 도착확인은 막힌다', early.error, '바꿀 수 없습니다')

    // 보냄 처리 — 이제 예치금과 통장에서 빠진다
    const sent = await runAsUser(owner, () => call(() => sendRemittance({}, fd({
      remittanceId: draft.id.toString(),
    })))) as { ok?: string; error?: string }
    check('송금완료 처리', sent.error ?? 'ok', 'ok')
    check('송금완료 시 예치금이 빠진다',
      (await prisma.depositLedger.aggregate({
        where: { orderId: order.id }, _sum: { amountKrw: true },
      }))._sum.amountKrw?.toString(), '300000')
    check('송금완료 시 통장에서 빠진다 (송금 700,000 + 수수료 10,000)',
      balBefore.minus((await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance).toString(),
      '710000')

    // 취소로 새로 만들 수 없다
    const cancelled = await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '100000', status: 'CANCELLED',
      allocOrderId: [order.id.toString()], allocKrw: ['100000'],
    })))) as { error?: string }
    checkLike('취소 상태로는 새로 만들 수 없다', cancelled.error, '새로 만들 수 없습니다')

    // 취소 → 예치금·수수료 복원
    const voided = await runAsUser(owner, () => call(() => voidRemittance({}, fd({
      remittanceId: draft.id.toString(), reason: '검증',
    })))) as { ok?: string; error?: string }
    check('취소 처리', voided.error ?? 'ok', 'ok')
    check('취소하면 예치금이 되돌아온다',
      (await prisma.depositLedger.aggregate({
        where: { orderId: order.id }, _sum: { amountKrw: true },
      }))._sum.amountKrw?.toString(), '1000000')
    check('취소하면 통장도 원래대로',
      (await accountBalances()).find((a) => a.id === accKr.id.toString())!.balance.toString(),
      balBefore.toString())
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 5. 작성중 송금 취소는 예치금을 만들어내지 않는다 ━━')
  {
    const order = await makeDepositOrder('500000', 's2')
    await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '500000', status: 'DRAFT',
      allocOrderId: [order.id.toString()], allocKrw: ['500000'],
    }))))
    const draft = await prisma.remittance.findFirstOrThrow({
      where: { allocs: { some: { orderId: order.id } } }, orderBy: { id: 'desc' },
    })
    await runAsUser(owner, () => call(() => voidRemittance({}, fd({
      remittanceId: draft.id.toString(), reason: '검증',
    }))))
    check('예치금은 처음 그대로 (부풀지 않는다)',
      (await prisma.depositLedger.aggregate({
        where: { orderId: order.id }, _sum: { amountKrw: true },
      }))._sum.amountKrw?.toString(), '500000')
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 6. 도착금액이 바뀌면 주문별 CNY 를 다시 나눈다 ━━')
  {
    const o1 = await makeDepositOrder('600000', 'a1')
    const o2 = await makeDepositOrder('400000', 'a2')

    await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: new Date().toISOString().slice(0, 10),
      fromAccountId: accKr.id.toString(), toAccountId: accCn.id.toString(),
      krwAmount: '1000000', cnyArrivalAmount: '5000', status: 'SENT',
      allocOrderId: [o1.id.toString(), o2.id.toString()],
      allocKrw: ['600000', '400000'],
    }))))
    const remit = await prisma.remittance.findFirstOrThrow({
      where: { allocs: { some: { orderId: o1.id } } }, orderBy: { id: 'desc' },
      include: { allocs: true },
    })
    check('등록 시 CNY 배분 합 = 도착금액',
      remit.allocs.reduce((s, a) => s.plus(a.allocCny ?? 0), D(0)).toString(), '5000')

    // 실제로는 4,987.35 가 도착했다
    await runAsUser(owner, () => call(() => markArrived({}, fd({
      remittanceId: remit.id.toString(), cnyArrivalAmount: '4987.35',
    }))))
    const after = await prisma.remittanceAllocation.findMany({
      where: { remittanceId: remit.id }, orderBy: { id: 'asc' },
    })
    check('도착금액이 바뀌면 배분도 바뀐다',
      after.reduce((s, a) => s.plus(a.allocCny ?? 0), D(0)).toString(), '4987.35')
    check('6:4 비율대로 나뉜다 — 큰 쪽',
      after.find((a) => a.orderId === o1.id)?.allocCny?.toString(), '2992.41')
    check('6:4 비율대로 나뉜다 — 작은 쪽',
      after.find((a) => a.orderId === o2.id)?.allocCny?.toString(), '1994.94')
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 7. 초과송금을 숨기지 않는다 ━━')
  {
    const order = await makeDepositOrder('100000', 'x1')
    // 과거에 쌓인 이상 데이터를 흉내낸다.
    // 지금은 트리거가 막으므로 잠깐 꺼서 넣는다 — 「막힌다」 는 것 자체가 3번에서 확인된 사실이다.
    await withLedgerTriggersOff(async () => {
      await prisma.$executeRaw`
        INSERT INTO deposit_ledger
          (partner_id, deposit_kind, movement, amount_krw, movement_date, order_id, created_by, reason)
        VALUES (${partner.id}, 'GOODS_FUND', 'USE_REMIT', ${-150000}, CURRENT_DATE,
                ${order.id}, ${admin.id}, '검증용 이상 상태')`
    })
    const { findDepositAnomalies } = await import('../src/lib/deposit')
    const anomalies = await findDepositAnomalies()
    const mine = anomalies.filter((a) => a.partnerId === partner.id.toString())
    check('마이너스 예치금이 탐지된다', mine.length > 0, true)
    checkLike('어느 주문인지 알려 준다',
      mine.find((a) => a.orderId === order.id.toString())?.balance.toString(), '-50000')

    // 되돌린다
    await withLedgerTriggersOff(async () => {
      await prisma.$executeRaw`
        DELETE FROM deposit_ledger WHERE reason = '검증용 이상 상태' AND partner_id = ${partner.id}`
    })

    // 주문 요약에서도 초과송금이 보여야 한다 (0으로 잘라 숨기지 않는다)
    const { summarizeOrder } = await import('../src/lib/order-calc')
    const o2 = await makeDepositOrder('100000', 'x2')
    const r2 = await prisma.remittance.create({
      data: {
        remitNo: `ADX${stamp}`, remitDate: new Date(), fromAccountId: accKr.id,
        toAccountId: accCn.id, krwAmount: D('180000'), status: RemitStatus.SENT,
        createdBy: admin.id,
      },
    })
    await prisma.remittanceAllocation.create({
      data: {
        remittanceId: r2.id, partnerId: partner.id, orderId: o2.id, allocKrw: D('180000'),
      },
    })
    const sum2 = await summarizeOrder(o2.id)
    check('초과송금이 요약에 드러난다', sum2.remitExcess.toString(), '80000')
    check('상태가 초과송금으로 표시된다', sum2.remitStatus, 'OVER')
    check('대기액은 0으로 표시하되 초과분은 따로 남는다', sum2.remitPending.toString(), '0')
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 8. 급여 재입력 시 사회보험 전표 중복 ━━')
  {
    const { savePayroll } = await import('../src/app/(app)/payroll/actions')
    const catIns = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'INSURANCE' } })
    const emp = await prisma.employee.create({
      data: { empCode: `AE${stamp}`, name: `감사직원${stamp}`, nameCn: `감사直員${stamp}` },
    })
    const YM = '2019-07'
    const insCount = async () => prisma.expense.count({
      where: { categoryId: catIns.id, isVoid: false, memo: { contains: `${YM} 사회보험(회사부담) · ${emp.name}` } },
    })
    const insSum = async () => (await prisma.expense.aggregate({
      where: { categoryId: catIns.id, isVoid: false, memo: { contains: `${YM} 사회보험(회사부담) · ${emp.name}` } },
      _sum: { amount: true },
    }))._sum.amount?.toString() ?? '0'

    const save = (insurance: string, reason?: string) => runAsUser(owner, () => call(() => savePayroll({}, fd({
      yearMonth: YM, employeeId: emp.id.toString(),
      baseSalary: '9000', actualPaid: '9000',
      insuranceCompany: insurance, fxRate: '218',
      paidAt: `${YM}-05`, ...(reason ? { reason } : {}),
    }))))

    const first = await save('1416') as { error?: string }
    check('첫 저장', first.error ?? 'ok', 'ok')
    check('사회보험 전표 1건', await insCount(), 1)

    // 같은 달을 다시 저장 — 옛 사회보험 전표가 살아남으면 두 건이 된다
    const second = await save('1500', '금액 정정') as { error?: string }
    check('재입력 저장', second.error ?? 'ok', 'ok')
    check('재입력 뒤에도 사회보험 전표는 1건', await insCount(), 1)
    check('금액은 새 값만 잡힌다', await insSum(), '1500')

    // 사회보험을 0으로 지우면 전표도 남지 않아야 한다
    const third = await save('0', '사회보험 없음') as { error?: string }
    check('사회보험 0으로 수정', third.error ?? 'ok', 'ok')
    check('사회보험 전표가 사라진다', await insCount(), 0)

    const payroll = await prisma.payroll.findFirstOrThrow({
      where: { employeeId: emp.id, yearMonth: YM },
    })
    check('급여가 급여 전표를 붙들고 있다', payroll.expenseId !== null, true)
    check('사회보험이 없으면 연결도 비어 있다', payroll.insuranceExpenseId, 'null')

    // 변경이력에 취소가 남았는가
    const voids = await prisma.auditLog.count({
      where: { tableName: 'expenses', action: 'VOID', newValue: { contains: '급여 재입력' } },
    })
    check('취소가 변경이력에 남는다', voids >= 2, true)

    await prisma.payroll.deleteMany({ where: { employeeId: emp.id } })
    await prisma.expense.deleteMany({ where: { vendorName: emp.nameCn ?? emp.name } })
    await prisma.employee.delete({ where: { id: emp.id } })
  }

  // ════════════════════════════════════════════════════════════
  console.log('\n━━ 9. 세금계산서 안전장치 ━━')
  {
    const { createInvoice, cancelInvoice } = await import('../src/app/(app)/invoices/actions')
    const dtFull = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_FULL' } })
    const dtNobill = await prisma.dealType.findFirstOrThrow({ where: { code: 'CORP_NOBILL' } })
    const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })

    const partner2 = await prisma.partner.create({
      data: { code: `B${stamp}`, name: `계산서검증${stamp}`, nameNormalized: `b${stamp}`, createdBy: admin.id },
    })

    async function corpOrder(supply: string, vat: string, dealTypeId: bigint, no: string, pid = partner2.id) {
      const order = await prisma.order.create({
        data: {
          orderNo: `AI${stamp}-${no}`, partnerId: pid, route: Route.BANK_CORP,
          dealTypeId, accountingClass: '상품매출', entity: Entity.KR,
          settlementCurrency: Currency.KRW, orderDate: new Date(),
          invoiceStatus: InvoiceStatus.NONE, createdBy: admin.id,
        },
      })
      const total = D(supply).plus(D(vat))
      const receipt = await prisma.receipt.create({
        data: {
          receiptNo: `AIR${stamp}-${no}`, orderId: order.id, partnerId: pid,
          accountId: accCorp.id, route: Route.BANK_CORP, entity: Entity.KR,
          receiptDate: new Date(), currency: Currency.KRW, amount: total,
          amountKrw: total, createdBy: admin.id,
        },
      })
      await prisma.$transaction(async (tx) => {
        await tx.receiptSplit.create({
          data: { receiptId: receipt.id, splitKind: SplitKind.SALES, amount: D(supply), amountKrw: D(supply) },
        })
        await tx.receiptSplit.create({
          data: { receiptId: receipt.id, splitKind: SplitKind.VAT, amount: D(vat), amountKrw: D(vat) },
        })
      })
      return order
    }

    // 세무 규칙이 다르면 한 장으로 못 묶는다
    const oFull = await corpOrder('1000000', '100000', dtFull.id, 'c1')
    const oNobill = await corpOrder('500000', '50000', dtNobill.id, 'c2')
    const mixed = await runAsUser(owner, () => call(() => createInvoice({}, fd({
      orderId: [oFull.id.toString(), oNobill.id.toString()], issueNow: 'on',
    })))) as { error?: string }
    checkLike('세무 규칙이 다르면 묶이지 않는다', mixed.error, '한 장으로 묶을 수 없습니다')
    checkLike('무엇이 다른지 알려 준다', mixed.error, '발행 기준')

    // 거래처가 다르면 못 묶는다
    const partner3 = await prisma.partner.create({
      data: { code: `C${stamp}`, name: `다른거래처${stamp}`, nameNormalized: `c${stamp}`, createdBy: admin.id },
    })
    const oOther = await corpOrder('300000', '30000', dtFull.id, 'c3', partner3.id)
    const diffPartner = await runAsUser(owner, () => call(() => createInvoice({}, fd({
      orderId: [oFull.id.toString(), oOther.id.toString()], issueNow: 'on',
    })))) as { error?: string }
    checkLike('거래처가 다르면 묶이지 않는다', diffPartner.error, '거래처가 달라')

    // 같은 규칙 두 건은 묶인다 — 금액은 비율대로
    const oBig = await corpOrder('3000000', '300000', dtFull.id, 'c4')
    await runAsUser(owner, () => call(() => createInvoice({}, fd({
      orderId: [oFull.id.toString(), oBig.id.toString()], issueNow: 'on',
    }))))
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { partnerId: partner2.id }, orderBy: { id: 'desc' }, include: { orders: true },
    })
    check('한 장으로 묶인다', inv.orders.length, 2)
    check('주문별 금액 합 = 발행 대상금액',
      inv.orders.reduce((s2, x) => s2.plus(x.amount), D(0)).toString(), inv.targetAmount.toString())
    const small = inv.orders.find((x) => x.orderId === oFull.id)!
    const big = inv.orders.find((x) => x.orderId === oBig.id)!
    check('작은 주문은 1,000,000', small.amount.toString(), '1000000')
    check('큰 주문은 3,000,000 (N등분이 아니다)', big.amount.toString(), '3000000')

    // 이미 묶인 주문은 다시 못 묶는다
    const again = await runAsUser(owner, () => call(() => createInvoice({}, fd({
      orderId: [oFull.id.toString()], issueNow: 'on',
    })))) as { error?: string }
    checkLike('이미 계산서에 들어간 주문은 다시 못 넣는다', again.error, '이미 세금계산서에 들어간 주문')

    // 계산서를 하나 더 만들어 취소 시 상태 재계산을 본다
    const invA = inv
    await prisma.invoiceOrder.deleteMany({ where: { invoiceId: invA.id, orderId: oBig.id } })
    await runAsUser(owner, () => call(() => createInvoice({}, fd({
      orderId: [oBig.id.toString()], issueNow: 'on',
    }))))
    const invB = await prisma.invoice.findFirstOrThrow({
      where: { orders: { some: { orderId: oBig.id } }, id: { not: invA.id } }, orderBy: { id: 'desc' },
    })
    // oBig 을 invA 에도 다시 넣어 두 장에 걸치게 만든다 (현실에서 나올 수 있는 상태)
    await prisma.invoiceOrder.create({
      data: { invoiceId: invA.id, orderId: oBig.id, amount: D('3000000') },
    })
    await runAsUser(owner, () => call(() => cancelInvoice({}, fd({
      invoiceId: invA.id.toString(), reason: '검증',
    }))))
    const bigAfter = await prisma.order.findUniqueOrThrow({ where: { id: oBig.id } })
    check('다른 계산서가 살아 있으면 그 상태를 따른다', bigAfter.invoiceStatus, 'ISSUED')
    const smallAfter = await prisma.order.findUniqueOrThrow({ where: { id: oFull.id } })
    check('다른 계산서가 없으면 미발행으로 돌아간다', smallAfter.invoiceStatus, 'NONE')

    // 정리
    const ids = [oFull.id, oNobill.id, oOther.id, oBig.id]
    await prisma.invoiceOrder.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.invoice.deleteMany({ where: { partnerId: { in: [partner2.id, partner3.id] } } })
    const rs = await prisma.receipt.findMany({ where: { orderId: { in: ids } }, select: { id: true } })
    await prisma.receiptSplit.deleteMany({ where: { receiptId: { in: rs.map((r) => r.id) } } })
    await prisma.receipt.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.order.deleteMany({ where: { id: { in: ids } } })
    await prisma.partner.deleteMany({ where: { id: { in: [partner2.id, partner3.id] } } })
  }

  // ── 정리
  const orders = await prisma.order.findMany({ where: { partnerId: partner.id }, select: { id: true } })
  const orderIds = orders.map((o) => o.id)
  await prisma.remittance.updateMany({
    where: { allocs: { some: { orderId: { in: orderIds } } } }, data: { status: RemitStatus.DRAFT },
  })
  await prisma.remittanceAllocation.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.remittance.deleteMany({ where: { allocs: { none: {} } } })
  await withLedgerTriggersOff(async () => {
    await prisma.$executeRaw`DELETE FROM deposit_ledger WHERE partner_id = ${partner.id}`
  })
  const receipts = await prisma.receipt.findMany({ where: { partnerId: partner.id }, select: { id: true } })
  await prisma.receiptSplit.deleteMany({ where: { receiptId: { in: receipts.map((r) => r.id) } } })
  await prisma.receipt.deleteMany({ where: { partnerId: partner.id } })
  await prisma.expense.deleteMany({ where: { memo: { contains: '송금수수료' }, expenseDate: { gte: new Date(Date.now() - 3600_000) } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.partner.delete({ where: { id: partner.id } })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
