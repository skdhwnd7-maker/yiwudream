import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import LoginForm from './LoginForm'

export default async function LoginPage() {
  if (await getSession()) redirect('/')

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-serif text-2xl font-semibold tracking-tight">이우드림무역</h1>
          <p className="mt-1 text-sm text-ink-muted">자금·정산 관리 시스템</p>
        </div>
        <div className="card">
          <div className="card-body">
            <LoginForm />
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-ink-muted">사내 전용 시스템입니다.</p>
      </div>
    </main>
  )
}
