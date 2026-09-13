'use client'

import { useId, useState } from 'react'

export interface BarPoint {
  label: string
  /** 툴팁·직접 라벨에 쓸 표시값 */
  display: string
  value: number
}

/**
 * 월별 추이 막대.
 *
 * 매출과 마진은 크기 차이가 커서 한 축에 겹치면 마진이 안 보인다.
 * 두 개를 각각 자기 축으로 그린다 (small multiples).
 */
export default function MiniBars({
  points,
  color,
  title,
  emptyLabel = '데이터 없음',
}: {
  points: BarPoint[]
  color: string
  title: string
  emptyLabel?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId()

  const values = points.map((p) => p.value)
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  const span = max - min || 1
  const hasData = points.some((p) => p.value !== 0)

  const W = 100, H = 40
  const gap = 1.4                       // 막대 사이 표면 간격
  const bw = Math.max(0.8, W / points.length - gap)
  const zeroY = H * (max / span)        // 0 기준선 위치

  const active = hover !== null ? points[hover] : points[points.length - 1]
  const activeIdx = hover !== null ? hover : points.length - 1

  return (
    <figure className="m-0">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-muted">{title}</span>
        {hasData && (
          <span className="num text-sm font-semibold" style={{ color }}>
            {active?.display}
            <span className="ml-1.5 text-[11px] font-normal text-ink-muted">{active?.label}</span>
          </span>
        )}
      </figcaption>

      {!hasData ? (
        <p className="mt-2 flex h-[64px] items-center justify-center rounded-sm bg-sunken text-xs text-ink-muted">
          {emptyLabel}
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-1.5 h-16 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} 최근 ${points.length}개월 추이`}
          onMouseLeave={() => setHover(null)}
        >
          {/* 0 기준선 — 음수가 있을 때만 의미가 있다 */}
          {min < 0 && (
            <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="currentColor"
              className="text-line-strong" strokeWidth="0.4" />
          )}
          {points.map((p, i) => {
            const x = i * (W / points.length)
            const h = (Math.abs(p.value) / span) * H
            const y = p.value >= 0 ? zeroY - h : zeroY
            const isActive = i === activeIdx
            return (
              <g key={`${uid}-${i}`}>
                {/* 히트 영역은 막대보다 넓게 */}
                <rect x={x} y={0} width={W / points.length} height={H} fill="transparent"
                  onMouseEnter={() => setHover(i)} style={{ cursor: 'default' }} />
                <rect
                  x={x + gap / 2} y={Math.max(0, y)} width={bw} height={Math.max(0.6, h)}
                  rx="0.8" fill={color}
                  opacity={isActive ? 1 : 0.45}
                  pointerEvents="none"
                />
              </g>
            )
          })}
        </svg>
      )}
    </figure>
  )
}
