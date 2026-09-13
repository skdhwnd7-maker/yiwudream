/**
 * Prisma의 BigInt·Decimal·Date는 서버 컴포넌트에서 클라이언트로 그대로 넘길 수 없다.
 * 화면에 넘기기 전에 이 함수로 평탄화한다.
 */
import { Prisma } from '@prisma/client'

export type Plain<T> = T extends Prisma.Decimal
  ? string
  : T extends bigint
    ? string
    : T extends Date
      ? string
      : T extends Array<infer U>
        ? Plain<U>[]
        : T extends object
          ? { [K in keyof T]: Plain<T[K]> }
          : T

export function plain<T>(value: T): Plain<T> {
  if (value === null || value === undefined) return value as Plain<T>
  if (value instanceof Prisma.Decimal) return value.toString() as Plain<T>
  if (typeof value === 'bigint') return value.toString() as Plain<T>
  if (value instanceof Date) return value.toISOString() as Plain<T>
  if (Array.isArray(value)) return value.map(plain) as Plain<T>
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v)
    return out as Plain<T>
  }
  return value as Plain<T>
}

/** `2026-05-04` 형태. 날짜 칸 표시에 쓴다. */
export function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `2026-05-04 14:22` 형태. 이력 화면에 쓴다. */
export function fmtDateTime(v: Date | string | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${fmtDate(d)} ${hh}:${mm}:${ss}`
}
