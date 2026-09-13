import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtDateTime } from '@/lib/serialize'
import { AUDIT_ACTION_LABEL, TABLE_LABEL } from '@/lib/audit'
import { can } from '@/lib/auth'

export default async function DashboardPage() {
  const user = await requireUser()

  const [partnerCount, accountCount, dealTypeCount, categoryCount, recentLogs] = await Promise.all([
    prisma.partner.count({ where: { isActive: true, isInternal: false } }),
    prisma.account.count({ where: { isActive: true } }),
    prisma.dealType.count({ where: { isActive: true } }),
    prisma.expenseCategory.count({ where: { isActive: true } }),
    can(user.role, 'audit.view')
      ? prisma.auditLog.findMany({
          take: 8,
          orderBy: { changedAt: 'desc' },
          include: { user: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ])

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="section-title text-xl">대시보드</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {user.name}님, 안녕하세요.
        </p>
      </header>

      {/* Phase 1 단계에서는 실거래 데이터가 없다. 지표 대신 진행 상황을 보여준다. */}
      <div className="card border-gold bg-gold-soft">
        <div className="card-body">
          <p className="text-sm font-medium text-gold">현재 Phase 1 — 기반 구축 단계입니다</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
            로그인·권한, 기준정보 설정, 거래처 관리, 변경이력이 동작합니다.
            매출·마진·자금현황 지표는 <strong>Phase 2 거래 원장</strong>이 올라간 뒤 이 자리에 표시됩니다.
          </p>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="등록 거래처" value={partnerCount} unit="곳" href="/partners" />
        <StatCard label="계좌" value={accountCount} unit="개" href="/settings/accounts" />
        <StatCard label="거래유형" value={dealTypeCount} unit="종" href="/settings/deal-types" />
        <StatCard label="비용분류" value={categoryCount} unit="종" href="/settings/categories" />
      </section>

      {recentLogs.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">최근 변경이력</h2>
            <Link href="/audit" className="text-xs no-underline hover:underline">전체보기 →</Link>
          </div>
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr>
                  <th className="w-44">일시</th>
                  <th className="w-24">사용자</th>
                  <th className="w-28">대상</th>
                  <th className="w-20">동작</th>
                  <th>내용</th>
                </tr>
              </thead>
              <tbody>
                {recentLogs.map((log) => (
                  <tr key={log.id.toString()}>
                    <td className="num text-xs text-ink-muted">{fmtDateTime(log.changedAt)}</td>
                    <td className="text-xs">{log.user.name}</td>
                    <td className="text-xs">{TABLE_LABEL[log.tableName] ?? log.tableName}</td>
                    <td className="text-xs">{AUDIT_ACTION_LABEL[log.action]}</td>
                    <td className="text-xs text-ink-2">
                      {log.fieldName ? (
                        <>
                          <span className="font-mono">{log.fieldName}</span>
                          {' : '}
                          <span className="text-clay">{log.oldValue ?? '—'}</span>
                          {' → '}
                          <span className="text-jade">{log.newValue ?? '—'}</span>
                        </>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function StatCard({ label, value, unit, href }: { label: string; value: number; unit: string; href: string }) {
  return (
    <Link href={href} className="card no-underline transition hover:border-line-strong">
      <div className="card-body">
        <p className="text-xs text-ink-muted">{label}</p>
        <p className="mt-1 num text-2xl font-semibold text-ink">
          {value.toLocaleString('ko-KR')}
          <span className="ml-1 text-sm font-normal text-ink-muted">{unit}</span>
        </p>
      </div>
    </Link>
  )
}
