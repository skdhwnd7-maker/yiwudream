/**
 * 엑셀 → 시스템 변환 계획.
 *
 * 설계 문서: docs/07-엑셀마이그레이션.md 3장
 *
 * 이 단계에서는 DB 를 전혀 건드리지 않는다. 무엇을 만들지만 정해 놓고
 * 화면에서 사람이 확인한 다음 commit 에서 한 트랜잭션으로 넣는다.
 * 그래야 "넣어 보고 아니면 지운다" 가 아니라 "보고 나서 넣는다" 가 된다.
 */
import { Prisma, Route, Entity, Currency, SplitKind, ImportRowStatus } from '@prisma/client'
import type { WorkbookData, SheetData, Cell } from './read'
import {
  D, num, positive, text, partnerKey, splitTrailingNumber,
  toDate, parsePeriod, resolveFx, money, type FxSource,
} from './parse'

export const SHEET_OVERSEAS = '해외송금'
export const SHEET_GENERAL = '일반통장'
export const SHEET_CORP = '법인통장'
export const SHEET_OPS = 'Sheet1'

/** 자사 계정. 매출이 아니라 내부 자금이동이다 */
export const INTERNAL_NAME = '이우드림'

export type IssueLevel = 'ERROR' | 'WARN' | 'HOLD' | 'INFO'
export interface PlanIssue {
  level: IssueLevel
  code: string
  message: string
}

export interface PlannedExpense {
  categoryCode: string
  cny: Prisma.Decimal
  /** 원본 열 — 화면에서 "E열" 이라고 보여준다 */
  col: string
}

export interface PlannedSplit {
  kind: SplitKind
  amount: Prisma.Decimal
}

export interface PlannedOrder {
  sheet: string
  rowIndex: number
  /** 엑셀에 적힌 그대로 */
  partnerRaw: string
  partnerName: string
  partnerKey: string
  externalRef: string | null

  route: Route
  entity: Entity
  settlementCurrency: Currency
  dealTypeCode: string
  accountingClass: string

  orderDate: Date | null
  dateEstimated: boolean

  /** 입금이 없는 주문(미수)도 있다 */
  receiptAmount: Prisma.Decimal | null
  receiptCurrency: Currency
  amountKrw: Prisma.Decimal | null
  amountCny: Prisma.Decimal | null
  usdAmount: Prisma.Decimal | null
  fxRate: Prisma.Decimal | null
  fxSource: FxSource
  fxEvidence: string
  splits: PlannedSplit[]

  expenses: PlannedExpense[]

  /** 세금계산서를 같이 만들 것인가 */
  invoice: { supply: Prisma.Decimal; vat: Prisma.Decimal; total: Prisma.Decimal } | null
  memo: string | null

  /** 대조용 — 가져오지 않는다. 원본 마진과 재계산 마진을 비교만 한다 */
  excelMargin: Prisma.Decimal | null

  status: ImportRowStatus
  issues: PlanIssue[]
  /** 여러 엑셀 행을 하나로 묶은 미수금 주문 */
  mergedRows?: number[]
}

export interface PlannedTransfer {
  rowIndex: number
  date: Date | null
  dateEstimated: boolean
  usd: Prisma.Decimal | null
  cny: Prisma.Decimal | null
  fxUsdCny: Prisma.Decimal | null
  /** 거래처 칸이 비어 있던 행인가 — 화면에서 따로 세어 보여준다 */
  fromBlankRow: boolean
  issues: PlanIssue[]
}

export interface PlannedEmployee {
  rowIndex: number
  nameCn: string
  baseSalary: Prisma.Decimal | null
  actualPaid: Prisma.Decimal | null
  insurance: Prisma.Decimal | null
  issues: PlanIssue[]
}

export interface PlannedOpExpense {
  rowIndex: number
  categoryCode: string
  cny: Prisma.Decimal
  expenseDate: Date | null
  dateEstimated: boolean
  workDesc: string | null
  periodFrom: Date | null
  periodTo: Date | null
  periodRaw: string | null
  issues: PlanIssue[]
}

export interface PartnerPlan {
  key: string
  /** 대표 이름 — 가장 많이 나온 표기 */
  name: string
  /** 같은 키로 모인 원본 표기들 */
  variants: { raw: string; count: number }[]
  isInternal: boolean
  defaultRoute: Route | null
  orderCount: number
}

/**
 * 대조표 한 줄. 객체가 아니라 배열로 둔다 —
 * jsonb 는 키 순서를 보장하지 않아 저장했다 꺼내면 항목 순서가 뒤섞인다.
 */
export interface ReconRow {
  item: string
  excel: string
  system: string
}

export interface SheetTotals {
  sheet: string
  label: string
  rows: ReconRow[]
  /** 차이가 나는 이유 — 「넣지 않은 행이 이만큼」 을 숫자로 밝힌다 */
  note?: string
}

/**
 * 같은 경고가 수백 건 묶일 때 쓸 한 줄 설명.
 * 행별 메시지에는 그 행의 날짜·금액이 들어 있어 목록에 대표로 쓰면 오해를 부른다.
 */
export const ISSUE_SUMMARY: Record<string, string> = {
  DATE_FILLED: '일자가 비어 바로 윗행의 날짜를 끌어왔습니다. 주문에 「추정」 표시가 붙습니다.',
  DATE_MISSING: '일자를 알 수 없고 끌어올 윗행도 없습니다.',
  PARTNER_MISSING: '거래처가 비어 있습니다.',
  MAYBE_INTERNAL: '거래처가 비었고 지출도 없이 USD→CNY 만 있습니다. 중국 송금 행으로 보입니다.',
  INTERNAL_BLANK: '거래처 칸이 비어 있지만 한국 통장에 모인 돈을 중국으로 보낸 행입니다. '
    + '매출이 아니라 중국 송금으로 넣습니다.',
  FX_DERIVED: 'D열에 수식이 없어 입금액 ÷ CNY 로 환율을 역산했습니다.',
  FX_MISSING: '환율 근거가 없습니다. 확인한 뒤에 넣어야 합니다.',
  FORMULA_XREF: 'D열 수식이 자기 행이 아닌 다른 행을 참조합니다.',
  VAT_UNBILLED: '세금계산서 미발행 건입니다. 부가세를 받은 것으로 기록하고 '
    + '「미발행·부가세 수취」 목록에 올립니다. 세무 판단은 하지 않습니다.',
  VAT_RATIO: 'M ÷ C 가 1.1 이 아닙니다. 금액을 확인해 주세요.',
  VAT_NONPOSITIVE: 'M 이 C 보다 크지 않아 부가세를 분리하지 못했습니다.',
  MARGIN_DIFF: '엑셀 마진과 재계산 마진이 다릅니다. 마진은 가져오지 않고 시스템이 다시 계산합니다.',
  RECEIVABLE: '입금 없이 지출만 있던 행입니다. 거래처별로 미수금 주문 하나에 묶었습니다.',
  INTERNAL: '자사 계정입니다. 매출이 아니라 내부 자금이동으로 넣습니다.',
  PERIOD_YEAR_ASSUMED: '임시공 기간에 연도가 없어 기준연도로 읽었습니다.',
  PERIOD_UNPARSED: '임시공 기간을 날짜로 읽지 못했습니다.',
  OFFICE_NO_DATE: 'J열이 날짜가 아니라 내용입니다. 위 설정에서 정한 지출일로 넣습니다.',
  INSURANCE_ORPHAN: '사회보험 금액에 직원이 지정되어 있지 않습니다. 급여 귀속월로 넣습니다.',
  NO_PAY: '이 달 급여가 비어 있습니다. 직원만 등록하고 급여는 만들지 않습니다.',
  NO_ACTUAL: '실지급(C)이 비어 기본급(B)을 실지급으로 씁니다.',
  BASE_NE_ACTUAL: '기본급 ≠ 실지급. 시스템은 실지급 기준으로 집계합니다.',
  USD_OUTLIER: 'USD 가 CNY 도착금액보다 큽니다. 자릿수를 확인해 주세요.',
}

