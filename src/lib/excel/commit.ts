/**
 * 계획을 실제 데이터로 넣는다.
 *
 * 설계 문서: docs/07-엑셀마이그레이션.md 1장 원칙 1·4
 *
 * 원칙 두 가지만 지킨다.
 *   ① 원본 행을 통째로 남긴다 (import_rows.raw_json / raw_formula).
 *      "엑셀 몇 번째 줄이 어느 주문이 됐나" 를 언제든 되짚을 수 있어야 한다.
 *   ② 배치 단위로 되돌릴 수 있다. 이관은 한 번에 성공하는 일이 드물다.
 */
import {
  Prisma, ImportStatus, ImportRowStatus, InvoiceStatus, PaymentStatus,
  Currency, OrderStatus, Route, FxSource,
} from '@prisma/client'
import { prisma } from '../db'
import { nextDocNo } from '../numbering'
import { logAction, type AuditContext } from '../audit'
import { AuditAction } from '@prisma/client'
import { cnyToKrw, krwToCny } from '../money'
import { normalizeName } from '../normalize'
import type { WorkbookData } from './read'
import { colLetter } from './read'
import type { ImportPlan, PlannedOrder, PlanOptions } from './plan'
import { D } from './parse'

/** 되돌리기 때 정확히 이 배치가 만든 것만 지우기 위한 목록 */
interface CreatedIds {
  orders: string[]
  transfers: string[]
  opExpenses: string[]
  payrolls: string[]
  employees: string[]
  partners: string[]
}

export interface CommitResult {
  batchId: string
  partners: number
  orders: number
  receipts: number
  expenses: number
  invoices: number
  transfers: number
  employees: number
  payrolls: number
  opExpenses: number
  rows: number
  skippedOrders: number
}

/** 가져오지 않는 행 — 사람이 먼저 고쳐야 한다 */
function isBlocked(o: PlannedOrder): boolean {
  return o.status === ImportRowStatus.ERROR || o.status === ImportRowStatus.HOLD
}

/**
 * 원본 시트 전체를 import_rows 에 남긴다.
 * 가져오지 않기로 한 시트(Sheet2·Sheet3)도 SKIP 상태로 보관한다 — 버리지 않는다.
 */
async function saveRawRows(
  tx: Prisma.TransactionClient, batchId: bigint, wb: WorkbookData, opts: PlanOptions,
): Promise<number> {
  let n = 0
  for (const sheet of wb.sheets) {
    const included = opts.sheets.includes(sheet.name)
    const data = sheet.rows.map((r) => {
      const raw: Record<string, unknown> = {}
      const formulas: Record<string, string> = {}
      r.cells.forEach((c, i) => {
        if (c.value !== null) {
          raw[colLetter(i)] = c.value instanceof Date ? c.value.toISOString() : c.value
        }
        if (c.formula) formulas[colLetter(i)] = c.formula
      })
      return {
        batchId, sheetName: sheet.name, rowIndex: r.rowIndex,
        rawJson: raw as Prisma.InputJsonValue,
        rawFormula: Object.keys(formulas).length
          ? (formulas as Prisma.InputJsonValue) : Prisma.JsonNull,
        mapStatus: included ? ImportRowStatus.OK : ImportRowStatus.SKIP,
      }
    })
    // 500행 단위로 나눠 넣는다 — 한 번에 밀어 넣으면 파라미터 한계에 걸린다
    for (let i = 0; i < data.length; i += 500) {
      const chunk = data.slice(i, i + 500)
      await tx.importRow.createMany({ data: chunk })
      n += chunk.length
    }
  }
  return n
}

/** 계획된 행 상태를 import_rows 에 되쓴다 — 어떤 행이 무엇이 됐는지 남긴다 */
async function markRow(
  tx: Prisma.TransactionClient, batchId: bigint, sheet: string, rowIndex: number,
  status: ImportRowStatus, targetTable: string | null, targetId: bigint | null, errorMsg: string | null,
) {
  await tx.importRow.updateMany({
    where: { batchId, sheetName: sheet, rowIndex },
    data: { mapStatus: status, targetTable, targetId, errorMsg },
  })
}

