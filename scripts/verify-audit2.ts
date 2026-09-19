/**
 * 2차 감사 회귀 검증 — 9개 지적사항.
 *
 * 숫자를 테스트에 맞추지 않는다. 실제 서버 액션을 태워서
 * 고객이 겪는 경로 그대로 확인한다.
 */
import {
  PrismaClient, Prisma, Role, Route, Entity, Currency, SplitKind,
  InvoiceStatus, ReceiptSource, DepositKind, DepositMovement, VatPeriodStatus,
  PaymentStatus,
} from '@prisma/client'
import { runAsUser } from '../src/lib/request-context'
import type { SessionUser } from '../src/lib/auth'

const prisma = new PrismaClient()
const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v)
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`) }
}
function like(label: string, actual: string | undefined, needle: string) {
  if (actual && actual.includes(needle)) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label} — "${needle}" 없음. 실제: ${actual ?? '(없음)'}`) }
}
function fd(obj: Record<string, string | string[]>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x)
    else f.append(k, v)
  }
  return f
}
async function call<T>(fn: () => Promise<T>): Promise<T | { redirected: true }> {
  try { return await fn() } catch (e) {
    const d = (e as { digest?: string }).digest
    if (typeof d === 'string' && d.startsWith('NEXT_REDIRECT')) return { redirected: true }
    throw e
  }
}
async function withLedgerTriggersOff<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('ALTER TABLE deposit_ledger DISABLE TRIGGER USER')
  try { return await fn() } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE deposit_ledger ENABLE TRIGGER USER')
  }
}
const ymd = (s: string) => new Date(`${s}T00:00:00Z`)

