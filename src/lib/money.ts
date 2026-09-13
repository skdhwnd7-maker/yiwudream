/**
 * 금액·환율 계산.
 *
 * 이 파일 밖에서 금액에 + - * / 를 직접 쓰지 않는다.
 * 부동소수점 오차가 돈을 틀리게 만든다.
 */
import { Decimal } from 'decimal.js'

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

export type Money = Decimal
export type RoundingMode = 'ROUND' | 'FLOOR' | 'CEIL'

export const D = (v: Decimal.Value | null | undefined): Decimal =>
  v === null || v === undefined || v === '' ? new Decimal(0) : new Decimal(v as Decimal.Value)

/** 원 단위 정리. 설정값(FLOOR 기본)에 따른다. */
export function roundKrw(v: Decimal.Value, mode: RoundingMode = 'FLOOR'): Decimal {
  const d = D(v)
  if (mode === 'FLOOR') return d.toDecimalPlaces(0, Decimal.ROUND_FLOOR)
  if (mode === 'CEIL') return d.toDecimalPlaces(0, Decimal.ROUND_CEIL)
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
}

/** CNY·USD는 소수 둘째 자리. */
export const round2 = (v: Decimal.Value): Decimal =>
  D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

/**
 * 환율 규칙 — 1위안당 원 (예: 218.22)
 * KRW → CNY : 금액 ÷ 환율
 * CNY → KRW : 금액 × 환율
 */
export const krwToCny = (krw: Decimal.Value, fxRate: Decimal.Value): Decimal => {
  const rate = D(fxRate)
  if (rate.isZero()) throw new Error('환율이 0입니다. 적용환율을 확인하세요.')
  return round2(D(krw).div(rate))
}

export const cnyToKrw = (cny: Decimal.Value, fxRate: Decimal.Value, mode: RoundingMode = 'FLOOR'): Decimal =>
  roundKrw(D(cny).mul(D(fxRate)), mode)

/**
 * 부가세 분리.
 *
 * INCLUDED — 받은 금액 안에 부가세가 들어 있다 (사이트 수수료)
 * EXCLUDED — 공급가액에 부가세가 따로 붙는다 (법인통장)
 */
export type VatMode = 'INCLUDED' | 'EXCLUDED' | 'EXEMPT' | 'ZERO' | 'NONE'

export interface VatSplit {
  /** 공급가액 — 회사 수익 */
  supply: Decimal
  /** 부가세 — 국세청에 낼 돈 */
  vat: Decimal
  /** 합계 = 실제 주고받는 금액 */
  total: Decimal
}

export function splitVat(
  targetAmount: Decimal.Value,
  mode: VatMode,
  vatRate: Decimal.Value = '0.10',
  rounding: RoundingMode = 'FLOOR',
): VatSplit {
  const amount = D(targetAmount)
  const rate = D(vatRate)

  if (mode === 'EXEMPT' || mode === 'ZERO' || mode === 'NONE') {
    return { supply: amount, vat: D(0), total: amount }
  }

  if (mode === 'INCLUDED') {
    // 대상금액 안에 부가세가 포함되어 있다
    const supply = roundKrw(amount.div(rate.plus(1)), rounding)
    return { supply, vat: amount.minus(supply), total: amount }
  }

  // EXCLUDED — 대상금액이 공급가액이고 부가세가 따로 붙는다
  const vat = roundKrw(amount.mul(rate), rounding)
  return { supply: amount, vat, total: amount.plus(vat) }
}

/**
 * 실제 입금액에서 공급가액과 부가세를 되돌린다.
 * 법인통장 이관에 쓴다: 통장 금액 3,456,960 → 공급가액 3,142,691 + 부가세 314,269
 */
export function reverseVatFromTotal(
  totalReceived: Decimal.Value,
  vatRate: Decimal.Value = '0.10',
  rounding: RoundingMode = 'FLOOR',
): VatSplit {
  const total = D(totalReceived)
  const supply = roundKrw(total.div(D(vatRate).plus(1)), rounding)
  return { supply, vat: total.minus(supply), total }
}

/** 마진율(%). 분모가 0이면 null — 엑셀의 #DIV/0! 대신. */
export function marginRate(margin: Decimal.Value, revenue: Decimal.Value): Decimal | null {
  const rev = D(revenue)
  if (rev.isZero()) return null
  return D(margin).div(rev).mul(100).toDecimalPlaces(2)
}

/** 원가 대비 수익률(%) — 엑셀 `%` 열과 같은 값. 보조 지표로 병행 표시한다. */
export function costMarkupRate(margin: Decimal.Value, totalCost: Decimal.Value): Decimal | null {
  const cost = D(totalCost)
  if (cost.isZero()) return null
  return D(margin).div(cost).mul(100).toDecimalPlaces(2)
}

// ── 표시용 포맷 ──────────────────────────────────────────────

export const fmtKrw = (v: Decimal.Value | null | undefined): string =>
  v === null || v === undefined ? '—' : D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber().toLocaleString('ko-KR')

export const fmtCny = (v: Decimal.Value | null | undefined): string =>
  v === null || v === undefined
    ? '—'
    : D(v).toDecimalPlaces(2).toNumber().toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const fmtRate = (v: Decimal.Value | null | undefined): string =>
  v === null || v === undefined ? '—' : D(v).toDecimalPlaces(2).toNumber().toLocaleString('ko-KR', { minimumFractionDigits: 2 })

export const fmtPercent = (v: Decimal.Value | null | undefined): string =>
  v === null || v === undefined ? '—' : `${D(v).toDecimalPlaces(2).toNumber().toLocaleString('ko-KR')}%`

export const fmtMoney = (v: Decimal.Value | null | undefined, currency: 'KRW' | 'CNY' | 'USD'): string =>
  currency === 'KRW' ? fmtKrw(v) : fmtCny(v)
