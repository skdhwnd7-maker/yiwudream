import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { ROLE_LABEL } from '@/lib/auth'
import { logoutAction } from '../login/actions'
import Nav from './Nav'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[212px] shrink-0 border-r border-line bg-surface lg:block">
        <div className="sticky top-0 max-h-screen overflow-y-auto">
          {/* 어느 화면에 있든 여기를 누르면 대시보드로 돌아온다 */}
          <Link
            href="/"
            className="block border-b border-line px-5 py-4 transition-colors hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none"
          >
            <p className="font-serif text-[15px] font-semibold leading-tight">이우드림무역</p>
            <p className="mt-0.5 text-[11px] text-ink-muted">자금·정산 관리</p>
          </Link>
          <Nav role={user.role} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line bg-surface/95 px-6 py-2.5 backdrop-blur">
          <Link href="/" className="text-[13px] text-ink-muted hover:text-ink lg:hidden">이우드림무역 자금관리</Link>
          <div className="ml-auto flex items-center gap-3 text-[13px]">
            <span className="text-ink-2">
              {user.name}
              <span className="ml-1.5 pill-neutral">{ROLE_LABEL[user.role]}</span>
            </span>
            <form action={logoutAction}>
              <button type="submit" className="btn-ghost btn-sm">로그아웃</button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  )
}