export async function commitPlan(
  wb: WorkbookData, plan: ImportPlan, opts: PlanOptions,
  fileName: string, userId: bigint, ctx: AuditContext,
): Promise<CommitResult> {
  const result: CommitResult = {
    batchId: '', partners: 0, orders: 0, receipts: 0, expenses: 0, invoices: 0,
    transfers: 0, employees: 0, payrolls: 0, opExpenses: 0, rows: 0, skippedOrders: 0,
  }

  // 해외송금은 CNY 정산이라 행마다 환율이 없다. 원화 표시용 환산율은 담당자가 넣은 값을 쓴다
  const cnyRate = D(opts.cnyDisplayRate)
  const created: CreatedIds = {
    orders: [], transfers: [], opExpenses: [], payrolls: [], employees: [], partners: [],
  }

  await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({
      data: { fileName, status: ImportStatus.VALIDATED, uploadedBy: userId },
    })
    result.batchId = batch.id.toString()
    result.rows = await saveRawRows(tx, batch.id, wb, opts)

    // ── 기준정보 조회
    const dealTypes = new Map(
      (await tx.dealType.findMany()).map((d) => [d.code, d]),
    )
    const categories = new Map(
      (await tx.expenseCategory.findMany()).map((c) => [c.code, c]),
    )
    const accounts = new Map(
      (await tx.account.findMany()).map((a) => [a.route, a]),
    )
    const cnAccount = accounts.get(Route.OVERSEAS)

    // ── 거래처
    const partnerIdByKey = new Map<string, bigint>()
    for (const p of plan.partners) {
      const normalized = normalizeName(p.name)
      let row = await tx.partner.findFirst({
        where: { OR: [{ nameNormalized: normalized }, { aliases: { some: { aliasNormalized: normalized } } }] },
      })
      if (!row) {
        const code = await nextPartnerCode(tx)
        row = await tx.partner.create({
          data: {
            code, name: p.name, nameNormalized: normalized,
            defaultRoute: p.defaultRoute, isInternal: p.isInternal,
            memo: `엑셀 가져오기 (${fileName})`, createdBy: userId,
          },
        })
        result.partners++
        created.partners.push(row.id.toString())
      }
      partnerIdByKey.set(p.key, row.id)

      // 원본 표기를 별칭으로 남긴다 — 다음 번 가져오기에서 같은 거래처로 붙는다
      for (const v of p.variants) {
        const an = normalizeName(v.raw)
        const exists = await tx.partnerAlias.findFirst({ where: { alias: v.raw } })
        if (!exists && an !== normalized) {
          await tx.partnerAlias.create({
            data: { partnerId: row.id, alias: v.raw, aliasNormalized: an, source: 'IMPORT' },
          })
        }
      }
    }

    // ── 주문 · 입금 · 지출 · 세금계산서
    for (const o of plan.orders) {
      if (isBlocked(o)) {
        result.skippedOrders++
        await markRow(tx, batch.id, o.sheet, o.rowIndex, o.status, null, null,
          o.issues.filter((i) => i.level === 'ERROR' || i.level === 'HOLD')
            .map((i) => i.message).join(' / '))
        continue
      }
      const partnerId = partnerIdByKey.get(o.partnerKey)
      const dealType = dealTypes.get(o.dealTypeCode)
      const account = accounts.get(o.route)
      if (!partnerId || !dealType || !account || !o.orderDate) {
        result.skippedOrders++
        await markRow(tx, batch.id, o.sheet, o.rowIndex, ImportRowStatus.ERROR, null, null,
          '거래처·거래유형·계좌·일자 중 빠진 것이 있어 넣지 못했습니다.')
        continue
      }

      const orderNo = await nextDocNo(tx, 'MIG', o.orderDate)
      const order = await tx.order.create({
        data: {
          orderNo, partnerId, route: o.route, dealTypeId: dealType.id,
          accountingClass: o.accountingClass, entity: o.entity,
          settlementCurrency: o.settlementCurrency,
          orderDate: o.orderDate, orderDateEstimated: o.dateEstimated,
          externalRef: o.externalRef,
          usdInvoiceAmount: o.usdAmount,
          invoiceStatus: o.invoice ? InvoiceStatus.ISSUED : InvoiceStatus.NONE,
          status: OrderStatus.OPEN,
          memo: o.memo, createdBy: userId,
        },
      })
      result.orders++
      created.orders.push(order.id.toString())

      // 입금
      if (o.receiptAmount && o.splits.length > 0) {
        const receiptNo = await nextDocNo(tx, 'RC', o.orderDate)
        const toKrw = (v: Prisma.Decimal) =>
          o.receiptCurrency === Currency.KRW ? v : cnyToKrw(v, o.fxRate ?? cnyRate, 'FLOOR')
        const toCny = (v: Prisma.Decimal) =>
          o.receiptCurrency === Currency.CNY ? v : (o.fxRate ? krwToCny(v, o.fxRate) : null)

        const receipt = await tx.receipt.create({
          data: {
            receiptNo, orderId: order.id, partnerId, accountId: account.id,
            route: o.route, entity: o.entity, receiptDate: o.orderDate,
            currency: o.receiptCurrency, amount: o.receiptAmount,
            fxRate: o.fxRate ?? (o.receiptCurrency === Currency.CNY ? cnyRate : null),
            fxRateSource: o.fxSource === 'PARSED' ? FxSource.PARSED : FxSource.MANUAL,
            usdAmount: o.usdAmount,
            amountKrw: toKrw(o.receiptAmount), amountCny: toCny(o.receiptAmount),
            memo: o.fxSource === 'PARSED' ? `환율 근거: ${o.fxEvidence}`
              : o.fxSource === 'DERIVED' ? `환율 역산: ${o.fxEvidence}`
              : `CNY 정산 — 원화 표시는 이관 환산환율 ${cnyRate.toString()} 기준`,
            createdBy: userId,
          },
        })
        result.receipts++

        // 분해 합계 = 입금액 검사는 커밋 시점 지연제약이라 같은 트랜잭션 안이면 된다
        for (const s of o.splits) {
          await tx.receiptSplit.create({
            data: {
              receiptId: receipt.id, splitKind: s.kind, amount: s.amount,
              amountKrw: toKrw(s.amount), amountCny: toCny(s.amount),
            },
          })
        }
      }

      // 지출
      for (const e of o.expenses) {
        const category = categories.get(e.categoryCode)
        if (!category) continue
        const expenseNo = await nextDocNo(tx, 'EX', o.orderDate)
        // CNY 지출을 KRW 로 환산할 근거가 없으면 환산하지 않는다. 환율을 지어내지 않는다
        const krw = cnyToKrw(e.cny, o.fxRate ?? cnyRate, 'FLOOR')
        const ex = await tx.expense.create({
          data: {
            expenseNo, entity: o.entity, expenseDate: o.orderDate,
            categoryId: category.id,
            // 상품대금·인건비는 루트와 상관없이 전부 중국에서 CNY 로 나간다.
            // 고객이 어느 한국 계좌에 넣었느냐와 돈이 어디서 빠졌느냐는 다른 이야기다.
            accountId: cnAccount?.id ?? null,
            currency: Currency.CNY, amount: e.cny,
            fxRate: o.fxRate ?? cnyRate,
            fxRateSource: o.fxSource === 'PARSED' ? FxSource.PARSED : FxSource.MANUAL,
            amountKrw: krw, amountCny: e.cny,
            paymentStatus: PaymentStatus.PAID, paidAt: o.orderDate,
            workDesc: `엑셀 ${o.sheet} ${o.rowIndex}행 ${e.col}열`,
            createdBy: userId,
          },
        })
        await tx.expenseAllocation.create({
          data: {
            expenseId: ex.id, orderId: order.id, allocAmount: e.cny,
            allocKrw: krw, allocCny: e.cny,
          },
        })
        result.expenses++
      }

      // 세금계산서
      if (o.invoice) {
        const invoiceNo = await nextDocNo(tx, 'TX', o.orderDate)
        const inv = await tx.invoice.create({
          data: {
            invoiceNo, partnerId, dealTypeId: dealType.id,
            accountingClass: o.accountingClass,
            totalReceiptAmount: o.receiptAmount ?? o.invoice.total,
            targetAmount: o.invoice.supply, targetAmountSource: 'AUTO',
            vatMode: dealType.vatMode,
            supplyAmount: o.invoice.supply, vatAmount: o.invoice.vat, totalAmount: o.invoice.total,
            issueStatus: InvoiceStatus.ISSUED, issueDate: o.orderDate,
            memo: `엑셀 ${o.sheet} ${o.rowIndex}행 M열`,
            createdBy: userId,
          },
        })
        await tx.invoiceOrder.create({
          data: { invoiceId: inv.id, orderId: order.id, amount: o.invoice.supply },
        })
        result.invoices++
      }

      const rows = o.mergedRows ?? [o.rowIndex]
      for (const r of rows) {
        await markRow(tx, batch.id, o.sheet, r, o.status, 'orders', order.id, null)
      }
    }

    // ── 내부 자금이동
    const corpAcc = accounts.get(Route.BANK_CORP)
    const cnAcc = cnAccount
    for (const t of plan.transfers) {
      if (!t.date || !corpAcc || !cnAcc) {
        await markRow(tx, batch.id, '해외송금', t.rowIndex, ImportRowStatus.ERROR, null, null,
          '일자나 계좌가 없어 내부 자금이동을 만들지 못했습니다.')
        continue
      }
      const transferNo = await nextDocNo(tx, 'IT', t.date)
      const it = await tx.internalTransfer.create({
        data: {
          transferNo, transferDate: t.date,
          fromEntity: 'KR', toEntity: 'CN',
          fromAccountId: corpAcc.id, toAccountId: cnAcc.id,
          usdAmount: t.usd, cnyArrivalAmount: t.cny, fxRateUsdCny: t.fxUsdCny,
          purpose: '엑셀 이관 — 자사 자금이동', createdBy: userId,
        },
      })
      result.transfers++
      created.transfers.push(it.id.toString())
      await markRow(tx, batch.id, '해외송금', t.rowIndex, ImportRowStatus.OK,
        'internal_transfers', it.id, null)
    }

    // ── 직원 · 급여
    const [py, pm] = opts.payrollYm.split('-').map(Number)
    const payDate = new Date(py, pm - 1, 1)
    const salaryCat = categories.get('SALARY')
    const insuranceCat = categories.get('INSURANCE')
    for (const e of plan.employees) {
      let emp = await tx.employee.findFirst({ where: { nameCn: e.nameCn } })
      if (!emp) {
        emp = await tx.employee.create({
          data: {
            empCode: await nextEmployeeCode(tx),
            name: e.nameCn, nameCn: e.nameCn,
            baseSalary: e.baseSalary, currency: Currency.CNY, isActive: true,
            memo: `엑셀 가져오기 (${fileName})`,
          },
        })
        result.employees++
        created.employees.push(emp.id.toString())
      }
      if (e.actualPaid && e.actualPaid.gt(0)) {
        const exists = await tx.payroll.findFirst({
          where: { employeeId: emp.id, yearMonth: opts.payrollYm },
        })
        if (!exists) {
          // 급여는 지출 전표가 따라 붙어야 중국 운영비 집계에 잡힌다.
          // 급여 화면에서 저장할 때와 같은 모양으로 만든다 — 원장이 하나여야 한다.
          const salaryExpense = await tx.expense.create({
            data: {
              expenseNo: await nextDocNo(tx, 'EX', payDate),
              entity: 'CN', expenseDate: payDate, categoryId: salaryCat!.id,
              accountId: cnAcc?.id ?? null,
              vendorName: emp.nameCn ?? emp.name,
              currency: Currency.CNY, amount: e.actualPaid,
              fxRate: cnyRate, fxRateSource: FxSource.MANUAL,
              amountKrw: cnyToKrw(e.actualPaid, cnyRate, 'FLOOR'), amountCny: e.actualPaid,
              paymentStatus: PaymentStatus.PAID, paidAt: payDate,
              memo: `${opts.payrollYm} 급여 · ${emp.name} (엑셀 Sheet1 ${e.rowIndex}행)`,
              createdBy: userId,
            },
          })
          result.opExpenses++
          created.opExpenses.push(salaryExpense.id.toString())
          if (e.insurance && e.insurance.gt(0) && insuranceCat) {
            const insExpense = await tx.expense.create({
              data: {
                expenseNo: await nextDocNo(tx, 'EX', payDate),
                entity: 'CN', expenseDate: payDate, categoryId: insuranceCat.id,
                accountId: cnAcc?.id ?? null,
                vendorName: emp.nameCn ?? emp.name,
                currency: Currency.CNY, amount: e.insurance,
                fxRate: cnyRate, fxRateSource: FxSource.MANUAL,
                amountKrw: cnyToKrw(e.insurance, cnyRate, 'FLOOR'), amountCny: e.insurance,
                paymentStatus: PaymentStatus.PAID, paidAt: payDate,
                memo: `${opts.payrollYm} 사회보험(회사부담) · ${emp.name}`,
                createdBy: userId,
              },
            })
            result.opExpenses++
            created.opExpenses.push(insExpense.id.toString())
          }
          const payroll = await tx.payroll.create({
            data: {
              employeeId: emp.id, yearMonth: opts.payrollYm,
              baseSalary: e.baseSalary ?? e.actualPaid,
              actualPaid: e.actualPaid,
              insuranceCompany: e.insurance ?? new Prisma.Decimal(0),
              currency: Currency.CNY, paidAt: payDate,
              expenseId: salaryExpense.id,
              memo: `엑셀 Sheet1 ${e.rowIndex}행`,
              createdBy: userId,
            },
          })
          result.payrolls++
          created.payrolls.push(payroll.id.toString())
        }
      }
      await markRow(tx, batch.id, 'Sheet1', e.rowIndex, ImportRowStatus.OK, 'employees', emp.id, null)
    }

    // ── 중국 운영비 (주문 미귀속)
    for (const e of plan.opExpenses) {
      const category = categories.get(e.categoryCode)
      const blocked = e.issues.some((i) => i.level === 'HOLD')
      if (!category || blocked || !e.expenseDate) {
        await markRow(tx, batch.id, 'Sheet1', e.rowIndex, ImportRowStatus.HOLD, null, null,
          e.issues.map((i) => i.message).join(' / ') || '지출일을 알 수 없어 보류했습니다.')
        continue
      }
      const expenseNo = await nextDocNo(tx, 'EX', e.expenseDate)
      const opEx = await tx.expense.create({
        data: {
          expenseNo, entity: 'CN', expenseDate: e.expenseDate,
          categoryId: category.id, accountId: cnAcc?.id ?? null,
          currency: Currency.CNY, amount: e.cny,
          fxRate: cnyRate, fxRateSource: FxSource.MANUAL,
          amountKrw: cnyToKrw(e.cny, cnyRate, 'FLOOR'), amountCny: e.cny,
          workDesc: e.workDesc,
          workPeriodFrom: e.periodFrom, workPeriodTo: e.periodTo,
          paymentStatus: PaymentStatus.PAID, paidAt: e.expenseDate,
          createdBy: userId,
        },
      })
      result.opExpenses++
      created.opExpenses.push(opEx.id.toString())
    }

    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: ImportStatus.COMMITTED, committedAt: new Date(),
        summary: {
          ...result,
          sheets: opts.sheets,
          counts: plan.counts,
          totals: plan.totals,
          created,
        } as unknown as Prisma.InputJsonValue,
      },
    })

    await logAction(tx, 'import_batches', batch.id, AuditAction.IMPORT, ctx, {
      newValue: [
        `파일 ${fileName}`,
        `시트 ${opts.sheets.join('·')}`,
        `주문 ${result.orders}`,
        `입금 ${result.receipts}`,
        `지출 ${result.expenses}`,
        `세금계산서 ${result.invoices}`,
        `내부 자금이동 ${result.transfers}`,
        `보류 ${result.skippedOrders}`,
      ].join(' / '),
    })
  }, { timeout: 1000 * 60 * 10, maxWait: 1000 * 30 })

  return result
}

