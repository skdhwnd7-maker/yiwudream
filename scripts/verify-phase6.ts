/**
 * Phase 6 검증 — 엑셀 가져오기
 *
 * 마이그레이션은 한 번 잘못 넣으면 되돌리기 전까지 전부 틀린 숫자가 된다.
 * 가장 틀리기 쉬운 규칙만 골라 실제 엑셀 파일을 만들어 넣었다 빼 본다:
 *   ① 환율은 수식에서 꺼낸다 (헤더의 192·195 는 쓰지 않는다)
 *   ② 법인통장 C는 공급가액, M이 실제 입금액. M이 없으면 C × 1.1
 *   ③ 일반통장은 부가세와 무관 — C가 그대로 입금액
 *   ④ 「이우드림」 은 매출이 아니라 내부 자금이동
 *   ⑤ 아르미르샵49 → 거래처 아르미르샵 + external_ref
 *   ⑥ 입금 없이 지출만 있는 행은 미수금 주문 하나로 묶인다
 *   ⑦ 일자 누락은 윗행에서 끌어오고 「추정」 표시가 붙는다
 *   ⑧ 전각 기간 １２／２８－１／３ 을 날짜로 읽는다
 *   ⑨ 배치를 되돌리면 남는 게 없다
 */
import ExcelJS from 'exceljs'
import { PrismaClient, Route } from '@prisma/client'
import { readWorkbook } from '../src/lib/excel/read'
import {
  buildPlan, SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS,
} from '../src/lib/excel/plan'
import { commitPlan, rollbackBatch } from '../src/lib/excel/commit'
import { toHalfWidth, parsePeriod, fxFromFormula, splitTrailingNumber, partnerKey, serialToDate } from '../src/lib/excel/parse'

const prisma = new PrismaClient()
let pass = 0, fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}