/** Sheet1 항목이 어느 달에 들어가는지 — 「9月总合」 에 12~2월이 섞여 있어 따로 보여준다 */
export interface OpsMonthRow {
  ym: string
  label: string
  items: { category: string; count: number; cny: string }[]
  totalCny: string
}

export interface ImportPlan {
  orders: PlannedOrder[]
  transfers: PlannedTransfer[]
  employees: PlannedEmployee[]
  opExpenses: PlannedOpExpense[]
  partners: PartnerPlan[]
  /** 병합 후보 — 자동으로 합치지 않는다 */
  mergeCandidates: { key: string; variants: { raw: string; count: number }[] }[]
  skipped: { sheet: string; rowCount: number; reason: string }[]
  totals: SheetTotals[]
  opsMonths: OpsMonthRow[]
  counts: { ok: number; warn: number; error: number; hold: number; skip: number }
}

const OP_LABEL: Record<string, string> = {
  SALARY: '직원 급여', INSURANCE: '사회보험', TEMP_LABOR: '임시공', OFFICE: '사무실 경비',
}

/**
 * 중국 운영비를 귀속월별로 묶는다.
 *
 * 엑셀 Sheet1 은 제목이 `9月总合` 인데 임시공 기간은 12~1월, 사무실 경비 날짜는 1~2월,
 * 거기에 8~9월 항목까지 섞여 있다. 한 달로 뭉뚱그리지 않고 각자 제 달로 보낸다 —
 * 그래야 월별 대시보드의 운영비가 맞는다. 어느 달로 가는지 넣기 전에 보여 준다.
 */
function buildOpsMonths(
  employees: PlannedEmployee[], opExpenses: PlannedOpExpense[], payrollYm: string,
): OpsMonthRow[] {
  const byYm = new Map<string, Map<string, { count: number; cny: Prisma.Decimal }>>()
  const add = (ym: string, category: string, cny: Prisma.Decimal) => {
    const cats = byYm.get(ym) ?? new Map()
    const cur = cats.get(category) ?? { count: 0, cny: D(0) }
    cur.count += 1
    cur.cny = cur.cny.plus(cny)
    cats.set(category, cur)
    byYm.set(ym, cats)
  }
  const ymOf = (d: Date | null) =>
    d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '(미상)'

  for (const e of employees) {
    if (e.actualPaid && e.actualPaid.gt(0)) add(payrollYm, 'SALARY', e.actualPaid)
    if (e.insurance && e.insurance.gt(0)) add(payrollYm, 'INSURANCE', e.insurance)
  }
  for (const e of opExpenses) add(ymOf(e.expenseDate), e.categoryCode, e.cny)

  return [...byYm.entries()]
    .map(([ym, cats]) => {
      const items = [...cats.entries()]
        .map(([category, v]) => ({
          category: OP_LABEL[category] ?? category, count: v.count, cny: fmt(v.cny),
        }))
        .sort((a, b) => a.category.localeCompare(b.category, 'ko'))
      const total = [...cats.values()].reduce((s2, v) => s2.plus(v.cny), D(0))
      const m = /^(\d{4})-(\d{2})$/.exec(ym)
      return {
        ym,
        label: m ? `${m[1]}년 ${m[2]}월` : '지출일 미상',
        items,
        totalCny: fmt(total),
      }
    })
    .sort((a, b) => a.ym.localeCompare(b.ym))
}

export interface PlanOptions {
  sheets: string[]
  /** Sheet1 임시공 기간에 쓸 기준연도 — 연도가 안 적혀 있어 사람이 고른다 */
  opsBaseYear: number
  /** 급여 귀속월 `YYYY-MM` — 엑셀이 `9月总合` 인데 내용은 12~2월이라 사람이 정한다 */
  payrollYm: string
  /**
   * 해외송금(CNY) 행을 KRW 로 표시할 때 쓸 환산환율.
   *
   * 해외송금은 CNY 로 정산하므로 마진·원가 계산에는 환율이 전혀 쓰이지 않는다.
   * 다만 대시보드에서 원화로 합산해 보여줄 때 숫자가 하나는 있어야 해서 받는다.
   * 프로그램이 지어내지 않고 담당자가 넣은 값을 그대로 기록한다.
   */
  cnyDisplayRate: string
  /**
   * 거래처 칸이 비고 지출 없이 USD→CNY 만 있는 행을 중국 송금으로 넣을 것인가.
   *
   * 대표님 확인: 법인·일반·사이트 통장에 모인 돈을 중국으로 보낸 내용입니다.
   * 매출로 잡으면 거래액이 CNY 5,654,262 만큼 부풀어 오르므로 기본으로 켜 둡니다.
   */
  blankRowsAreRemittance: boolean
  /** 중국 송금이 빠져나간 한국 계좌 */
  remitFromRoute: Route | null
  /** 송금액을 원화로 환산할 USD→KRW 환율. 비우면 원화 금액을 기록하지 않는다 */
  usdKrwRate: string
  /** 날짜 대신 내용이 적힌 사무실 경비에 쓸 지출일 */
  officeFallbackDate: string
}

const cell = (cells: Cell[], i: number): Cell => cells[i] ?? { value: null, formula: null }

/** 시트에서 헤더 아래 데이터 행만 꺼낸다 */
function dataRows(sheet: SheetData, headerRow: number) {
  return sheet.rows.filter((r) => r.rowIndex > headerRow)
}

/** 셀이 전부 비었거나 수식 껍데기만 남은 꼬리 행인가 */
function isEmptyRow(cells: Cell[], valueCols: number[]): boolean {
  return valueCols.every((i) => cell(cells, i).value === null)
}

// ─────────────────────────────────────────────────────────────────────
// 거래처 수집
// ─────────────────────────────────────────────────────────────────────

class PartnerCollector {
  private map = new Map<string, { counts: Map<string, number>; routes: Map<Route, number> }>()

  add(raw: string, route: Route) {
    const key = partnerKey(raw)
    const { name } = splitTrailingNumber(raw)
    const e = this.map.get(key) ?? { counts: new Map(), routes: new Map() }
    e.counts.set(name, (e.counts.get(name) ?? 0) + 1)
    e.routes.set(route, (e.routes.get(route) ?? 0) + 1)
    this.map.set(key, e)
  }

