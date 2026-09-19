'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type { Role } from '@prisma/client'
import { can, type Permission } from '@/lib/permissions'

type Item = { href: string; label: string; icon: string; perm?: Permission; soon?: boolean }
type Group = { title?: string; items: Item[] }

const GROUPS: Group[] = [
  {
    items: [
      { href: '/', label: '대시보드', icon: '📊' },
      { href: '/funds', label: '자금현황', icon: '💰', perm: 'profit.view' },
    ],
  },
  {
    // 대표님이 쓰시던 엑셀 시트 그대로 — 돈이 들어온 통장별로 나눈다
    title: '통장별 거래',
    items: [
      { href: '/orders?route=OVERSEAS', label: '해외송금', icon: '🌏' },
      { href: '/orders?route=BANK_GEN', label: '일반통장', icon: '🏦' },
      { href: '/orders?route=BANK_CORP', label: '법인통장', icon: '🏛️' },
      { href: '/orders?route=SITE', label: '사이트통장', icon: '🛒' },
      { href: '/orders', label: '전체 거래', icon: '📋' },
    ],
  },
  {
    title: '거래처',
    items: [
      { href: '/partners', label: '거래처 관리', icon: '🏢' },
    ],
  },
  {
    title: '중국 운영비',
    items: [
      { href: '/payroll', label: '직원 급여', icon: '🇨🇳', perm: 'payroll.view' },
      { href: '/temp-labor', label: '임시공 비용', icon: '🔨' },
      { href: '/office', label: '중국 운영비', icon: '🏬' },
    ],
  },
  {
    title: '관리',
    items: [
      { href: '/import', label: '엑셀 가져오기', icon: '📥', perm: 'settings.manage' },
      { href: '/settings', label: '설정', icon: '⚙️', perm: 'settings.manage' },
      { href: '/audit', label: '변경이력', icon: '📜', perm: 'audit.view' },
    ],
  },
]
export default function Nav({ role }: { role: Role }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const currentRoute = params.get('route') ?? ''

  /** 통장별 메뉴는 주소의 route 값까지 같아야 현재 위치로 본다 */
  function isActive(href: string): boolean {
    const [path, query] = href.split('?')
    const wanted = query ? new URLSearchParams(query).get('route') ?? '' : ''
    if (path === '/') return pathname === '/'
    if (path === '/orders') return pathname === '/orders' && currentRoute === wanted
    return pathname.startsWith(path)
  }

  return (
    <nav className="flex flex-col gap-5 px-3 py-4">
      {GROUPS.map((group, gi) => {
        const visible = group.items.filter((it) => !it.perm || can(role, it.perm))
        if (visible.length === 0) return null
        return (
          <div key={gi}>
            {group.title && (
              <p className="mb-1.5 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                {group.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {visible.map((it) => {
                const active = isActive(it.href)
                return (
                  <li key={it.href}>
                    <Link
                      href={it.href}
                      className={`flex items-center gap-2.5 rounded-sm border-l-2 px-2.5 py-1.5 text-[13px] no-underline transition ${
                        active
                          ? 'border-jade bg-jade-soft font-medium text-jade'
                          : 'border-transparent text-ink-2 hover:bg-sunken hover:text-ink'
                      }`}
                    >
                      <span aria-hidden className="text-[13px]">{it.icon}</span>
                      <span className="flex-1">{it.label}</span>
                      {it.soon && (
                        <span className="font-mono text-[9px] text-ink-muted/70">준비중</span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
