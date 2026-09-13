/**
 * 엑셀 원본 값을 시스템 값으로 바꾸는 조각들.
 *
 * 설계 문서: docs/07-엑셀마이그레이션.md 2·3장
 *
 * 여기 있는 함수들은 전부 순수 함수다 — DB 를 안 건드린다.
 * 마이그레이션에서 가장 틀리기 쉬운 부분이라 따로 떼어 검증한다.
 */
import { Prisma } from '@prisma/client'

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

// ── 숫자 ────────────────────────────────────────────────────────────

/** 셀 값을 금액으로. 숫자가 아니거나 0이면 null (= 그 행을 만들지 않는다) */
export function num(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    return D(v)
  }
  if (typeof v === 'string') {
    // "3,492,829.32" / "￥1,250" 같은 표기
    const cleaned = v.replace(/[,\s￥¥₩$]/g, '')
    if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null
    return D(cleaned)
  }
  return null
}

/**
 * 금액 칸은 NUMERIC(18,2) 다. 계획 단계에서 미리 2자리로 맞춰 두지 않으면
 * 저장할 때 각자 반올림되어 「분해 합계 ≠ 입금액」 으로 1전씩 어긋난다.
 */
export function money(v: Prisma.Decimal): Prisma.Decimal {
  return v.toDecimalPlaces(2)
}

/** 0 도 유효한 값으로 받아야 할 때 */
export function numOrZero(v: unknown): Prisma.Decimal {
  return num(v) ?? D(0)
}

/** 금액으로 쓸 수 있는 값인가 — 0 과 음수는 비용/입금 행을 만들지 않는다 */
export function positive(v: unknown): Prisma.Decimal | null {
  const n = num(v)
  return n && n.gt(0) ? n : null
}

// ── 글자 ────────────────────────────────────────────────────────────

/**
 * 전각 → 반각. `１２／２８－１／３` 같은 중국어 입력기 문자를 다룬다.
 * NFKC 만으로는 전각 대시(－, ―)가 안 바뀌어 따로 처리한다.
 */
export function toHalfWidth(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[－―–—ー]/g, '-')
    .replace(/[／]/g, '/')
    .replace(/　/g, ' ')
}

export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = toHalfWidth(String(v)).trim()
  return s === '' ? null : s
}

/**
 * 거래처명 정규화 키.
 * 설계 문서 4-1: NFKC → 공백 제거 → 끝 숫자 제거
 * `아르미르샵49` 와 `아르미르샵` 이 같은 키가 되어야 한다.
 */
export function partnerKey(name: string): string {
  return toHalfWidth(name).replace(/\s+/g, '').replace(/\d+$/, '').toLowerCase()
}

/**
 * `아르미르샵49` → { name: '아르미르샵', externalRef: '아르미르샵49' }
 * 꼬리 숫자가 없으면 externalRef 는 null.
 */
export function splitTrailingNumber(raw: string): { name: string; externalRef: string | null } {
  const s = toHalfWidth(raw).trim().replace(/\s+/g, ' ')
  const m = /^(.*?)\s*(\d+)$/.exec(s)
  if (!m || m[1].trim() === '') return { name: s, externalRef: null }
  return { name: m[1].trim(), externalRef: s }
}

// ── 날짜 ────────────────────────────────────────────────────────────

/** 엑셀 날짜 시리얼(1900 체계)을 Date 로. 46031 → 2026-01-09 */
export function serialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 200000) return null
  // 엑셀의 1900년 윤년 버그를 그대로 흉내낸다 (기준일 1899-12-30)
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 셀 값 → 날짜. Date, 시리얼 숫자, `2026-05-04` 문자열을 모두 받는다 */
export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return serialToDate(v)
  if (typeof v === 'string') {
    const s = toHalfWidth(v).trim()
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)) {
      const d = new Date(s.replace(/[./]/g, '-'))
      return Number.isNaN(d.getTime()) ? null : d
    }
    const n = Number(s)
    if (Number.isFinite(n)) return serialToDate(n)
  }
  return null
}

/**
 * `12/28-1/3` 같은 기간 문자열을 두 날짜로.
 * 연도가 적혀 있지 않아 기준연도를 받는다. 시작월 > 끝월이면 해를 넘긴 것으로 본다.
 * 연도를 지어내는 게 아니라 **담당자가 고른 기준연도**를 쓴다는 점이 중요하다.
 */
export function parsePeriod(
  raw: string, baseYear: number,
): { from: Date; to: Date } | null {
  const s = toHalfWidth(raw).replace(/\s/g, '').replace(/\/+-/g, '-').replace(/-+/g, '-')
  const m = /^(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (!m) return null
  const [, m1, d1, m2, d2] = m.map(Number) as unknown as number[]
  const from = new Date(baseYear, m1 - 1, d1)
  // 12/28-1/3 처럼 해를 넘기는 경우
  const toYear = m2 < m1 ? baseYear + 1 : baseYear
  const to = new Date(toYear, m2 - 1, d2)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  return { from, to }
}

// ── 환율 ────────────────────────────────────────────────────────────

export type FxSource = 'PARSED' | 'DERIVED' | 'NONE'

export interface FxResult {
  rate: Prisma.Decimal | null
  source: FxSource
  /** 화면에 그대로 보여줄 근거 */
  evidence: string
}

/**
 * `C3/218.22` 에서 218.22 를 꺼낸다.
 * 헤더에 적힌 `환율적용 192` / `195` 는 실제 수식 값과 30 가까이 차이가 나므로 쓰지 않는다.
 */
export function fxFromFormula(formula: string | null): Prisma.Decimal | null {
  if (!formula) return null
  const m = /^\s*=?\s*\$?[A-Z]+\$?\d+\s*\/\s*([\d]+(?:\.[\d]+)?)\s*$/.exec(formula)
  if (!m) return null
  const rate = D(m[1])
  return rate.gt(0) ? rate : null
}

/**
 * 환율을 정한다.
 *   ① 수식에서 파싱 (PARSED) — 가장 믿을 수 있다
 *   ② 입금액 ÷ CNY환산액 으로 역산 (DERIVED) — 제안값. 화면에서 경고한다
 *   ③ 못 구함 (NONE) — 보류. 지어내지 않는다
 */
export function resolveFx(
  formula: string | null,
  krw: Prisma.Decimal | null,
  cny: Prisma.Decimal | null,
): FxResult {
  const parsed = fxFromFormula(formula)
  if (parsed) return { rate: parsed, source: 'PARSED', evidence: `수식 ${formula}` }

  if (krw && cny && cny.gt(0)) {
    const derived = krw.div(cny).toDecimalPlaces(6)
    if (derived.gt(0)) {
      return {
        rate: derived,
        source: 'DERIVED',
        evidence: `수식이 없어 입금액 ÷ CNY (${krw.toString()} ÷ ${cny.toString()}) 로 역산`,
      }
    }
  }
  return { rate: null, source: 'NONE', evidence: '환율 근거 없음' }
}