  finish(orderCounts: Map<string, number>): PartnerPlan[] {
    const out: PartnerPlan[] = []
    for (const [key, e] of this.map) {
      const variants = [...e.counts.entries()]
        .map(([raw, count]) => ({ raw, count }))
        .sort((a, b) => b.count - a.count)
      const defaultRoute = [...e.routes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      out.push({
        key,
        name: variants[0].raw,
        variants,
        isInternal: variants[0].raw.replace(/\s/g, '') === INTERNAL_NAME,
        defaultRoute,
        orderCount: orderCounts.get(key) ?? 0,
      })
    }
    return out.sort((a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name, 'ko'))
  }
}

// ─────────────────────────────────────────────────────────────────────
// 시트별 변환
// ─────────────────────────────────────────────────────────────────────

interface RowCtx {
  sheet: string
  rowIndex: number
  issues: PlanIssue[]
}

function warn(ctx: RowCtx, code: string, message: string) {
  ctx.issues.push({ level: 'WARN', code, message })
}
function err(ctx: RowCtx, code: string, message: string) {
  ctx.issues.push({ level: 'ERROR', code, message })
}
function hold(ctx: RowCtx, code: string, message: string) {
  ctx.issues.push({ level: 'HOLD', code, message })
}

function statusOf(issues: PlanIssue[]): ImportRowStatus {
  if (issues.some((i) => i.level === 'ERROR')) return ImportRowStatus.ERROR
  if (issues.some((i) => i.level === 'HOLD')) return ImportRowStatus.HOLD
  if (issues.some((i) => i.level === 'WARN')) return ImportRowStatus.WARN
  return ImportRowStatus.OK
}

/** 지출 열 묶음. [열 인덱스, 비용분류 코드, 열 문자] */
type CostCols = [number, string, string][]

function collectCosts(cells: Cell[], cols: CostCols): PlannedExpense[] {
  const out: PlannedExpense[] = []
  for (const [i, code, col] of cols) {
    const v = positive(cell(cells, i).value)
    if (v) out.push({ categoryCode: code, cny: money(v), col })
  }
  return out
}

/**
 * 해외송금 시트.
 * 헤더 3행, 데이터 4행부터. A일자 B거래처 C USD D CNY도착 E CNY지출 F인건비 G기타비 H마진 I% J메모
 *
 * ⭐ B열이 `이우드림` 인 행은 매출이 아니라 자사 자금이동이다. 주문을 만들지 않는다.
 */
function planOverseas(
  sheet: SheetData, pc: PartnerCollector, opts: PlanOptions,
): { orders: PlannedOrder[]; transfers: PlannedTransfer[]; skippedRows: number } {
  const orders: PlannedOrder[] = []
  const transfers: PlannedTransfer[] = []
  let skippedRows = 0
  let lastDate: Date | null = null

  const costCols: CostCols = [[4, 'GOODS', 'E'], [5, 'LABOR_CN', 'F'], [6, 'ETC_ORDER', 'G']]

  for (const { rowIndex, cells } of dataRows(sheet, 3)) {
    if (isEmptyRow(cells, [0, 1, 2, 3, 4, 5, 6])) { skippedRows++; continue }

    const ctx: RowCtx = { sheet: sheet.name, rowIndex, issues: [] }

    // A열 — 누락되면 직전 행 값을 끌어온다. 지어낸 값이므로 반드시 표시한다
    let orderDate = toDate(cell(cells, 0).value)
    let dateEstimated = false
    if (orderDate) lastDate = orderDate
    else if (lastDate) {
      orderDate = lastDate
      dateEstimated = true
      warn(ctx, 'DATE_FILLED', `일자가 비어 직전 행(${lastDate.toISOString().slice(0, 10)})을 끌어왔습니다.`)
    } else {
      err(ctx, 'DATE_MISSING', '일자를 알 수 없고 끌어올 직전 행도 없습니다.')
    }

    const partnerRaw = text(cell(cells, 1).value)
    const usd = positive(cell(cells, 2).value)
    const arrivalRaw = positive(cell(cells, 3).value)
    const arrival = arrivalRaw ? money(arrivalRaw) : null

    const isNamedInternal = !!partnerRaw && partnerRaw.replace(/\s/g, '') === INTERNAL_NAME
    const hasCosts = collectCosts(cells, costCols).length > 0

    // ⭐ 거래처 칸이 비었는데 USD·CNY 만 있고 지출이 없는 행.
    //    대표님 확인: 법인·일반·사이트 통장에 모인 돈을 중국으로 보낸 것입니다.
    //    「이우드림」 이라고 적힌 행과 같은 내용인데 이름만 빠뜨린 것이라, 같이 처리합니다.
    const looksLikeRemit = !partnerRaw && !!usd && !!arrival && !hasCosts
    const isBlankInternal = looksLikeRemit && opts.blankRowsAreRemittance

    if (!partnerRaw && !isBlankInternal) {
      if (!arrival && !hasCosts) { skippedRows++; continue }
      err(ctx, 'PARTNER_MISSING', '거래처가 비어 있습니다.')
      if (looksLikeRemit) {
        hold(ctx, 'MAYBE_INTERNAL',
          `USD ${usd!.toString()} → CNY ${arrival!.toString()}, 지출 없음 — 중국 송금 행으로 보입니다. `
          + '위 설정에서 「거래처가 빈 송금 행도 중국 송금으로 넣기」 를 켜시면 들어갑니다.')
      }
    }

    // ⭐ 회사 돈을 중국으로 보낸 것 — 매출이 아니다
    if (isNamedInternal || isBlankInternal) {
      const tIssues: PlanIssue[] = [...ctx.issues.filter((i) => i.code !== 'PARTNER_MISSING'), {
        level: 'INFO' as const,
        code: isNamedInternal ? 'INTERNAL' : 'INTERNAL_BLANK',
        message: isNamedInternal
          ? '자사 계정입니다. 매출이 아니라 중국 송금(내부 자금이동)으로 넣습니다.'
          : '거래처가 비어 있고 지출 없이 USD→CNY 만 있습니다. '
            + '한국 통장에 모인 돈을 중국으로 보낸 것으로 보아 중국 송금으로 넣습니다.',
      }]
      transfers.push({
        rowIndex, date: orderDate, dateEstimated, usd, cny: arrival,
        fxUsdCny: usd && arrival && usd.gt(0) ? arrival.div(usd).toDecimalPlaces(6) : null,
        fromBlankRow: isBlankInternal,
        issues: tIssues,
      })
      continue
    }

    const { name, externalRef } = splitTrailingNumber(partnerRaw ?? '(미상)')
    if (partnerRaw) pc.add(partnerRaw, Route.OVERSEAS)

    const expenses = collectCosts(cells, costCols)

    // USD 이상치 — 65행의 22,446,983.52 같은 값
    if (usd && arrival && usd.gt(arrival)) {
      warn(ctx, 'USD_OUTLIER',
        `USD(${usd.toString()})가 CNY 도착금액(${arrival.toString()})보다 큽니다. 자릿수를 확인하세요.`)
    }

    orders.push({
      sheet: sheet.name, rowIndex,
      partnerRaw: partnerRaw ?? '(미상)', partnerName: name, partnerKey: partnerKey(partnerRaw ?? ''),
      externalRef,
      route: Route.OVERSEAS, entity: Entity.CN, settlementCurrency: Currency.CNY,
      dealTypeCode: 'OVERSEAS_DIRECT', accountingClass: '상품매출',
      orderDate, dateEstimated,
      receiptAmount: arrival, receiptCurrency: Currency.CNY,
      amountKrw: null, amountCny: arrival, usdAmount: usd,
      fxRate: null, fxSource: 'NONE',
      fxEvidence: 'CNY 정산이라 환율이 필요 없습니다.',
      splits: arrival ? [{ kind: SplitKind.SALES, amount: arrival }] : [],
      expenses,
      invoice: null,
      memo: text(cell(cells, 9).value),
      excelMargin: num(cell(cells, 7).value),
      status: statusOf(ctx.issues), issues: ctx.issues,
    })
  }
  return { orders, transfers, skippedRows }
}

/**
 * 일반통장 시트.
 * 헤더 2행, 데이터 3행부터. A일자 B거래처 C KRW입금 D CNY(수식) E지출 F통관 G인건 H기타 I마진 J% K메모
 *
 * ⭐ 대표님 확인: 일반통장은 부가세와 무관하다. C열이 그대로 입금액이고 전액 SALES 다.
 */
function planGeneral(
  sheet: SheetData, pc: PartnerCollector,
): { orders: PlannedOrder[]; skippedRows: number } {
  const orders: PlannedOrder[] = []
  let skippedRows = 0
  let lastDate: Date | null = null

  const costCols: CostCols = [
    [4, 'GOODS', 'E'], [5, 'CUSTOMS', 'F'], [6, 'LABOR_CN', 'G'], [7, 'ETC_ORDER', 'H'],
  ]

  for (const { rowIndex, cells } of dataRows(sheet, 2)) {
    if (isEmptyRow(cells, [0, 1, 2, 3, 4, 5, 6, 7])) { skippedRows++; continue }

    const ctx: RowCtx = { sheet: sheet.name, rowIndex, issues: [] }

    let orderDate = toDate(cell(cells, 0).value)
    let dateEstimated = false
    if (orderDate) lastDate = orderDate
    else if (lastDate) {
      orderDate = lastDate; dateEstimated = true
      warn(ctx, 'DATE_FILLED', `일자가 비어 직전 행(${lastDate.toISOString().slice(0, 10)})을 끌어왔습니다.`)
    } else {
      err(ctx, 'DATE_MISSING', '일자를 알 수 없고 끌어올 직전 행도 없습니다.')
    }

    const partnerRaw = text(cell(cells, 1).value)
    const krwRaw = positive(cell(cells, 2).value)
    const krw = krwRaw ? money(krwRaw) : null
    const dCell = cell(cells, 3)
    const cnyRaw = positive(dCell.value)
    const cny = cnyRaw ? money(cnyRaw) : null
    const expenses = collectCosts(cells, costCols)

    if (!partnerRaw) {
      if (!krw && expenses.length === 0) { skippedRows++; continue }
      err(ctx, 'PARTNER_MISSING', '거래처가 비어 있습니다.')
    }
    if (partnerRaw) pc.add(partnerRaw, Route.BANK_GEN)

    // ⭐ 환율은 D열 수식에만 있다. 헤더의 `환율적용 192` 는 쓰지 않는다
    const fx = resolveFx(dCell.formula, krw, cny)
    if (krw && fx.source === 'DERIVED') {
      warn(ctx, 'FX_DERIVED', `D열에 수식이 없어 환율을 역산했습니다 — ${fx.evidence}`)
    }
    if (krw && fx.source === 'NONE') {
      hold(ctx, 'FX_MISSING', '환율 근거가 없습니다. 환율을 확인한 뒤 넣어야 합니다.')
    }

    const { name, externalRef } = splitTrailingNumber(partnerRaw ?? '(미상)')

    orders.push({
      sheet: sheet.name, rowIndex,
      partnerRaw: partnerRaw ?? '(미상)', partnerName: name, partnerKey: partnerKey(partnerRaw ?? ''),
      externalRef,
      route: Route.BANK_GEN, entity: Entity.KR, settlementCurrency: Currency.KRW,
      dealTypeCode: 'GEN_DEPOSIT', accountingClass: '상품매출',
      orderDate, dateEstimated,
      receiptAmount: krw, receiptCurrency: Currency.KRW,
      amountKrw: krw, amountCny: cny, usdAmount: null,
      fxRate: fx.rate, fxSource: fx.source, fxEvidence: fx.evidence,
      splits: krw ? [{ kind: SplitKind.SALES, amount: krw }] : [],
      expenses,
      invoice: null,
      memo: text(cell(cells, 10).value),
      excelMargin: num(cell(cells, 8).value),
      status: statusOf(ctx.issues), issues: ctx.issues,
    })
  }
  return { orders, skippedRows }
}

/**
 * 법인통장 시트.
 * 헤더 2행, 데이터 3행부터.
 * A일자 B거래처 C공급가액 D CNY(수식) E지출 F통관 G인건 H기타 I마진 J% K메모 L(빈) M실제입금 N(=M/1.1)
 *
 * ⭐⭐ 헤더가 틀렸다. C는 "KRW 입금액" 이 아니라 **부가세를 뺀 공급가액**이고,
 *     실제 입금액은 M열이다 (대표님 확인). 그대로 가져오면 통장 잔액이 부가세만큼 모자란다.
 *     M이 비어 있는 369건도 부가세는 받으셨으므로 C × 1.1 을 입금액으로 본다.
 */
function planCorp(
  sheet: SheetData, pc: PartnerCollector,
): { orders: PlannedOrder[]; skippedRows: number } {
  const orders: PlannedOrder[] = []
  let skippedRows = 0
  let lastDate: Date | null = null

  const costCols: CostCols = [
    [4, 'GOODS', 'E'], [5, 'CUSTOMS', 'F'], [6, 'LABOR_CN', 'G'], [7, 'ETC_ORDER', 'H'],
  ]

  for (const { rowIndex, cells } of dataRows(sheet, 2)) {
    if (isEmptyRow(cells, [0, 1, 2, 3, 4, 5, 6, 7, 12])) { skippedRows++; continue }

    const ctx: RowCtx = { sheet: sheet.name, rowIndex, issues: [] }

    let orderDate = toDate(cell(cells, 0).value)
    let dateEstimated = false
    if (orderDate) lastDate = orderDate
    else if (lastDate) {
      orderDate = lastDate; dateEstimated = true
      warn(ctx, 'DATE_FILLED', `일자가 비어 직전 행(${lastDate.toISOString().slice(0, 10)})을 끌어왔습니다.`)
    } else {
      err(ctx, 'DATE_MISSING', '일자를 알 수 없고 끌어올 직전 행도 없습니다.')
    }

    const partnerRaw = text(cell(cells, 1).value)
    const supplyRaw = positive(cell(cells, 2).value)   // C — 공급가액
    const supply = supplyRaw ? money(supplyRaw) : null
    const dCell = cell(cells, 3)
    const cnyRaw = positive(dCell.value)
    const cny = cnyRaw ? money(cnyRaw) : null
    const actualRaw = positive(cell(cells, 12).value)  // M — 실제 입금액
    const actual = actualRaw ? money(actualRaw) : null
    const expenses = collectCosts(cells, costCols)

    if (!partnerRaw) {
      if (!supply && expenses.length === 0) { skippedRows++; continue }
      err(ctx, 'PARTNER_MISSING', '거래처가 비어 있습니다.')
    }
    if (partnerRaw) pc.add(partnerRaw, Route.BANK_CORP)

    const fx = resolveFx(dCell.formula, supply, cny)
    if (supply && fx.source === 'DERIVED') {
      warn(ctx, 'FX_DERIVED', `D열에 수식이 없어 환율을 역산했습니다 — ${fx.evidence}`)
    }
    if (supply && fx.source === 'NONE') {
      hold(ctx, 'FX_MISSING', '환율 근거가 없습니다. 환율을 확인한 뒤 넣어야 합니다.')
    }
    // 수식이 이 행이 아닌 다른 행을 참조하는 경우 (319행 E321 참조)
    if (dCell.formula && !new RegExp(`[A-Z]+\\$?${rowIndex}\\s*/`).test(dCell.formula)) {
      warn(ctx, 'FORMULA_XREF', `D열 수식이 다른 행을 참조합니다 — ${dCell.formula}`)
    }

    const { name, externalRef } = splitTrailingNumber(partnerRaw ?? '(미상)')

    let receiptAmount: Prisma.Decimal | null = null
    let splits: PlannedSplit[] = []
    let invoice: PlannedOrder['invoice'] = null
    let dealTypeCode = 'CORP_NOBILL'

    if (supply) {
      if (actual) {
        // 세금계산서를 끊은 건 — M 이 실제 입금액, M − C 가 부가세
        const vat = actual.minus(supply)
        receiptAmount = actual
        splits = vat.gt(0)
          ? [{ kind: SplitKind.SALES, amount: supply }, { kind: SplitKind.VAT, amount: vat }]
          : [{ kind: SplitKind.SALES, amount: actual }]
        if (vat.lte(0)) {
          warn(ctx, 'VAT_NONPOSITIVE',
            `M(${actual.toString()})이 C(${supply.toString()})보다 크지 않아 부가세를 분리하지 못했습니다.`)
        } else {
          const ratio = actual.div(supply)
          if (ratio.minus(D('1.1')).abs().gt(D('0.01'))) {
            warn(ctx, 'VAT_RATIO',
              `M ÷ C = ${ratio.toDecimalPlaces(4).toString()} 로 1.1 이 아닙니다. 금액을 확인하세요.`)
          }
          invoice = { supply, vat, total: actual }
        }
        dealTypeCode = 'CORP_FULL'
      } else {
        // ✅ 대표님 확인: 미발행 건도 부가세는 받으셨다
        // 입금액을 먼저 2자리로 확정하고 부가세는 그 차액으로 둔다 — 합이 어긋나지 않는다
        receiptAmount = money(supply.mul(D('1.1')))
        const vat = receiptAmount.minus(supply)
        splits = [{ kind: SplitKind.SALES, amount: supply }, { kind: SplitKind.VAT, amount: vat }]
        dealTypeCode = 'CORP_NOBILL'
        ctx.issues.push({
          level: 'INFO', code: 'VAT_UNBILLED',
          message: `세금계산서 미발행 건입니다. 부가세 ${vat.toString()}원을 받은 것으로 기록하고 `
            + `'미발행·부가세 수취' 목록에 올립니다. 세무 판단은 하지 않습니다.`,
        })
      }
    }

    orders.push({
      sheet: sheet.name, rowIndex,
      partnerRaw: partnerRaw ?? '(미상)', partnerName: name, partnerKey: partnerKey(partnerRaw ?? ''),
      externalRef,
      route: Route.BANK_CORP, entity: Entity.KR, settlementCurrency: Currency.KRW,
      dealTypeCode, accountingClass: '상품매출',
      orderDate, dateEstimated,
      receiptAmount, receiptCurrency: Currency.KRW,
      amountKrw: receiptAmount, amountCny: cny, usdAmount: null,
      fxRate: fx.rate, fxSource: fx.source, fxEvidence: fx.evidence,
      splits,
      expenses,
      invoice,
      memo: text(cell(cells, 10).value),
      excelMargin: num(cell(cells, 8).value),
      status: statusOf(ctx.issues), issues: ctx.issues,
    })
  }
  return { orders, skippedRows }
}

/**
 * Sheet1 — 중국 운영비 4갈래.
 * 옆으로 나란한 블록이라 열 묶음별로 따로 훑는다.
 *   A직원명 B기본급 C실지급 D社保 │ F임시공기간 G임시공금액 │ J사무실경비(날짜/내용) K금액
 *
 * ⭐ 엑셀 합계는 기본급(B) 기준인데 실제로 나간 돈은 실지급(C)이다. 시스템은 C를 쓴다.
 *    그래서 합계가 4,850 CNY 차이나며, 이는 오류가 아니라 의도된 차이다.
 */
/** `2026-09` → 그 달 1일. 귀속월만 정해지면 날짜는 여기서 만든다 */
function payrollMonthDate(ym: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, 1)
}