const stamp = Date.now() % 1e6
/** 실행마다 다른 연도를 쓴다. 이전 실행이 남긴 신고기간과 겹치면 저장이 막힌다 */
const Y = 2080 + (stamp % 15)
let owner: SessionUser

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.OWNER } })
  owner = { id: admin.id.toString(), loginId: admin.loginId, name: admin.name, role: admin.role }

  const accCorp = await prisma.account.findFirstOrThrow({ where: { route: Route.BANK_CORP } })
  const accCn = await prisma.account.findFirstOrThrow({ where: { route: Route.OVERSEAS } })
  const accSite = await prisma.account.findFirstOrThrow({ where: { route: Route.SITE } })
  const dtCorp = await prisma.dealType.findFirstOrThrow({ where: { defaultRoute: Route.BANK_CORP } })

  const partner = await prisma.partner.create({
    data: { code: `B${stamp}`, name: `2차검증${stamp}`, nameNormalized: `b${stamp}`, createdBy: admin.id },
  })

  const { accountBalances } = await import('../src/lib/funds')
  const balOf = async (id: bigint) =>
    (await accountBalances()).find((a) => a.id === id.toString())!.balance

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 1. 예치금 충당 입금이 통장잔액을 두 번 늘리지 않는다 ━━')
  {
    const before = await balOf(accCorp.id)

    // ① 고객이 일반예치금 1,000,000 을 법인통장으로 넣는다
    const { createOrderWithReceipt } = await import('../src/app/(app)/orders/actions')
    await runAsUser(owner, () => call(() => createOrderWithReceipt({}, fd({
      partnerId: partner.id.toString(), route: Route.BANK_CORP,
      dealTypeId: dtCorp.id.toString(), accountId: accCorp.id.toString(),
      orderDate: '2026-03-02', amount: '1000000',
      asDeposit: 'on', title: `예치금입금${stamp}`,
    }))))
    const afterIn = await balOf(accCorp.id)
    check('① 예치금 입금 후 통장 +1,000,000', afterIn.minus(before).toString(), '1000000')

    const depBal = await prisma.depositLedger.aggregate({
      where: { partnerId: partner.id }, _sum: { amountKrw: true },
    })
    check('① 고객 일반예치금', D(depBal._sum.amountKrw ?? 0).toString(), '1000000')

    // ② 그 예치금으로 주문을 정산한다
    const r = await runAsUser(owner, () => call(() => createOrderWithReceipt({}, fd({
      partnerId: partner.id.toString(), route: Route.BANK_CORP,
      dealTypeId: dtCorp.id.toString(), accountId: accCorp.id.toString(),
      orderDate: '2026-03-05', amount: '1000000',
      fromDeposit: 'on', title: `예치금사용${stamp}`,
    }))))
    ok('② 예치금으로 주문 정산', 'redirected' in (r as object) || !(r as { error?: string }).error,
      (r as { error?: string }).error ?? '')

    const afterUse = await balOf(accCorp.id)
    check('② 통장잔액은 그대로 (2,000,000 이면 실패)', afterUse.minus(before).toString(), '1000000')

    const depAfter = await prisma.depositLedger.aggregate({
      where: { partnerId: partner.id }, _sum: { amountKrw: true },
    })
    check('② 고객 일반예치금은 0', D(depAfter._sum.amountKrw ?? 0).toString(), '0')

    const used = await prisma.receipt.findFirst({
      where: { partnerId: partner.id, source: ReceiptSource.FROM_DEPOSIT },
      include: { splits: true },
    })
    ok('② 매출 인식용 입금 전표는 남는다', !!used)
    check('② 그 전표 금액', D(used?.amount ?? 0).toString(), '1000000')
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 2. 예치금이 걸린 입금은 금액만 고칠 수 없다 ━━')
  {
    const { updateReceiptAmount } = await import('../src/app/(app)/orders/actions')
    const fromDep = await prisma.receipt.findFirstOrThrow({
      where: { partnerId: partner.id, source: ReceiptSource.FROM_DEPOSIT },
    })
    const r1 = await runAsUser(owner, () => updateReceiptAmount({}, fd({
      receiptId: fromDep.id.toString(), amount: '900000', reason: '테스트',
    })))
    like('예치금 충당 입금 수정 거부', (r1 as { error?: string }).error, '취소하고 다시 등록')

    const depSplit = await prisma.receipt.findFirst({
      where: { partnerId: partner.id, splits: { some: { splitKind: SplitKind.DEPOSIT_GENERAL } } },
    })
    if (depSplit) {
      const r2 = await runAsUser(owner, () => updateReceiptAmount({}, fd({
        receiptId: depSplit.id.toString(), amount: '900000', reason: '테스트',
      })))
      like('예치금이 들어 있는 입금 수정 거부', (r2 as { error?: string }).error, '취소하고 다시 등록')
    } else { ok('예치금이 들어 있는 입금 수정 거부', false, '대상 전표 없음') }

    // 분해가 여러 줄인 일반 입금 — 비율 재분배 금지, 구성금액을 직접 받는다
    const { createOrderWithReceipt } = await import('../src/app/(app)/orders/actions')
    await runAsUser(owner, () => call(() => createOrderWithReceipt({}, fd({
      partnerId: partner.id.toString(), route: Route.BANK_CORP,
      dealTypeId: dtCorp.id.toString(), accountId: accCorp.id.toString(),
      orderDate: '2026-03-10', amount: '1100000', vatCharged: 'on',
      title: `부가세입금${stamp}`,
    }))))
    const vatRc = await prisma.receipt.findFirstOrThrow({
      where: { partnerId: partner.id, amount: D('1100000') }, include: { splits: true },
    })
    check('부가세 입금의 분해 줄 수', vatRc.splits.length, 2)

    const r3 = await runAsUser(owner, () => updateReceiptAmount({}, fd({
      receiptId: vatRc.id.toString(), amount: '2200000', reason: '테스트',
    })))
    like('구성금액 없이 총액만 바꾸면 거부', (r3 as { error?: string }).error, '분해 금액을 모두 넣어')

    const r4 = await runAsUser(owner, () => updateReceiptAmount({}, fd({
      receiptId: vatRc.id.toString(), amount: '2200000', reason: '테스트',
      split_SALES: '2000000', split_VAT: '100000',
    })))
    like('구성금액 합계가 안 맞으면 거부', (r4 as { error?: string }).error, '분해 합계')

    const r5 = await runAsUser(owner, () => updateReceiptAmount({}, fd({
      receiptId: vatRc.id.toString(), amount: '2200000', reason: '단가 정정',
      split_SALES: '2000000', split_VAT: '200000',
    })))
    ok('구성금액을 맞춰 넣으면 통과', !(r5 as { error?: string }).error,
      (r5 as { error?: string }).error ?? '')
    const after = await prisma.receiptSplit.findMany({ where: { receiptId: vatRc.id } })
    const sum = after.reduce((a, b) => a.plus(D(b.amount)), D(0))
    check('수정 후 분해 합계 = 총액', sum.toString(), '2200000')
    const vatLine = after.find((x) => x.splitKind === SplitKind.VAT)
    check('부가세 줄은 넣은 값 그대로 (비율배분 아님)', D(vatLine?.amount ?? 0).toString(), '200000')
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 3·4·5. 부가세 납부·환급과 손익 ━━')
  {
    const { saveVatPeriod, fileVatPeriod, payVatPeriod, reopenVatPeriod } =
      await import('../src/app/(app)/invoices/vat/actions')

    // 같은 연도에 이전 실행이 남긴 신고기간이 있으면 기간이 겹쳐 저장이 막힌다
    await prisma.vatPeriod.deleteMany({
      where: { periodFrom: { gte: ymd(`${Y}-01-01`), lte: ymd(`${Y}-12-31`) } },
    })

    // 납부 — 계좌 필수
    const p1 = await runAsUser(owner, () => saveVatPeriod({}, fd({
      code: `V${stamp}A`, label: `V${stamp}-1`, periodFrom: `${Y}-03-01`, periodTo: `${Y}-03-31`,
      salesVat: '200000', purchaseVat: '0',
    })))
    ok('신고기간 저장', !(p1 as { error?: string }).error, (p1 as { error?: string }).error ?? '')
    const per1 = await prisma.vatPeriod.findFirstOrThrow({ where: { label: `V${stamp}-1` } })
    await runAsUser(owner, () => fileVatPeriod({}, fd({ id: per1.id.toString() })))

    const noAcc = await runAsUser(owner, () => payVatPeriod({}, fd({
      id: per1.id.toString(), paidAt: `${Y}-04-25`, paidAmount: '200000',
    })))
    like('③ 계좌 없이 납부 거부', (noAcc as { error?: string }).error, '계좌를 고르세요')

    const cnAcc = await runAsUser(owner, () => payVatPeriod({}, fd({
      id: per1.id.toString(), paidAt: `${Y}-04-25`, paidAmount: '200000',
      accountId: accCn.id.toString(),
    })))
    like('③ 중국 계좌로 납부 거부', (cnAcc as { error?: string }).error, '한국법인 원화')

    const balBeforePay = await balOf(accCorp.id)
    const paid = await runAsUser(owner, () => payVatPeriod({}, fd({
      id: per1.id.toString(), paidAt: `${Y}-04-25`, paidAmount: '200000',
      accountId: accCorp.id.toString(),
    })))
    ok('③ 납부 처리', !(paid as { error?: string }).error, (paid as { error?: string }).error ?? '')
    const balAfterPay = await balOf(accCorp.id)
    check('③ 납부하면 통장에서 빠진다', balAfterPay.minus(balBeforePay).toString(), '-200000')

    // 환급 — 실제 통장으로 들어와야 한다
    const p2 = await runAsUser(owner, () => saveVatPeriod({}, fd({
      code: `V${stamp}B`, label: `V${stamp}-2`, periodFrom: `${Y}-06-01`, periodTo: `${Y}-06-30`,
      salesVat: '0', purchaseVat: '150000',
    })))
    ok('환급 신고기간 저장', !(p2 as { error?: string }).error, (p2 as { error?: string }).error ?? '')
    const per2 = await prisma.vatPeriod.findFirstOrThrow({ where: { label: `V${stamp}-2` } })
    await runAsUser(owner, () => fileVatPeriod({}, fd({ id: per2.id.toString() })))

    const { vatStanding } = await import('../src/lib/vat')
    const st1 = await vatStanding()
    check('⑤ 환급 예정액은 receivable 로 분리', st1.receivable.toString(), '150000')
    ok('⑤ 환급액이 payable 을 늘리지 않는다', !st1.payable.isNegative(),
      `payable=${st1.payable.toString()}`)

    const balBeforeRef = await balOf(accCorp.id)
    const refunded = await runAsUser(owner, () => payVatPeriod({}, fd({
      id: per2.id.toString(), paidAt: `${Y}-08-10`, paidAmount: '-150000',
      accountId: accCorp.id.toString(),
    })))
    ok('③ 환급 처리', !(refunded as { error?: string }).error,
      (refunded as { error?: string }).error ?? '')
    const balAfterRef = await balOf(accCorp.id)
    check('③ 환급받으면 통장으로 들어온다', balAfterRef.minus(balBeforeRef).toString(), '150000')

    // ④ 부가세 납부는 영업손익에서 빠져야 한다.
    // 200,000 을 내고 150,000 을 돌려받은 달이니, 손익이 움직이면 실패다.
    const { dashboardData } = await import('../src/lib/dashboard')
    const dashPay = await dashboardData(`${Y}-04`)
    check('④ 납부한 달의 기타 운영비', dashPay.opEtc.toString(), '0')
    check('④ 납부한 달의 운영비 합계', dashPay.opTotal.toString(), '0')
    const vatExpCount = await prisma.expense.count({
      where: { category: { code: 'VAT_PAYMENT' }, isVoid: false, expenseDate: ymd(`${Y}-04-25`) },
    })
    check('④ 납부 전표 자체는 남아 있다 (통장에서는 빠진다)', vatExpCount, 1)

    // ⑤ 신고기간 사이 빈 구간은 여전히 예수금
    const gapBefore = (await vatStanding()).payable
    await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          orderNo: `G${stamp}`, partnerId: partner.id, route: Route.BANK_CORP,
          dealTypeId: dtCorp.id, accountingClass: '상품매출', entity: Entity.KR,
          settlementCurrency: Currency.KRW, orderDate: ymd(`${Y}-05-10`),
          invoiceStatus: InvoiceStatus.NONE, createdBy: admin.id,
        },
      })
      const rc = await tx.receipt.create({
        data: {
          receiptNo: `GR${stamp}`, orderId: o.id, partnerId: partner.id,
          accountId: accCorp.id, route: Route.BANK_CORP, entity: Entity.KR,
          receiptDate: ymd(`${Y}-05-10`), currency: Currency.KRW,
          amount: D('330000'), amountKrw: D('330000'),
          source: ReceiptSource.DIRECT, createdBy: admin.id,
        },
      })
      await tx.receiptSplit.createMany({
        data: [
          { receiptId: rc.id, splitKind: SplitKind.SALES, amount: D('300000'), amountKrw: D('300000') },
          { receiptId: rc.id, splitKind: SplitKind.VAT, amount: D('30000'), amountKrw: D('30000') },
        ],
      })
    })
    const gapAfter = (await vatStanding()).payable
    check('⑤ 3월·6월 신고 사이 5월 부가세는 예수금에 남는다',
      gapAfter.minus(gapBefore).toString(), '30000')

    const balBeforeReopen = await balOf(accCorp.id)
    await runAsUser(owner, () => reopenVatPeriod({}, fd({
      id: per2.id.toString(), reason: '검증 정리',
    })))
    const balAfterReopen = await balOf(accCorp.id)
    check('③ 되돌리면 환급 전표도 무효화된다 (받은 150,000 이 빠진다)',
      balAfterReopen.minus(balBeforeReopen).toString(), '-150000')
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 6. 내부 자금이동 검증 ━━')
  {
    const { createInternalTransfer } = await import('../src/app/(app)/remittances/actions')

    const noKrw = await runAsUser(owner, () => createInternalTransfer({}, fd({
      transferDate: `${Y}-11-01`, fromAccountId: accCorp.id.toString(),
      toAccountId: accCn.id.toString(), usdAmount: '10000', cnyArrivalAmount: '70000',
    })))
    like('⑥ 원화계좌에서 KRW 없이 보내면 거부', (noKrw as { error?: string }).error, '원화 금액을 넣으세요')

    const badTo = await runAsUser(owner, () => createInternalTransfer({}, fd({
      transferDate: `${Y}-11-01`, fromAccountId: accCorp.id.toString(),
      toAccountId: accCorp.id.toString(), krwAmount: '1000000', cnyArrivalAmount: '5000',
    })))
    like('⑥ 받는 계좌가 중국이 아니면 거부', (badTo as { error?: string }).error, '중국법인 계좌')

    const krBefore = await balOf(accCorp.id)
    const cnBefore = await balOf(accCn.id)
    const okT = await runAsUser(owner, () => createInternalTransfer({}, fd({
      transferDate: `${Y}-11-02`, fromAccountId: accCorp.id.toString(),
      toAccountId: accCn.id.toString(), krwAmount: '1400000',
      usdAmount: '1000', cnyArrivalAmount: '7000', bankFee: '20000',
    })))
    ok('⑥ 제대로 넣으면 통과', !(okT as { error?: string }).error,
      (okT as { error?: string }).error ?? '')
    check('⑥ 한국 통장에서 원금+수수료가 빠진다',
      (await balOf(accCorp.id)).minus(krBefore).toString(), '-1420000')
    check('⑥ 중국 통장에 CNY 가 들어온다',
      (await balOf(accCn.id)).minus(cnBefore).toString(), '7000')

    const feeExp = await prisma.expense.findFirst({
      where: { memo: { contains: '내부 자금이동 송금수수료' }, isVoid: false },
      orderBy: { id: 'desc' },
    })
    ok('⑥ 은행수수료가 지출 전표로 남는다', !!feeExp)
    check('⑥ 수수료 전표 금액', D(feeExp?.amountKrw ?? 0).toString(), '20000')

    const { dashboardData } = await import('../src/lib/dashboard')
    const d4 = await dashboardData(`${Y}-11`)
    check('⑥ 손익의 기타 운영비에 수수료가 한 번만 잡힌다', d4.opEtc.toString(), '20000')
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 8. 동시 요청 ━━')
  {
    const { createRemittance, sendRemittance } =
      await import('../src/app/(app)/remittances/actions')

    // 송금할 예치금을 만든다
    const order = await prisma.order.create({
      data: {
        orderNo: `C${stamp}`, partnerId: partner.id, route: Route.SITE,
        dealTypeId: (await prisma.dealType.findFirstOrThrow({ where: { defaultRoute: Route.SITE } })).id,
        accountingClass: '용역매출', entity: Entity.KR, settlementCurrency: Currency.KRW,
        orderDate: ymd('2026-04-01'), invoiceStatus: InvoiceStatus.NONE, createdBy: admin.id,
      },
    })
    const rc = await prisma.receipt.create({
      data: {
        receiptNo: `CR${stamp}`, orderId: order.id, partnerId: partner.id,
        accountId: accSite.id, route: Route.SITE, entity: Entity.KR,
        receiptDate: ymd('2026-04-01'), currency: Currency.KRW,
        amount: D('500000'), amountKrw: D('500000'), createdBy: admin.id,
      },
    })
    await prisma.$transaction(async (tx) => {
      await tx.receiptSplit.create({
        data: { receiptId: rc.id, splitKind: SplitKind.DEPOSIT_GOODS, amount: D('500000'), amountKrw: D('500000') },
      })
      await tx.depositLedger.create({
        data: {
          partnerId: partner.id, depositKind: DepositKind.GOODS_FUND,
          movement: DepositMovement.IN_RECEIPT, amountKrw: D('500000'),
          movementDate: ymd('2026-04-01'), refTable: 'receipts', refId: rc.id,
          orderId: order.id, createdBy: admin.id,
        },
      })
    })

    await runAsUser(owner, () => call(() => createRemittance({}, fd({
      remitDate: '2026-04-03', fromAccountId: accCorp.id.toString(),
      toAccountId: accCn.id.toString(), krwAmount: '500000',
      cnyArrivalAmount: '2500', bankFeeKrw: '15000', status: 'DRAFT',
      allocOrderId: [order.id.toString()], allocKrw: ['500000'],
    }))))
    const remit = await prisma.remittance.findFirstOrThrow({
      where: { allocs: { some: { orderId: order.id } } },
    })

    // 버튼을 두 번 누른 상황
    const both = await Promise.allSettled([
      runAsUser(owner, () => sendRemittance({}, fd({ remittanceId: remit.id.toString() }))),
      runAsUser(owner, () => sendRemittance({}, fd({ remittanceId: remit.id.toString() }))),
    ])
    const results = both.map((r) => r.status === 'fulfilled' ? (r.value as { ok?: string; error?: string }) : { error: 'rejected' })
    const succeeded = results.filter((r) => r.ok).length
    check('⑧ 두 번 눌러도 한 번만 성공', succeeded, 1)

    const feeCount = await prisma.expense.count({
      where: { memo: { contains: `${remit.remitNo} 송금수수료` }, isVoid: false },
    })
    check('⑧ 송금수수료 전표가 한 장만 생긴다', feeCount, 1)

    const outCount = await prisma.depositLedger.count({
      where: { orderId: order.id, movement: DepositMovement.USE_REMIT },
    })
    check('⑧ 예치금이 한 번만 빠진다', outCount, 1)

    const left = await prisma.depositLedger.aggregate({
      where: { orderId: order.id }, _sum: { amountKrw: true },
    })
    check('⑧ 그 주문 예치금 잔액', D(left._sum.amountKrw ?? 0).toString(), '0')
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n━━ 9. 로그인 잠금 ━━')
  {
    const { checkThrottle, recordFailure, clearFailures } = await import('../src/lib/login-throttle')
    const id = `zz${stamp}`

    await clearFailures(id, '203.0.113.9')
    for (let i = 0; i < 4; i++) await recordFailure(id, '203.0.113.9')
    check('⑨ 4번까지는 통과', (await checkThrottle(id, '203.0.113.9')).blocked, false)
    await recordFailure(id, '203.0.113.9')
    check('⑨ 5번째에 그 IP만 막힌다', (await checkThrottle(id, '203.0.113.9')).blocked, true)
    check('⑨ 다른 IP 에서는 그대로 들어올 수 있다',
      (await checkThrottle(id, '198.51.100.7')).blocked, false)

    const { loginAction } = await import('../src/app/login/actions')
    const wrongId = await runAsUser(owner, () => loginAction({}, fd({
      loginId: `없는아이디${stamp}`, password: 'x',
    })))
    const wrongPw = await runAsUser(owner, () => loginAction({}, fd({
      loginId: admin.loginId, password: '틀린비밀번호',
    })))
    check('⑨ 없는 아이디와 틀린 비밀번호의 답이 같다',
      (wrongId as { error?: string }).error, (wrongPw as { error?: string }).error)
    ok('⑨ 몇 번 남았는지 알려주지 않는다',
      !(wrongPw as { error?: string }).error?.includes('번 더'))
    ok('⑨ 계정이 잠겼다고 알려주지 않는다',
      !(wrongPw as { error?: string }).error?.includes('잠'))

    await prisma.loginAttempt.deleteMany({ where: { key: { contains: String(stamp) } } })
    await prisma.loginAttempt.deleteMany({ where: { key: { contains: admin.loginId } } })
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
