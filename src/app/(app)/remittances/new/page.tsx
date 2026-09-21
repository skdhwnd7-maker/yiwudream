import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { listRemitPending } from '@/lib/funds'
import { plain } from '@/lib/serialize'
import RemitForm from './RemitForm'

export const dynamic = 'force-dynamic'

export default async function NewRemittancePage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string }>
}) {
  await requirePermission('remittance.execute')
  const sp = await searchParams

  const [pending, accounts] = await Promise.all([
    listRemitPending(false),
    // 보낼 수 있는 계좌만 보여 준다 — 한국 원화에서 나가 중국 위안으로 들어온다
    prisma.account.findMany({
      where: {
        isActive: true,
        OR: [
          { entity: 'KR', currency: 'KRW' },
          { entity: 'CN', currency: 'CNY' },
        ],
      },
      orderBy: [{ entity: 'asc' }, { name: 'asc' }],
    }),
  ])

  const rows = sp.partner ? pending.filter((p) => p.partnerId === sp.partner) : pending

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="card">
          <div className="card-body text-center">
            <p className="text-sm text-ink-muted">보낼 돈이 없습니다.</p>
            <Link href="/remittances" className="btn-ghost mt-3 no-underline">송금 관리로</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <RemitForm
        rows={plain(rows)}
        krAccounts={plain(accounts.filter((a) => a.entity === 'KR'))}
        cnAccounts={plain(accounts.filter((a) => a.entity === 'CN'))}
      />
    </div>
  )
}