function planOps(
  sheet: SheetData, opts: PlanOptions,
): { employees: PlannedEmployee[]; opExpenses: PlannedOpExpense[]; skippedRows: number } {
  const employees: PlannedEmployee[] = []
  const opExpenses: PlannedOpExpense[] = []
  let skippedRows = 0
  // 임시공 기간은 위에서 아래로 이어진다. 앞 기간의 끝을 들고 다니며 해 넘김을 판단한다
  let periodYear = opts.opsBaseYear
  let lastPeriodEnd: Date | null = null

  for (const { rowIndex, cells } of dataRows(sheet, 1)) {
    const first = text(cell(cells, 0).value)
    // 合计 / 9月总合 행은 가져오지 않는다 — 재계산이 맞다
    if (first && /合[计計]|总合|합계|계$/.test(first)) { skippedRows++; continue }

    const ctx: RowCtx = { sheet: sheet.name, rowIndex, issues: [] }

    // ── 급여 블록 (A~D)
    const nameCn = first
    const base = positive(cell(cells, 1).value)
    const actual = positive(cell(cells, 2).value)
    const insurance = positive(cell(cells, 3).value)

    if (nameCn) {
      const eIssues: PlanIssue[] = []
      if (!actual && !base) {
        eIssues.push({
          level: 'INFO', code: 'NO_PAY',
          message: '이 달 급여가 비어 있습니다. 직원만 등록하고 급여는 만들지 않습니다.',
        })
      } else if (!actual) {
        eIssues.push({
          level: 'WARN', code: 'NO_ACTUAL',
          message: '실지급(C)이 비어 기본급(B)을 실지급으로 씁니다.',
        })
      } else if (base && !base.equals(actual)) {
        eIssues.push({
          level: 'INFO', code: 'BASE_NE_ACTUAL',
          message: `기본급 ${base.toString()} ≠ 실지급 ${actual.toString()}. 시스템은 실지급 기준으로 집계합니다.`,
        })
      }
      employees.push({
        rowIndex, nameCn,
        baseSalary: base, actualPaid: actual ?? base, insurance,
        issues: eIssues,
      })
    } else if (insurance) {
      // D2 의 1,416 처럼 직원 없이 금액만 있는 칸.
      // 막아 버리면 사회보험 합계가 엑셀과 안 맞는다. 넣되 「직원 미지정」 이라고 남긴다.
      opExpenses.push({
        rowIndex, categoryCode: 'INSURANCE', cny: insurance,
        expenseDate: payrollMonthDate(opts.payrollYm), dateEstimated: true,
        workDesc: '사회보험 (직원 미지정)', periodFrom: null, periodTo: null, periodRaw: null,
        issues: [{
          level: 'WARN', code: 'INSURANCE_ORPHAN',
          message: `사회보험 ${insurance.toString()} 에 직원이 지정되어 있지 않습니다. `
            + '금액은 그대로 넣고 급여 귀속월로 잡습니다. 누구 것인지 확인되면 고쳐 주세요.',
        }],
      })
    }

    // ── 임시공 블록 (F~G)
    const periodRaw = text(cell(cells, 5).value)
    const tempAmt = positive(cell(cells, 6).value)
    if (tempAmt) {
      const tIssues: PlanIssue[] = []
      let from: Date | null = null, to: Date | null = null
      if (periodRaw) {
        // 엑셀의 임시공 기간은 연달아 이어지는 주다 (12/28-1/3, 1/4-1/10, …).
        // 기준연도를 행마다 그대로 쓰면 12/28 은 2026년 1월로 넘어가고 그 다음 1/4 는
        // 2025년 1월로 돌아가 버린다 — 한 해가 벌어진다.
        // 앞 기간보다 뒤에 오도록 필요한 만큼 해를 넘긴다.
        let p = parsePeriod(periodRaw, periodYear)
        if (p && lastPeriodEnd && p.from < lastPeriodEnd) {
          periodYear += 1
          p = parsePeriod(periodRaw, periodYear)
        }
        if (p) {
          from = p.from; to = p.to
          lastPeriodEnd = p.to
          tIssues.push({
            level: 'WARN', code: 'PERIOD_YEAR_ASSUMED',
            message: `기간 "${periodRaw}" 에 연도가 없어 ${from.toISOString().slice(0, 10)} ~ `
              + `${to.toISOString().slice(0, 10)} 로 읽었습니다 (기준연도 ${opts.opsBaseYear}).`,
          })
        } else {
          tIssues.push({
            level: 'HOLD', code: 'PERIOD_UNPARSED',
            message: `기간 "${periodRaw}" 를 날짜로 읽지 못했습니다.`,
          })
        }
      }
      opExpenses.push({
        rowIndex, categoryCode: 'TEMP_LABOR', cny: tempAmt,
        expenseDate: to ?? from, dateEstimated: !!from,
        workDesc: periodRaw ? `임시공 ${periodRaw}` : '임시공',
        periodFrom: from, periodTo: to, periodRaw,
        issues: tIssues,
      })
    }

    // ── 사무실 경비 블록 (J~K) — 날짜 시리얼과 텍스트가 섞여 있다
    const officeRaw = cell(cells, 9).value
    const officeAmt = positive(cell(cells, 10).value)
    if (officeAmt) {
      const oIssues: PlanIssue[] = []
      const asDate = typeof officeRaw === 'number' || officeRaw instanceof Date
        ? toDate(officeRaw) : null
      const asText = asDate ? null : text(officeRaw)
      // J열에 날짜 대신 「박스비8/9월」 같은 내용이 적힌 행이 있다.
      // 금액은 분명히 나간 돈이므로 버리지 않는다. 담당자가 정한 날짜로 넣고 내용은 그대로 남긴다.
      const fallback = asDate ? null : toDate(opts.officeFallbackDate)
      if (!asDate) {
        oIssues.push({
          level: fallback ? 'WARN' : 'HOLD', code: 'OFFICE_NO_DATE',
          message: (asText
            ? `J열이 날짜가 아니라 "${asText}" 라는 내용입니다.`
            : 'J열이 비어 지출일을 알 수 없습니다.')
            + (fallback
              ? ` 위 설정의 지출일(${fallback.toISOString().slice(0, 10)})로 넣고 내용은 그대로 남깁니다.`
              : ' 위 설정에서 지출일을 정해 주시면 넣습니다.'),
        })
      }
      opExpenses.push({
        rowIndex, categoryCode: 'OFFICE', cny: officeAmt,
        expenseDate: asDate ?? fallback, dateEstimated: !asDate,
        workDesc: asText ?? '사무실 경비',
        periodFrom: null, periodTo: null, periodRaw: null,
        issues: oIssues,
      })
    }
  }
  return { employees, opExpenses, skippedRows }
}

