import { AuditAction } from '@prisma/client'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtDateTime } from '@/lib/serialize'
import { AUDIT_ACTION_LABEL, TABLE_LABEL } from '@/lib/audit'
import { EmptyRow } from '@/components/ui'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; user?: string; action?: string; from?: string; to?: string; page?: string }>
}) {
  await requirePermission('audit.view')
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page ?? 1) || 1)

  const where = {
    ...(sp.table ? { tableName: sp.table } : {}),
    ...(sp.user ? { changedBy: BigInt(sp.user) } : {}),
    ...(sp.action && sp.action in AuditAction ? { action: sp.action as AuditAction } : {}),
    ...(sp.from || sp.to
      ? {
          changedAt: {
            ...(sp.from ? { gte: new Date(`${sp.from}T00:00:00`) } : {}),
            ...(sp.to ? { lte: new Date(`${sp.to}T23:59:59`) } : {}),
          },
        }
      : {}),
  }

  const [logs, total, users] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { changedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: { select: { name: true } } },
    }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const tables = Object.keys(TABLE_LABEL)

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="section-title text-xl">변경이력</h1>
        <p className="mt-1 text-sm text-ink-muted">
          누가 언제 무엇을 얼마에서 얼마로 바꿨는지, 사유까지 남습니다. 이 기록은 수정·삭제되지 않습니다.
        </p>
      </header>

      <form className="card" method="get">
        <div className="card-body grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]">
          <div>
            <label htmlFor="table">대상</label>
            <select id="table" name="table" defaultValue={sp.table ?? ''}>
              <option value="">전체</option>
              {tables.map((t) => <option key={t} value={t}>{TABLE_LABEL[t]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="user">사용자</label>
            <select id="user" name="user" defaultValue={sp.user ?? ''}>
              <option value="">전체</option>
              {users.map((u) => <option key={u.id.toString()} value={u.id.toString()}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="action">동작</label>
            <select id="action" name="action" defaultValue={sp.action ?? ''}>
              <option value="">전체</option>
              {Object.values(AuditAction).map((a) => <option key={a} value={a}>{AUDIT_ACTION_LABEL[a]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="from">시작일</label>
            <input id="from" name="from" type="date" defaultValue={sp.from ?? ''} />
          </div>
          <div>
            <label htmlFor="to">종료일</label>
            <input id="to" name="to" type="date" defaultValue={sp.to ?? ''} />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-ghost whitespace-nowrap">조회</button>
          </div>
        </div>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-44">일시</th>
              <th className="w-24">사용자</th>
              <th className="w-28">대상</th>
              <th className="w-20">동작</th>
              <th className="w-20 n">ID</th>
              <th>변경 내용</th>
              <th className="w-44">사유</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && <EmptyRow colSpan={7} label="이력이 없습니다." />}
            {logs.map((log) => (
              <tr key={log.id.toString()}>
                <td className="num text-xs text-ink-muted">{fmtDateTime(log.changedAt)}</td>
                <td className="text-xs">{log.user.name}</td>
                <td className="text-xs">{TABLE_LABEL[log.tableName] ?? log.tableName}</td>
                <td className="text-xs">
                  <span className={log.action === 'VOID' || log.action === 'UNLOCK' ? 'pill-warn' : 'pill-neutral'}>
                    {AUDIT_ACTION_LABEL[log.action]}
                  </span>
                </td>
                <td className="n text-xs text-ink-muted">{log.recordId.toString()}</td>
                <td className="text-xs text-ink-2">
                  {log.fieldName ? (
                    <>
                      <span className="font-mono text-[11px]">{log.fieldName}</span>
                      <br />
                      <span className="text-clay">{truncate(log.oldValue)}</span>
                      <span className="mx-1 text-ink-muted">→</span>
                      <span className="text-jade">{truncate(log.newValue)}</span>
                    </>
                  ) : log.newValue ? (
                    <span className="font-mono text-[11px] text-ink-muted">{truncate(log.newValue, 120)}</span>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className="text-xs text-ink-muted">{log.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-ink-muted">
        <span className="num">{total.toLocaleString('ko-KR')}건</span>
        <span>{page} / {totalPages}</span>
      </div>
    </div>
  )
}

function truncate(v: string | null, max = 60): string {
  if (v === null) return '—'
  return v.length > max ? `${v.slice(0, max)}…` : v
}
