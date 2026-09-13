'use client'

import { useState } from 'react'

export interface IssueGroup {
  code: string
  level: string
  message: string
  rows: string[]
  count: number
}

const TONE: Record<string, string> = {
  ERROR: 'pill-warn',
  HOLD: 'pill-warn',
  WARN: 'pill-gold',
  INFO: 'pill-neutral',
}
const LEVEL_LABEL: Record<string, string> = {
  ERROR: '오류', HOLD: '보류', WARN: '경고', INFO: '알림',
}

export default function IssueList({ plan }: { plan: IssueGroup[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (plan.length === 0) return null

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="text-sm font-semibold">확인하실 것 {plan.length}가지</h2>
        <span className="text-xs text-ink-muted">줄을 누르면 해당 엑셀 행을 보여 드립니다</span>
      </div>
      <div className="card-body space-y-2">
        {plan.map((g) => (
          <div key={g.code} className="rounded border border-line">
            <button
              type="button"
              onClick={() => setOpen(open === g.code ? null : g.code)}
              className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-sunken"
            >
              <span className={TONE[g.level] ?? 'pill-neutral'}>{LEVEL_LABEL[g.level] ?? g.level}</span>
              <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink-2">{g.message}</span>
              <span className="whitespace-nowrap font-mono text-xs text-ink-muted">
                {g.count.toLocaleString('ko-KR')}건
              </span>
            </button>
            {open === g.code && (
              <div className="border-t border-line bg-sunken px-3 py-2 text-xs text-ink-3">
                {g.rows.join(' · ')}
                {g.count > g.rows.length && ` … 외 ${(g.count - g.rows.length).toLocaleString('ko-KR')}건`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