// ─────────────────────────────────────────────────────────────────────
// 미수금 묶기
// ─────────────────────────────────────────────────────────────────────

/**
 * 입금이 한 푼도 없고 지출만 있는 행들을 거래처·루트별로 한 주문에 묶는다.
 *
 * 설계 문서 3-7: 예치금 이월이 없으므로 이 돈은 갈 곳이 **미수금** 뿐이다.
 * 행마다 주문을 따로 만들면 적자 주문이 수백 건 생기고, 버리면 나간 돈이 사라진다.
 * 묶어 두면 자금현황의 '받을 돈' 에 그대로 잡히고, 나중에 입금이 들어오면 붙여 소진시킨다.
 */
function foldReceivables(orders: PlannedOrder[]): PlannedOrder[] {
  const kept: PlannedOrder[] = []
  const groups = new Map<string, PlannedOrder>()

  for (const o of orders) {
    const hasMoneyIn = o.receiptAmount !== null && o.receiptAmount.gt(0)
    if (hasMoneyIn || o.expenses.length === 0) { kept.push(o); continue }

    const gk = `${o.sheet}|${o.partnerKey}`
    const g = groups.get(gk)
    if (!g) {
      groups.set(gk, {
        ...o,
        externalRef: null,
        memo: `엑셀 ${o.sheet} 시트에서 입금 없이 지출만 있던 행들을 묶은 미수금 주문입니다.`,
        excelMargin: null,
        expenses: [...o.expenses],
        mergedRows: [o.rowIndex],
        issues: [{
          level: 'WARN', code: 'RECEIVABLE',
          message: '입금이 없어 미수금 주문으로 묶었습니다. 입금이 들어오면 이 주문에 연결해 소진시키세요.',
        }],
        status: ImportRowStatus.WARN,
      })
    } else {
      g.expenses.push(...o.expenses)
      g.mergedRows!.push(o.rowIndex)
      // 가장 이른 날짜를 주문일로 둔다
      if (o.orderDate && (!g.orderDate || o.orderDate < g.orderDate)) {
        g.orderDate = o.orderDate
        g.dateEstimated = o.dateEstimated
      }
    }
  }

  for (const g of groups.values()) {
    const total = g.expenses.reduce((s, e) => s.plus(e.cny), D(0))
    g.issues[0].message =
      `입금 없이 지출만 있던 ${g.mergedRows!.length}건(CNY ${total.toString()})을 미수금 주문 하나로 묶었습니다. `
      + '자금현황의 「받을 돈」에 잡히며, 입금이 들어오면 이 주문에 연결해 소진시키세요.'
    kept.push(g)
  }
  return kept
}

