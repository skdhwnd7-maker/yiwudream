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
  // 거래일·입금일 같은 「날짜만」 칸은 UTC 자정으로 담아 둔다.
  // 서버가 어느 나라에 있든 같은 날짜가 나오도록 꺼낼 때도 UTC 로 읽는다.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const SEOUL = 'Asia/Seoul'

/** 오늘 날짜 (한국 기준). 입력 폼의 기본값에 쓴다. */
export function todayISO(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return p.format(new Date())
}

/** 이번 달 (한국 기준, `2026-09`). 조회 월 기본값에 쓴다. */
export function thisMonthKST(): string {
  return todayISO().slice(0, 7)
}

/** `2026-05-04 14:22` 형태. 이력 화면에 쓴다. */
export function fmtDateTime(v: Date | string | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '—'
  // 기록된 「시각」은 언제나 한국 시간으로 보여 준다.
  // 서버는 해외(Railway 미국 서부)에 있어서 그대로 두면 9시간 전으로 나온다.
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const f = Object.fromEntries(p.formatToParts(d).map((x) => [x.type, x.value]))
  return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second}`
}
