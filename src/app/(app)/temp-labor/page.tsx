import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtCny, fmtKrw, D } from '@/lib/money'
import { fmtDate, plain } from '@/lib/serialize'
import { can } from '@/lib/permissions'
import ExpenseEntry from '../office/ExpenseEntry'
import VoidExpenseButton from '@/components/VoidExpenseButton'

export const dynamic = 'force-dynamic'

export default async function TempLaborPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams

  const where = {
    category: { code: 'TEMP_LABOR' },
    isVoid: false,
    ...(sp.from || sp.to
      ? {
          expenseDate: {
            ...(sp.from ? { gte: new Date(`${sp.from}T00:00:00Z`) } : {}),
            ...(sp.to ? { lte: new Date(`${sp.to}T23:59:59`) } : {}),
          },
        }
      : {}),
  }

  const [expenses, categories, accounts, openOrders] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        category: true,
        allocs: { include: { order: { include: { partner: { select: { name: true } } } } } },
      },
      orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
      take: 200,
    }),
    prisma.expenseCategory.findMany({ where: { code: 'TEMP_LABOR' } }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.order.findMany({
      where: { status: 'OPEN', isVoid: false },
      include: { partner: { select: { name: true } } },
      orderBy: { orderDate: 'desc' },
      take: 100,
    }),
  ])

  const attributed = expenses.filter((e) => e.allocs.length > 0)
  const operating = expenses.filter((e) => e.allocs.length === 0)
  const sumAttributed = attributed.reduce((s, e) => s.plus(e.amountCny ?? 0), D(0))
  const sumOperating = operating.reduce((s, e) => s.plus(e.amountCny ?? 0), D(0))

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="section-title text-xl">임시공 비용</h1>
        <p className="mt-1 text-sm text-ink-muted">
          귀속 주문을 채우면 그 거래의 원가가 되고, 비우면 중국 운영비가 됩니다.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card">
          <div className="card-body">
            <p className="text-xs text-ink-muted">주문 귀속분</p>
            <p className="mt-1 num text-xl font-semibold text-jade">CNY {fmtCny(sumAttributed)}</p>
            <p className="hint mt-0.5">해당 주문 마진에서 차감됩니다</p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-xs text-ink-muted">운영비 처리분</p>
            <p className="mt-1 num text-xl font-semibold">CNY {fmtCny(sumOperating)}</p>
            <p className="hint mt-0.5">중국 운영비로 집계됩니다</p>
          </div>
        </div>
      </div>

      {can(user.role, 'transaction.write') && categories[0] && (
        <ExpenseEntry
          mode="temp-labor"
          categories={plain(categories)}
          accounts={plain(accounts)}
          orders={plain(openOrders)}
        />
      )}

      <form method="get" className="card">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="from">시작일</label>
            <input id="from" name="from" type="date" defaultValue={sp.from ?? ''} />
          </div>
          <div>
            <label htmlFor="to">종료일</label>
            <input id="to" name="to" type="date" defaultValue={sp.to ?? ''} />
          </div>
          <button type="submit" className="btn-ghost mb-0.5 whitespace-nowrap">조회</button>
        </div>
      </form>

      <section className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-36">작업기간</th>
              <th>작업내용</th>
              <th className="w-28 n">금액 (CNY)</th>
              <th className="w-28 n">원화 환산</th>
              <th className="w-48">귀속</th>
              <th className="w-24">지급일</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-sm text-ink-muted">
                등록된 임시공 비용이 없습니다.
              </td></tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id.toString()}>
                <td className="num text-xs">
                  {e.workPeriodFrom && e.workPeriodTo
                    ? `${fmtDate(e.workPeriodFrom).slice(5)} ~ ${fmtDate(e.workPeriodTo).slice(5)}`
                    : fmtDate(e.expenseDate)}
                </td>
                <td className="text-sm">
                  {e.workDesc ?? e.memo ?? '—'}
                  {e.vendorName && <p className="text-[11px] text-ink-muted">{e.vendorName}</p>}
                </td>
                <td className="n text-sm">{fmtCny(e.amountCny ?? e.amount)}</td>
                <td className="n text-xs text-ink-muted">{fmtKrw(e.amountKrw)}</td>
                <td className="text-xs">
                  {e.allocs.length > 0 ? (
                    e.allocs.map((a) => (
                      <Link key={a.id.toString()} href={`/orders/${a.orderId}`}
                        className="mr-1 no-underline">
                        <span className="pill-good">{a.order.orderNo}</span>
                        <span className="ml-1 text-ink-muted">{a.order.partner.name}</span>
                      </Link>
                    ))
                  ) : (
                    <span className="pill-neutral">운영비 — 미귀속</span>
                  )}
                </td>
                <td className="num text-xs">{e.paidAt ? fmtDate(e.paidAt) : '—'}</td>
                <td>
                  {can(user.role, 'transaction.void') && (
                    <VoidExpenseButton expenseId={e.id.toString()} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
