import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtCny, fmtKrw, D } from '@/lib/money'
import { fmtDate, plain } from '@/lib/serialize'
import { can } from '@/lib/permissions'
import ExpenseEntry from './ExpenseEntry'
import VoidExpenseButton from '@/components/VoidExpenseButton'

export const dynamic = 'force-dynamic'

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function OfficePage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>
}) {
  const user = await requireUser()
  const sp = await searchParams
  const ym = /^\d{4}-\d{2}$/.test(sp.ym ?? '') ? sp.ym! : thisMonth()
  const [y, m] = ym.split('-').map(Number)
  const from = new Date(y, m - 1, 1)
  const to = new Date(y, m, 0, 23, 59, 59)

  // 사무실 경비 + 운영비 성격의 다른 분류도 함께 본다
  const [expenses, categories, accounts, monthTotals] = await Promise.all([
    prisma.expense.findMany({
      where: {
        isVoid: false,
        expenseDate: { gte: from, lte: to },
        category: { costType: { in: ['OPERATING', 'BOTH'] } },
        allocs: { none: {} },
      },
      include: { category: true, account: { select: { name: true } } },
      orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
    }),
    prisma.expenseCategory.findMany({
      where: { isActive: true, costType: { in: ['OPERATING', 'BOTH'] } },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where: {
        isVoid: false,
        expenseDate: { gte: from, lte: to },
        category: { costType: { in: ['OPERATING', 'BOTH'] } },
        allocs: { none: {} },
      },
      _sum: { amountCny: true, amountKrw: true },
    }),
  ])

  const catMap = new Map(categories.map((c) => [c.id.toString(), c]))
  const byCategory = monthTotals
    .map((t) => ({
      name: catMap.get(t.categoryId.toString())?.name ?? '(기타)',
      cny: D(t._sum.amountCny ?? 0),
      krw: D(t._sum.amountKrw ?? 0),
    }))
    .filter((x) => x.cny.gt(0) || x.krw.gt(0))
    .sort((a, b) => b.krw.comparedTo(a.krw))

  const totalCny = byCategory.reduce((s, x) => s.plus(x.cny), D(0))
  const totalKrw = byCategory.reduce((s, x) => s.plus(x.krw), D(0))

  // 사무실 경비 분류만 입력 폼에 노출
  const officeCats = categories.filter((c) => c.costType === 'OPERATING' || c.code === 'ETC_ORDER')

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="section-title text-xl">중국 운영비</h1>
        <p className="mt-1 text-sm text-ink-muted">
          주문에 귀속되지 않은 비용입니다. 최종 영업마진에서 차감됩니다.
        </p>
      </header>

      <form method="get" className="card">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ym">조회 월</label>
            <input id="ym" name="ym" defaultValue={ym} placeholder="2026-05" className="num w-32" />
          </div>
          <button type="submit" className="btn-ghost mb-0.5 whitespace-nowrap">조회</button>
        </div>
      </form>

      {byCategory.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">{ym} 분류별 합계</h2>
            <span className="num text-sm font-semibold">CNY {fmtCny(totalCny)} · ₩{fmtKrw(totalKrw)}</span>
          </div>
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr><th>분류</th><th className="w-32 n">CNY</th><th className="w-32 n">원화 환산</th><th className="w-20 n">비중</th></tr>
              </thead>
              <tbody>
                {byCategory.map((c) => (
                  <tr key={c.name}>
                    <td className="text-sm">{c.name}</td>
                    <td className="n text-sm">{c.cny.gt(0) ? fmtCny(c.cny) : '—'}</td>
                    <td className="n text-sm">{fmtKrw(c.krw)}</td>
                    <td className="n text-xs text-ink-muted">
                      {totalKrw.gt(0) ? `${c.krw.div(totalKrw).mul(100).toDecimalPlaces(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {can(user.role, 'transaction.write') && officeCats.length > 0 && (
        <ExpenseEntry mode="office" categories={plain(officeCats)} accounts={plain(accounts)} />
      )}

      <section className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-24">날짜</th>
              <th className="w-32">비용분류</th>
              <th>내용</th>
              <th className="w-28 n">금액</th>
              <th className="w-28 n">원화 환산</th>
              <th className="w-24">결제방법</th>
              <th className="w-20">지급</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 && (
              <tr><td colSpan={8} className="py-8 text-center text-sm text-ink-muted">
                {ym}에 등록된 운영비가 없습니다.
              </td></tr>
            )}
            {expenses.map((e) => (
              <tr key={e.id.toString()}>
                <td className="num text-xs">{fmtDate(e.expenseDate)}</td>
                <td className="text-xs">{e.category.name}</td>
                <td className="text-sm">
                  {e.workDesc ?? e.memo ?? '—'}
                  {e.vendorName && <p className="text-[11px] text-ink-muted">{e.vendorName}</p>}
                </td>
                <td className="n text-sm">
                  {e.currency === 'CNY' ? `CNY ${fmtCny(e.amount)}` : fmtKrw(e.amount)}
                </td>
                <td className="n text-xs text-ink-muted">{fmtKrw(e.amountKrw)}</td>
                <td className="text-xs">{e.paymentMethod ?? '—'}</td>
                <td className="text-xs">
                  {e.paymentStatus === 'PAID'
                    ? <span className="pill-good">완료</span>
                    : <span className="pill-warn">예정</span>}
                </td>
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
