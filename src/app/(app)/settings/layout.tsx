import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'

const TABS = [
  { href: '/settings/accounts', label: '계좌' },
  { href: '/settings/categories', label: '비용분류' },
  { href: '/settings/deal-types', label: '거래유형' },
  { href: '/settings/users', label: '사용자' },
  { href: '/settings/global', label: '전역설정' },
]

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('settings.manage')
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="section-title text-xl">설정</h1>
      <nav className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-ink-2 no-underline hover:border-line-strong hover:text-ink"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