// ─────────────────────────────────────────────────────────────────────
// 대조표
// ─────────────────────────────────────────────────────────────────────

/** 시트의 한 열을 통째로 더한다 — 엑셀 원본 합계 */
function colSum(sheet: SheetData, headerRow: number, colIndex: number): Prisma.Decimal {
  let s = D(0)
  for (const { rowIndex, cells } of sheet.rows) {
    if (rowIndex <= headerRow) continue
    const v = num(cell(cells, colIndex).value)
    if (v) s = s.plus(v)
  }
  return s
}

const fmt = (v: Prisma.Decimal) => v.toDecimalPlaces(2).toString()

/** 넣지 않을 행은 대조표의 시스템 쪽에서 빠져야 한다. 「들어갈 값」 이라고 써 놓고 안 넣으면 거짓말이다 */
const willImport = (o: PlannedOrder) =>
  o.status !== ImportRowStatus.ERROR && o.status !== ImportRowStatus.HOLD

function sumExpenses(orders: PlannedOrder[], sheet: string, code: string): Prisma.Decimal {
  return orders
    .filter((o) => o.sheet === sheet && willImport(o))
    .flatMap((o) => o.expenses)
    .filter((e) => e.categoryCode === code)
    .reduce((s, e) => s.plus(e.cny), D(0))
}

