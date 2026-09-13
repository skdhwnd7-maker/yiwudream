/**
 * 엑셀 읽기 — 값과 수식을 함께 꺼낸다.
 *
 * 설계 문서: docs/07-엑셀마이그레이션.md 1장 원칙 2
 *
 * 이 파일에서 환율은 셀 값이 아니라 **수식 안에만** 있다 (`=C3/218.22`).
 * 그래서 값만 읽는 흔한 방식으로는 원본을 재현할 수 없다.
 * ExcelJS 의 cell.formula 는 공유수식(sharedFormula)도 원래 행 기준으로
 * 풀어서 돌려주므로 그대로 쓴다.
 */
import ExcelJS from 'exceljs'

export interface Cell {
  /** 계산된 값. 날짜는 Date, 숫자는 number, 글자는 string */
  value: string | number | Date | null
  /** 수식 원문 (`C3/218.22`). 수식이 아니면 null */
  formula: string | null
}

export interface SheetData {
  name: string
  /** 1부터 시작하는 엑셀 행번호를 그대로 쓴다 — 사람이 엑셀을 열어 대조할 수 있어야 한다 */
  rows: { rowIndex: number; cells: Cell[] }[]
  rowCount: number
  colCount: number
}

export interface WorkbookData {
  sheets: SheetData[]
}

/** 엑셀 오류값(#DIV/0! 등)이나 빈 칸을 null 로 만든다 */
function cellValue(raw: unknown): string | number | Date | null {
  if (raw === null || raw === undefined) return null
  if (raw instanceof Date) return raw
  if (typeof raw === 'number' || typeof raw === 'string') {
    return typeof raw === 'string' && raw.trim() === '' ? null : raw
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    // 수식 셀 — 계산 결과를 쓴다
    if ('result' in o) return cellValue(o.result)
    // #DIV/0! 같은 오류. 값으로 치지 않는다
    if ('error' in o) return null
    // 서식이 섞인 rich text
    if ('richText' in o && Array.isArray(o.richText)) {
      return o.richText.map((t) => (t as { text?: string }).text ?? '').join('')
    }
    if ('text' in o) return cellValue(o.text)
  }
  return null
}

export async function readWorkbook(buffer: ArrayBuffer | Buffer): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook()
  // exceljs 의 타입 정의가 낡아 ArrayBuffer 를 못 받는다. 런타임은 둘 다 받는다.
  await wb.xlsx.load(buffer as never)

  const sheets: SheetData[] = []
  for (const ws of wb.worksheets) {
    const colCount = Math.max(ws.columnCount, 1)
    const rows: SheetData['rows'] = []
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const cells: Cell[] = []
      let hasAny = false
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c)
        const value = cellValue(cell.value)
        // cell.formula 는 공유수식도 이 행 기준으로 풀어준다
        let formula: string | null = null
        try {
          formula = cell.formula ? String(cell.formula) : null
        } catch {
          formula = null
        }
        if (value !== null || formula !== null) hasAny = true
        cells.push({ value, formula })
      }
      if (hasAny) rows.push({ rowIndex: r, cells })
    }
    sheets.push({ name: ws.name, rows, rowCount: ws.rowCount, colCount })
  }
  return { sheets }
}

/** 0-기준 열 번호를 엑셀 열 문자로 (0 → A) — 화면에 "D열" 이라고 써야 한다 */
export function colLetter(index0: number): string {
  let n = index0 + 1, s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}