/** P0001 부터 순서대로 */
async function nextPartnerCode(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.partner.findFirst({
    where: { code: { startsWith: 'P' } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const n = last ? Number(last.code.slice(1)) + 1 : 1
  return `P${String(Number.isFinite(n) ? n : 1).padStart(4, '0')}`
}

/**
 * 배치 되돌리기 — 이 배치가 만든 것만 지운다.
 *
 * 무엇을 만들었는지 커밋할 때 목록으로 남겨 두었다. 이름이나 날짜로 되짚어 지우면
 * 사람이 나중에 손으로 넣은 자료까지 날아갈 수 있다.
 * 예치금 원장과 변경이력은 DB 가 삭제를 막고 있으므로, 원장이 걸린 배치는 되돌리지 않고
 * 왜 안 되는지 알려 준다 — 조용히 실패하면 성공으로 오해한다.
 */
export interface RollbackResult {
  orders: number
  receipts: number
  expenses: number
  invoices: number
  transfers: number
  payrolls: number
  employees: number
  partners: number
  /** 다른 곳에서 쓰이고 있어 남겨 둔 것 */
  keptPartners: number
  keptEmployees: number
}

export async function rollbackBatch(batchId: bigint, ctx: AuditContext): Promise<RollbackResult> {
  const r: RollbackResult = {
    orders: 0, receipts: 0, expenses: 0, invoices: 0, transfers: 0,
    payrolls: 0, employees: 0, partners: 0, keptPartners: 0, keptEmployees: 0,
  }

  await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } })
    if (batch.status === ImportStatus.ROLLED_BACK) {
      throw new Error('이미 되돌린 배치입니다.')
    }
    const summary = (batch.summary ?? {}) as { created?: Record<string, string[]> }
    const created = summary.created
    if (!created) {
      throw new Error('이 배치에는 생성 목록이 없어 되돌릴 수 없습니다. 만들어진 자료를 직접 확인해 주세요.')
    }
    const ids = (k: string) => (created[k] ?? []).map((v) => BigInt(v))

    const orderIds = ids('orders')
    if (orderIds.length) {
      const led = await tx.depositLedger.count({ where: { orderId: { in: orderIds } } })
      if (led > 0) {
        throw new Error(
          `이 배치의 주문에 예치금 원장 ${led}건이 붙어 있습니다. `
          + '원장은 지울 수 없는 기록이라 배치를 되돌릴 수 없습니다. '
          + '반대부호 상쇄행으로 정리한 뒤 다시 시도하세요.',
        )
      }
      const invOrders = await tx.invoiceOrder.findMany({
        where: { orderId: { in: orderIds } }, select: { invoiceId: true },
      })
      await tx.invoiceOrder.deleteMany({ where: { orderId: { in: orderIds } } })
      if (invOrders.length) {
        const del = await tx.invoice.deleteMany({
          where: { id: { in: [...new Set(invOrders.map((i) => i.invoiceId))] } },
        })
        r.invoices = del.count
      }
      const allocs = await tx.expenseAllocation.findMany({
        where: { orderId: { in: orderIds } }, select: { expenseId: true },
      })
      await tx.expenseAllocation.deleteMany({ where: { orderId: { in: orderIds } } })
      if (allocs.length) {
        const del = await tx.expense.deleteMany({
          where: { id: { in: [...new Set(allocs.map((a) => a.expenseId))] } },
        })
        r.expenses += del.count
      }
      const receipts = await tx.receipt.findMany({
        where: { orderId: { in: orderIds } }, select: { id: true },
      })
      await tx.receiptSplit.deleteMany({ where: { receiptId: { in: receipts.map((x) => x.id) } } })
      const delR = await tx.receipt.deleteMany({ where: { orderId: { in: orderIds } } })
      r.receipts = delR.count
      const delO = await tx.order.deleteMany({ where: { id: { in: orderIds } } })
      r.orders = delO.count
    }

    const transferIds = ids('transfers')
    if (transferIds.length) {
      const del = await tx.internalTransfer.deleteMany({ where: { id: { in: transferIds } } })
      r.transfers = del.count
    }

    // 급여를 먼저 지워야 급여 지출 전표를 지울 수 있다
    const payrollIds = ids('payrolls')
    if (payrollIds.length) {
      const del = await tx.payroll.deleteMany({ where: { id: { in: payrollIds } } })
      r.payrolls = del.count
    }
    const opExpenseIds = ids('opExpenses')
    if (opExpenseIds.length) {
      const del = await tx.expense.deleteMany({ where: { id: { in: opExpenseIds } } })
      r.expenses += del.count
    }

    // 직원·거래처는 다른 자료에 물려 있으면 남긴다
    for (const id of ids('employees')) {
      const used = await tx.payroll.count({ where: { employeeId: id } })
      if (used > 0) { r.keptEmployees++; continue }
      await tx.employee.delete({ where: { id } })
      r.employees++
    }
    for (const id of ids('partners')) {
      const used = await tx.order.count({ where: { partnerId: id } })
        + await tx.receipt.count({ where: { partnerId: id } })
        + await tx.invoice.count({ where: { partnerId: id } })
        + await tx.depositLedger.count({ where: { partnerId: id } })
      if (used > 0) { r.keptPartners++; continue }
      await tx.partnerAlias.deleteMany({ where: { partnerId: id } })
      await tx.partner.delete({ where: { id } })
      r.partners++
    }

    await tx.importRow.updateMany({
      where: { batchId },
      data: { mapStatus: ImportRowStatus.SKIP, targetTable: null, targetId: null },
    })
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: ImportStatus.ROLLED_BACK },
    })
    await logAction(tx, 'import_batches', batchId, AuditAction.VOID, ctx, {
      oldValue: `주문 ${r.orders} · 입금 ${r.receipts} · 지출 ${r.expenses} · 계산서 ${r.invoices}`
        + ` · 자금이동 ${r.transfers} · 급여 ${r.payrolls}`,
      newValue: '되돌림',
    })
  }, { timeout: 1000 * 60 * 10, maxWait: 1000 * 30 })

  return r
}

/** E0001 부터 순서대로 */
async function nextEmployeeCode(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.employee.findFirst({
    where: { empCode: { startsWith: 'E' } },
    orderBy: { empCode: 'desc' },
    select: { empCode: true },
  })
  const n = last ? Number(last.empCode.slice(1)) + 1 : 1
  return `E${String(Number.isFinite(n) ? n : 1).padStart(4, '0')}`
}