function sumSplits(orders: PlannedOrder[], sheet: string, kind: SplitKind): Prisma.Decimal {
  return orders
    .filter((o) => o.sheet === sheet && willImport(o))
    .flatMap((o) => o.splits)
    .filter((s) => s.kind === kind)
    .reduce((s, x) => s.plus(x.amount), D(0))
}

function buildTotals(
  wb: WorkbookData, orders: PlannedOrder[], transfers: PlannedTransfer[],
  employees: PlannedEmployee[], opExpenses: PlannedOpExpense[], sheets: string[],
): SheetTotals[] {
  const out: SheetTotals[] = []
  const get = (n: string) => wb.sheets.find((s) => s.name === n)

  const ov = get(SHEET_OVERSEAS)
  if (ov && sheets.includes(SHEET_OVERSEAS)) {
    const transferCny = transfers.reduce((s, t) => s.plus(t.cny ?? D(0)), D(0))
    out.push({
      sheet: SHEET_OVERSEAS, label: '해외송금',
      rows: [
        { item: 'CNY 도착금액 (D)', excel: fmt(colSum(ov, 3, 3)),
          system: fmt(sumSplits(orders, SHEET_OVERSEAS, SplitKind.SALES).plus(transferCny)) },
        { item: 'CNY 지출금액 (E)', excel: fmt(colSum(ov, 3, 4)),
          system: fmt(sumExpenses(orders, SHEET_OVERSEAS, 'GOODS')) },
        { item: '인건비용 (F)', excel: fmt(colSum(ov, 3, 5)),
          system: fmt(sumExpenses(orders, SHEET_OVERSEAS, 'LABOR_CN')) },
        { item: '기타비용 (G)', excel: fmt(colSum(ov, 3, 6)),
          system: fmt(sumExpenses(orders, SHEET_OVERSEAS, 'ETC_ORDER')) },
      ],
    })
  }

  const gen = get(SHEET_GENERAL)
  if (gen && sheets.includes(SHEET_GENERAL)) {
    out.push({
      sheet: SHEET_GENERAL, label: '일반통장',
      rows: [
        { item: 'KRW 입금액 (C)', excel: fmt(colSum(gen, 2, 2)),
          system: fmt(sumSplits(orders, SHEET_GENERAL, SplitKind.SALES)) },
        { item: 'CNY 지출금액 (E)', excel: fmt(colSum(gen, 2, 4)),
          system: fmt(sumExpenses(orders, SHEET_GENERAL, 'GOODS')) },
        { item: '대행통관비용 (F)', excel: fmt(colSum(gen, 2, 5)),
          system: fmt(sumExpenses(orders, SHEET_GENERAL, 'CUSTOMS')) },
      ],
    })
  }

  const corp = get(SHEET_CORP)
  if (corp && sheets.includes(SHEET_CORP)) {
    const rows = orders.filter((o) => o.sheet === SHEET_CORP && willImport(o))
    const actualIn = rows.reduce((s, o) => s.plus(o.receiptAmount ?? D(0)), D(0))
    const vat = sumSplits(orders, SHEET_CORP, SplitKind.VAT)
    const issuedVat = rows.filter((o) => o.invoice)
      .reduce((s, o) => s.plus(o.invoice!.vat), D(0))
    out.push({
      sheet: SHEET_CORP, label: '법인통장',
      rows: [
        { item: '공급가액 (C)', excel: fmt(colSum(corp, 2, 2)),
          system: fmt(sumSplits(orders, SHEET_CORP, SplitKind.SALES)) },
        { item: 'CNY 지출금액 (E)', excel: fmt(colSum(corp, 2, 4)),
          system: fmt(sumExpenses(orders, SHEET_CORP, 'GOODS')) },
        { item: '세금계산서 합계 (M)', excel: fmt(colSum(corp, 2, 12)),
          system: fmt(rows.filter((o) => o.invoice).reduce((s, o) => s.plus(o.invoice!.total), D(0))) },
        { item: '실제 입금액', excel: '(엑셀에 기록 없음)', system: fmt(actualIn) },
        { item: '부가세 예수금', excel: '(엑셀에 기록 없음)',
          system: `${fmt(vat)} (발행 ${fmt(issuedVat)} · 미발행 ${fmt(vat.minus(issuedVat))})` },
      ],
    })
  }

  const ops = get(SHEET_OPS)
  if (ops && sheets.includes(SHEET_OPS)) {
    const sumOp = (code: string) =>
      opExpenses.filter((e) => e.categoryCode === code).reduce((s, e) => s.plus(e.cny), D(0))
    // 엑셀이 스스로 적어 둔 合计 행. 항목을 더한 값과 다를 수 있어 그대로 보여준다
    const totalRow = ops.rows.find((r) => {
      const t = text(cell(r.cells, 0).value)
      return !!t && /合[计計]/.test(t)
    })
    const stated = (i: number) => (totalRow ? num(cell(totalRow.cells, i).value) : null)
    const base = employees.reduce((s, e) => s.plus(e.baseSalary ?? D(0)), D(0))
    const actual = employees.reduce((s, e) => s.plus(e.actualPaid ?? D(0)), D(0))
    const ins = employees.reduce((s, e) => s.plus(e.insurance ?? D(0)), D(0))
    const withStated = (sum: Prisma.Decimal, col: number) => {
      const st = stated(col)
      return st && !st.equals(sum) ? `${fmt(sum)}  (合计행은 ${fmt(st)})` : fmt(sum)
    }
    out.push({
      sheet: SHEET_OPS, label: '중국 운영비',
      rows: [
        { item: '급여', excel: withStated(base, 1), system: `${fmt(actual)} ← 실지급 기준` },
        { item: '사회보험', excel: withStated(ins.plus(sumOp('INSURANCE')), 3),
          system: fmt(ins.plus(sumOp('INSURANCE'))) },
        { item: '임시공', excel: withStated(sumOp('TEMP_LABOR'), 6), system: fmt(sumOp('TEMP_LABOR')) },
        { item: '사무실 경비', excel: withStated(sumOp('OFFICE'), 10), system: fmt(sumOp('OFFICE')) },
      ],
    })
  }

  // 넣지 않는 행 때문에 생기는 차이를 숫자로 밝힌다. 「차이」 만 띄우면 불안하다
  for (const t of out) {
    const blocked = orders.filter(
      (o) => o.sheet === t.sheet && (o.status === ImportRowStatus.ERROR || o.status === ImportRowStatus.HOLD),
    )
    if (blocked.length === 0) continue
    const held = blocked.reduce((s2, o) => s2.plus(o.receiptAmount ?? D(0)), D(0))
    const heldCost = blocked.flatMap((o) => o.expenses).reduce((s2, e) => s2.plus(e.cny), D(0))
    const cur = t.sheet === SHEET_OVERSEAS ? 'CNY' : 'KRW'
    t.note = `차이는 넣지 않는 ${blocked.length}건 때문입니다 — 입금 ${cur} ${fmt(held)}`
      + (heldCost.gt(0) ? `, 지출 CNY ${fmt(heldCost)}` : '')
      + '. 고쳐서 다시 올리면 그 건들만 추가로 들어갑니다.'
  }

  return out
}

