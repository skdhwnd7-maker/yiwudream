/**
 * 거래처명 정규화.
 *
 * 엑셀에서 16그룹의 표기 흔들림을 확인했다.
 *   코러스 코리아(10) ↔ 코러스코리아(12)
 *   커스텀드리다(10)  ↔ 커스텀 드리다(11)
 * 그리고 거래처명 칸에 주문번호가 붙어 있었다.
 *   아르미르샵49 ~ 아르미르샵133 (82건)
 */

/** 비교용 키 — 공백·괄호·법인격 표기를 지운다. 끝 숫자는 남긴다. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '')
    .replace(/^(주식회사|유한회사|㈜|\(주\))/g, '')
    .replace(/(주식회사|유한회사|㈜|\(주\))$/g, '')
    .toLowerCase()
}

/** 병합 판정용 키 — 끝에 붙은 일련번호까지 지운다. */
export function normalizeNameForMerge(raw: string): string {
  return normalizeName(raw).replace(/\d+$/, '')
}

/**
 * 거래처명에서 꼬리 일련번호를 떼어낸다.
 * `아르미르샵133` → { baseName: '아르미르샵', externalRef: '아르미르샵133' }
 */
export function splitTrailingNumber(raw: string): { baseName: string; externalRef: string | null } {
  const trimmed = raw.normalize('NFKC').trim()
  const m = trimmed.match(/^(.*?[^\d\s])\s*(\d+)$/)
  if (!m) return { baseName: trimmed, externalRef: null }
  return { baseName: m[1].trim(), externalRef: trimmed }
}

/** 전각 숫자·기호를 반각으로. Sheet1 임시공 기간이 `１２／２８－１／３` 형태였다. */
export function toHalfWidth(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/－/g, '-')
    .replace(/～/g, '~')
    .replace(/／/g, '/')
}
