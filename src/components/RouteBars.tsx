'use client'

import { useState } from 'react'

export interface RouteBar {
  label: string
  value: number
  display: string
  count: number
}

/**
 * 루트별 거래액.
 * 한 가지 측정값을 네 갈래로 비교하는 것이라 색을 나누지 않는다.
 * 색을 나누면 색 자체가 의미 없는 장식이 된다.
 */
export default function RouteBars({ bars, color }: { bars: RouteBar[]; color: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...bars.map((b) => b.value))
  const total = bars.reduce((s, b) => s + b.value, 0)

  return (
    <ul className="space-y-2.5">
      {bars.map((b, i) => {
        const pct = (b.value / max) * 100
        const share = total > 0 ? (b.value / total) * 100 : 0
        return (
          <li key={b.label}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-ink-2">
                {b.label}
                {b.count > 0 && <span className="ml-1.5 text-ink-muted">{b.count}건</span>}
              </span>
              <span className="num text-ink-2">
                {b.display}
                {share > 0 && <span className="ml-1.5 text-ink-muted">{share.toFixed(1)}%</span>}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-sm bg-sunken">
              <div className="h-full rounded-sm transition-opacity"
                style={{ width: `${Math.max(pct, b.value > 0 ? 1.5 : 0)}%`, background: color, opacity: hover === null || hover === i ? 1 : 0.5 }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