/**
 * 거래처 칸이 비고 지출 없이 USD→CNY 만 있는 행을 세어 본다.
 * 설정 화면에서 「이런 행이 N건, CNY 얼마」 라고 보여 주기 위해서다 — 미리보기 전에도 보여야 한다.
 */
export function scanBlankRemitRows(wb: WorkbookData): { count: number; cny: string } {
  const sheet = wb.sheets.find((x) => x.name === SHEET_OVERSEAS)
  if (!sheet) return { count: 0, cny: '0' }
  let count = 0
  let total = D(0)
  for (const { cells } of dataRows(sheet, 3)) {
    if (text(cell(cells, 1).value)) continue
    const usd = positive(cell(cells, 2).value)
    const cny = positive(cell(cells, 3).value)
    const hasCosts = [4, 5, 6].some((i) => positive(cell(cells, i).value) !== null)
    if (usd && cny && !hasCosts) { count++; total = total.plus(cny) }
  }
  return { count, cny: fmt(total) }
}

// ─────────────────────────────────────────────────────────────────────
// 계획 만들기
// ─────────────────────────────────────────────────────────────────────

export function buildPlan(wb: WorkbookData, opts: PlanOptions): ImportPlan {
  const pc = new PartnerCollector()
  let orders: PlannedOrder[] = []
  let transfers: PlannedTransfer[] = []
  let employees: PlannedEmployee[] = []
  let opExpenses: PlannedOpExpense[] = []
  const skipped: ImportPlan['skipped'] = []

  for (const sheet of wb.sheets) {
    if (!opts.sheets.includes(sheet.name)) {
      skipped.push({
        sheet: sheet.name, rowCount: sheet.rows.length,
        reason: sheet.rows.length === 0
          ? '빈 시트입니다.'
          : '가져오지 않기로 선택한 시트입니다. 원본은 그대로 보관합니다.',
      })
      continue
    }
    switch (sheet.name) {
      case SHEET_OVERSEAS: {
        const r = planOverseas(sheet, pc, opts)
        orders = orders.concat(r.orders)
        transfers = transfers.concat(r.transfers)
        if (r.skippedRows) skipped.push({ sheet: sheet.name, rowCount: r.skippedRows, reason: '빈 행' })
        break
      }
      case SHEET_GENERAL: {
        const r = planGeneral(sheet, pc)
        orders = orders.concat(r.orders)
        if (r.skippedRows) skipped.push({ sheet: sheet.name, rowCount: r.skippedRows, reason: '빈 행' })
        break
      }
      case SHEET_CORP: {
        const r = planCorp(sheet, pc)
        orders = orders.concat(r.orders)
        if (r.skippedRows) skipped.push({ sheet: sheet.name, rowCount: r.skippedRows, reason: '빈 행' })
        break
      }
      case SHEET_OPS: {
        const r = planOps(sheet, opts)
        employees = employees.concat(r.employees)
        opExpenses = opExpenses.concat(r.opExpenses)
        if (r.skippedRows) skipped.push({ sheet: sheet.name, rowCount: r.skippedRows, reason: '합계 행' })
        break
      }
      default:
        skipped.push({
          sheet: sheet.name, rowCount: sheet.rows.length,
          reason: '다룰 줄 모르는 시트라 건너뜁니다. 원본은 그대로 보관합니다.',
        })
    }
  }

  orders = foldReceivables(orders)

  // 원본 마진과 재계산 마진을 대조한다. 가져오지는 않는다
  for (const o of orders) {
    if (o.excelMargin === null) continue
    const costCny = o.expenses.reduce((s, e) => s.plus(e.cny), D(0))
    const inCny = o.settlementCurrency === Currency.CNY
      ? (o.receiptAmount ?? D(0))
      : (o.amountCny ?? D(0))
    const recalc = inCny.minus(costCny)
    if (recalc.minus(o.excelMargin).abs().gt(D('1'))) {
      o.issues.push({
        level: 'WARN', code: 'MARGIN_DIFF',
        message: `엑셀 마진 ${o.excelMargin.toDecimalPlaces(2).toString()} 과 재계산 `
          + `${recalc.toDecimalPlaces(2).toString()} 이 다릅니다. 마진은 가져오지 않고 시스템이 다시 계산합니다.`,
      })
      o.status = statusOf(o.issues)
    }
  }

  const orderCounts = new Map<string, number>()
  for (const o of orders) orderCounts.set(o.partnerKey, (orderCounts.get(o.partnerKey) ?? 0) + 1)
  const partners = pc.finish(orderCounts)

  // 같은 키에 표기가 둘 이상이면 병합 후보. 자동으로 합치지 않는다
  const mergeCandidates = partners
    .filter((p) => p.variants.length > 1)
    .map((p) => ({ key: p.key, variants: p.variants }))

  const counts = { ok: 0, warn: 0, error: 0, hold: 0, skip: 0 }
  for (const o of orders) {
    if (o.status === ImportRowStatus.OK) counts.ok++
    else if (o.status === ImportRowStatus.WARN) counts.warn++
    else if (o.status === ImportRowStatus.ERROR) counts.error++
    else if (o.status === ImportRowStatus.HOLD) counts.hold++
  }
  for (const e of [...opExpenses]) {
    if (e.issues.some((i) => i.level === 'HOLD')) counts.hold++
    else if (e.issues.some((i) => i.level === 'WARN')) counts.warn++
    else counts.ok++
  }
  counts.skip = skipped.reduce((s, x) => s + x.rowCount, 0)

  return {
    orders, transfers, employees, opExpenses, partners, mergeCandidates, skipped,
    totals: buildTotals(wb, orders, transfers, employees, opExpenses, opts.sheets),
    opsMonths: opts.sheets.includes(SHEET_OPS)
      ? buildOpsMonths(employees, opExpenses, opts.payrollYm) : [],
    counts,
  }
}