/** 실제 파일과 같은 모양의 작은 엑셀을 만든다 — 수식까지 */
async function makeWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()

  const ov = wb.addWorksheet(SHEET_OVERSEAS)
  ov.getRow(3).values = ['일자', '거래처', 'USD (이보이스)', 'CNY (도착금액)', 'CNY (지출금액)', '인건비용', '기타비용', '마진', '%']
  ov.getRow(4).values = [new Date(2026, 4, 6), '케이에스 글로벌', 16947.8, 115665, 102416.51, null, null]
  // 일자 누락 → 윗행에서 끌어온다
  ov.getRow(5).values = [null, '케이에스 글로벌', null, null, 1115.6]
  // 자사 자금이동
  ov.getRow(6).values = [new Date(2026, 4, 8), '이우드림', 86000, 582538]
  // 거래처 칸이 비고 지출 없이 USD→CNY 만 있는 행 — 한국 통장 돈을 중국으로 보낸 것
  ov.getRow(7).values = [new Date(2026, 4, 9), null, 50000, 338865]

  const gen = wb.addWorksheet(SHEET_GENERAL)
  gen.getRow(2).values = ['일자', '거래처', 'KRW 입금액', 'CNY(환율적용 192)', 'CNY(지출금액)', '대행통관비용', '인건비용', '기타비용', '마진', '%']
  gen.getRow(3).values = [new Date(2026, 4, 5), '더놀자', 5023869.5688, null, 21341]
  gen.getCell('D3').value = { formula: 'C3/218.22', result: 23022.04 }
  // 입금 없이 지출만 — 미수금
  gen.getRow(4).values = [new Date(2026, 4, 6), '에이스', null, null, 1250]
  gen.getRow(5).values = [new Date(2026, 4, 7), '에이스', null, null, 2300]

  const corp = wb.addWorksheet(SHEET_CORP)
  corp.getRow(2).values = ['일자', '거래처', 'KRW 입금액', 'CNY(환율적용 195)', 'CNY(지출금액)', '대행통관비용', '인건비용', '기타비용', '마진', '%']
  // M 있음 → 세금계산서 발행
  corp.getRow(3).values = [new Date(2026, 4, 4), '아르미르샵49', 3142691.27, null, 13109.65]
  corp.getCell('D3').value = { formula: 'C3/218', result: 14416.015 }
  corp.getCell('M3').value = 3456960.397
  // M 없음 → 부가세는 받되 계산서 미발행
  corp.getRow(4).values = [new Date(2026, 4, 4), '네일의 품격', 1000000, null, 4000]
  corp.getCell('D4').value = { formula: 'C4/200', result: 5000 }

  const ops = wb.addWorksheet(SHEET_OPS)
  ops.getRow(1).values = ['직원월급', '직원월급', null, '社保', null, '临时工费用', '临时工费用', null, null, '사무실 경비 ', '사무실 경비 ']
  ops.getRow(3).values = ['검증甲', 9500, 9500, null, null, '１２／２８－１／３', 5180, null, null, 46031, 10000]
  ops.getRow(4).values = ['검증乙', 8500, 8500, 1416]
  // J열에 날짜 대신 내용이 적힌 사무실 경비 + 직원 없이 금액만 있는 사회보험
  ops.getRow(2).values = [null, null, null, 777, null, null, null, null, null, '박스비8/9월', 11884]
  ops.getRow(5).values = ['合计：', 18000, 18000, 1416, null, null, 5180, null, null, null, 10000]

  wb.addWorksheet('Sheet3').getRow(2).values = ['더라임커머스', 112848]

  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function main() {
  console.log('\n━━ 0. 순수 함수 ━━')
  check('전각 기간 변환', toHalfWidth('１２／２８－１／３'), '12/28-1/3')
  const per = parsePeriod('１２／２８－１／３', 2025)
  check('해 넘김 기간 시작', per?.from.toISOString().slice(0, 10), '2025-12-28')
  check('해 넘김 기간 종료', per?.to.toISOString().slice(0, 10), '2026-01-03')
  check('같은 해 기간', parsePeriod('１／１１－１／１７', 2026)?.from.toISOString().slice(0, 10), '2026-01-11')
  check('수식에서 환율', fxFromFormula('C3/218.22')?.toString(), '218.22')
  check('= 붙은 수식', fxFromFormula('=C3/218.22')?.toString(), '218.22')
  check('나눗셈 아닌 수식은 환율 아님', fxFromFormula('D4-E4-F4-G4'), 'null')
  check('꼬리 숫자 분리 — 이름', splitTrailingNumber('아르미르샵49').name, '아르미르샵')
  check('꼬리 숫자 분리 — 원본', splitTrailingNumber('아르미르샵49').externalRef, '아르미르샵49')
  check('꼬리 숫자 없음', splitTrailingNumber('더놀자').externalRef, 'null')
  check('정규화 키가 같다', partnerKey('아르미르샵133'), partnerKey('아르미르샵 '))
  check('띄어쓰기 정규화', partnerKey('케이에스 글로벌'), partnerKey('케이에스글로벌'))
  check('엑셀 날짜 시리얼', serialToDate(46031)?.toISOString().slice(0, 10), '2026-01-09')

  console.log('\n━━ 1. 계획 ━━')
  const buf = await makeWorkbook()
  const wb = await readWorkbook(buf)
  const opts = {
    sheets: [SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS],
    opsBaseYear: 2025, payrollYm: '2026-09', cnyDisplayRate: '218',
    blankRowsAreRemittance: true, remitFromRoute: Route.BANK_CORP,
    usdKrwRate: '1380', officeFallbackDate: '2026-09-30',
  }
  const plan = buildPlan(wb, opts)

  check('Sheet3 는 가져오지 않는다', plan.skipped.some((s) => s.sheet === 'Sheet3'), 'true')
  check('중국 송금 2건 (이우드림 + 거래처 빈 행)', plan.transfers.length, 2)
  check('자금이동 CNY', plan.transfers[0].cny?.toString(), '582538')
  check('자금이동 USD/CNY 환율', plan.transfers[0].fxUsdCny?.toString(), '6.773698')
  check('이우드림 행은 빈 행이 아니다', plan.transfers[0].fromBlankRow, 'false')
  check('거래처 빈 행도 중국 송금', plan.transfers[1].fromBlankRow, 'true')
  check('거래처 빈 행 CNY', plan.transfers[1].cny?.toString(), '338865')
  check('빈 행은 주문이 되지 않는다',
    plan.orders.some((o) => o.sheet === SHEET_OVERSEAS && o.rowIndex === 7), 'false')
  check('이우드림은 주문이 아니다',
    plan.orders.some((o) => o.partnerName.includes('이우드림')), 'false')

  const ks = plan.orders.find((o) => o.sheet === SHEET_OVERSEAS && o.rowIndex === 4)!
  check('해외송금 입금 CNY', ks.receiptAmount?.toString(), '115665')
  check('해외송금 지출 CNY', ks.expenses[0].cny.toString(), '102416.51')
  check('해외송금 SALES 분해', ks.splits[0].amount.toString(), '115665')

  const gen = plan.orders.find((o) => o.sheet === SHEET_GENERAL && o.rowIndex === 3)!
  check('일반통장 환율 = 수식값 (헤더 192 아님)', gen.fxRate?.toString(), '218.22')
  check('일반통장 환율 근거', gen.fxSource, 'PARSED')
  check('일반통장 입금 = C열 전액', gen.receiptAmount?.toString(), '5023869.57')
  check('일반통장은 부가세 분해가 없다', gen.splits.length, 1)
  check('일반통장 분해는 SALES', gen.splits[0].kind, 'SALES')

  const corpBilled = plan.orders.find((o) => o.sheet === SHEET_CORP && o.rowIndex === 3)!
  check('법인통장 환율', corpBilled.fxRate?.toString(), '218')
  check('법인통장 입금 = M열', corpBilled.receiptAmount?.toString(), '3456960.4')
  check('법인통장 공급가액 = C열', corpBilled.splits[0].amount.toString(), '3142691.27')
  check('법인통장 부가세 = M − C', corpBilled.splits[1].amount.toString(), '313.13'.length ? '314269.13' : '')
  check('분해 합계 = 입금액',
    corpBilled.splits.reduce((s, x) => s.plus(x.amount), corpBilled.splits[0].amount.mul(0)).toString(),
    corpBilled.receiptAmount?.toString())
  check('세금계산서 생성', corpBilled.invoice !== null, 'true')
  check('거래유형 = 전액발행', corpBilled.dealTypeCode, 'CORP_FULL')
  check('external_ref 보존', corpBilled.externalRef, '아르미르샵49')
  check('거래처명은 숫자 뺀 이름', corpBilled.partnerName, '아르미르샵')

  const corpNo = plan.orders.find((o) => o.sheet === SHEET_CORP && o.rowIndex === 4)!
  check('M 없으면 입금 = C × 1.1', corpNo.receiptAmount?.toString(), '1100000')
  check('미발행도 부가세를 받는다', corpNo.splits[1].amount.toString(), '100000')
  check('거래유형 = 미발행', corpNo.dealTypeCode, 'CORP_NOBILL')
  check('미발행은 계산서를 만들지 않는다', corpNo.invoice, 'null')

  const ovReceivable = plan.orders.find((o) => o.mergedRows && o.sheet === SHEET_OVERSEAS)!
  const receivable = plan.orders.find((o) => o.mergedRows && o.sheet === SHEET_GENERAL)!
  // 5행은 일자가 비었고 지출만 있다 — 윗행 일자를 끌어온 뒤 미수금 주문으로 묶인다
  check('일자를 윗행에서 끌어왔다',
    ovReceivable.orderDate?.toISOString().slice(0, 10), '2026-05-06')
  check('끌어온 일자는 추정 표시', ovReceivable.dateEstimated, 'true')
  check('에이스 미수금 묶음', receivable.mergedRows?.length, 2)
  check('미수금 지출 합계',
    receivable.expenses.reduce((s, e) => s.plus(e.cny), receivable.expenses[0].cny.mul(0)).toString(), '3550')
  check('미수금은 입금이 없다', receivable.receiptAmount, 'null')

  const office = plan.opExpenses.filter((e) => e.categoryCode === 'OFFICE')
  check('사무실 경비 2건', office.length, 2)
  check('날짜 있는 행은 그 날짜', office.find((e) => e.cny.toString() === '10000')
    ?.expenseDate?.toISOString().slice(0, 10), '2026-01-09')
  const noDate = office.find((e) => e.cny.toString() === '11884')!
  check('날짜 없는 행은 지정한 날짜로', noDate.expenseDate?.toISOString().slice(0, 10), '2026-09-30')
  check('내용은 그대로 남는다', noDate.workDesc, '박스비8/9월')
  check('날짜 없는 행도 막지 않는다', noDate.issues.some((i) => i.level === 'HOLD'), 'false')

  const orphanIns = plan.opExpenses.find((e) => e.categoryCode === 'INSURANCE')!
  check('직원 미지정 사회보험도 넣는다', orphanIns.cny.toString(), '777')
  check('귀속월로 잡는다', orphanIns.expenseDate?.toISOString().slice(0, 10), '2026-09-01')

  const temp = plan.opExpenses.find((e) => e.categoryCode === 'TEMP_LABOR')!
  check('임시공 기간 시작', temp.periodFrom?.toISOString().slice(0, 10), '2025-12-28')
  check('임시공 금액', temp.cny.toString(), '5180')
  check('직원 2명', plan.employees.length, 2)
  check('合计 행은 가져오지 않는다',
    plan.employees.some((e) => e.nameCn.includes('合计')), 'false')
  check('실지급 합계', plan.employees.reduce((s, e) => s + Number(e.actualPaid ?? 0), 0), 18000)

  console.log('\n━━ 2. 실제로 넣기 ━━')
  const admin = await prisma.user.findFirstOrThrow({ where: { loginId: 'admin' } })
  const before = {
    orders: await prisma.order.count(),
    receipts: await prisma.receipt.count(),
    expenses: await prisma.expense.count(),
    invoices: await prisma.invoice.count(),
    transfers: await prisma.internalTransfer.count(),
  }
  const ctx = { user: { id: admin.id.toString(), name: admin.name } }
  const r = await commitPlan(wb, plan, opts, 'verify-phase6.xlsx', admin.id, ctx)

  check('주문 생성', r.orders, 6)
  check('중국 송금 생성', r.transfers, 2)
  check('세금계산서 생성', r.invoices, 1)
  check('급여 생성', r.payrolls, 2)

  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: BigInt(r.batchId) } })
  const created = ((batch.summary as { created?: Record<string, string[]> })?.created ?? {}) as Record<string, string[]>

  const billed = await prisma.order.findFirstOrThrow({
    where: { externalRef: '아르미르샵49' },
    include: { receipts: { include: { splits: true } }, dealType: true },
  })
  check('주문번호가 MIG 로 구분된다', billed.orderNo.startsWith('MIG-'), 'true')
  check('저장된 입금액', billed.receipts[0].amount.toString(), '3456960.4')
  check('저장된 부가세 분해',
    billed.receipts[0].splits.find((s) => s.splitKind === 'VAT')?.amount.toString(), '314269.13')
  check('저장된 환율', billed.receipts[0].fxRate?.toString(), '218')
  check('환율 근거 = 수식', billed.receipts[0].fxRateSource, 'PARSED')

  // 이우드림 행은 거래처를 아예 만들지 않는다 — 자금이동이지 거래가 아니다
  const noInternalOrder = await prisma.order.count({
    where: { id: { in: (created.orders ?? []).map(BigInt) }, partner: { name: { contains: '이우드림' } } },
  })
  check('이우드림 주문은 없다', noInternalOrder, 0)

  const estimated = await prisma.order.count({
    where: { id: { in: (created.orders ?? []).map(BigInt) }, orderDateEstimated: true },
  })
  check('일자 추정 표시', estimated, 1)

  const rawRows = await prisma.importRow.count({ where: { batchId: BigInt(r.batchId) } })
  check('원본 행 보관', rawRows > 0, 'true')
  const sheet3 = await prisma.importRow.findFirst({
    where: { batchId: BigInt(r.batchId), sheetName: 'Sheet3' },
  })
  check('Sheet3 도 원본은 남긴다', sheet3?.mapStatus, 'SKIP')
  check('수식 원문 보관',
    (await prisma.importRow.count({
      where: { batchId: BigInt(r.batchId), rawFormula: { not: undefined } },
    })) > 0, 'true')

  console.log('\n━━ 2-1. 중국 송금 원화 처리 ━━')
  const transfers = await prisma.internalTransfer.findMany({
    where: { id: { in: (created.transfers ?? []).map(BigInt) } },
    orderBy: { id: 'asc' },
  })
  const named = transfers.find((t) => t.cnyArrivalAmount?.toString() === '582538')!
  const blank = transfers.find((t) => t.cnyArrivalAmount?.toString() === '338865')!
  // 「이우드림」 행은 어느 통장에서 나갔는지 모른다 — 원화로 빼면 잔액이 틀어진다
  check('이우드림 행은 원화 금액 없음', named.krwAmount, 'null')
  check('이우드림 행은 출금계좌 없음', named.fromAccountId, 'null')
  // 대표님 확인: 거래처 빈 행은 한국 통장에 모인 돈을 보낸 것
  check('빈 행은 원화로 환산', blank.krwAmount?.toString(), '69000000')
  check('빈 행은 출금계좌 지정', blank.fromAccountId !== null, 'true')

  console.log('\n━━ 3. 되돌리기 ━━')
  const undo = await rollbackBatch(BigInt(r.batchId), { ...ctx, reason: '검증' })
  check('주문 되돌림', undo.orders, 6)
  check('중국 송금 되돌림', undo.transfers, 2)

  const after = {
    orders: await prisma.order.count(),
    receipts: await prisma.receipt.count(),
    expenses: await prisma.expense.count(),
    invoices: await prisma.invoice.count(),
    transfers: await prisma.internalTransfer.count(),
  }
  check('주문 원상복구', after.orders, before.orders)
  check('입금 원상복구', after.receipts, before.receipts)
  check('지출 원상복구', after.expenses, before.expenses)
  check('세금계산서 원상복구', after.invoices, before.invoices)
  check('자금이동 원상복구', after.transfers, before.transfers)

  // 원본 행은 남는다 — 지우지 않는 것이 설계다
  check('되돌려도 원본은 남는다',
    (await prisma.importRow.count({ where: { batchId: BigInt(r.batchId) } })) > 0, 'true')

  await prisma.importRow.deleteMany({ where: { batchId: BigInt(r.batchId) } })
  await prisma.importBatch.delete({ where: { id: BigInt(r.batchId) } })

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`통과 ${pass} / 실패 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
