import Link from 'next/link'
import { prisma } from '@/lib/db'
import { monthRange, currentYm } from '@/lib/dashboard'

/**
 * 입력만 하는 직원이 보는 첫 화면.
 *
 * 대표님 지시: 「직원들은 입력을 해 넣어야 되니 입력할 수 있게만」.
 * 회사 마진·통장 잔액·거래처별 순위는 보이지 않는다.
 * 대신 자기가 오늘 무엇을 해야 하는지가 보인다 — 금액이 아니라 건수다.
 */
export default async function StaffHome({ userId, userName }: { userId: bigint; userName: string }) {
  const ym = currentYm()
  const { from, to, label } = monthRange(ym)

  const [myOrders, myReceipts, myExpenses, openOrders, unallocated, recent] = await Promise.all([
    prisma.order.count({ where: { createdBy: userId, orderDate: { gte: from, lte: to }, isVoid: false } }),
    prisma.receipt.count({ where: { createdBy: userId, receiptDate: { gte: from, lte: to }, isVoid: false } }),
    prisma.expense.count({ where: { createdBy: userId, expenseDate: { gte: from, lte: to }, isVoid: false } }),
    prisma.order.count({ where: { status: 'OPEN', isVoid: false } }),
    // 주문에 붙지 않은 지출 — 붙여야 그 거래의 원가가 된다
    prisma.expense.count({
      where: { isVoid: false, allocs: { none: {} }, category: { costType: 'ORDER_COST' } },
    }),
    prisma.order.findMany({
      where: { createdBy: userId, isVoid: false },
      include: { partner: { select: { name: true } } },
      orderBy: { id: 'desc' },
      take: 8,
    }),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="section-title text-xl">{userName} 님</h1>
        <p className="mt-1 text-sm text-ink-muted">{label} · 오늘 하실 일과 이번 달 입력 현황입니다.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Link href="/orders/new" className="btn-primary no-underline">새 거래 등록</Link>
        <Link href="/orders" className="btn-ghost no-underline">거래 목록</Link>
        <Link href="/partners" className="btn-ghost no-underline">거래처 관리</Link>
      </div>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">이번 달 내가 입력한 것</h2></div>
        <div className="card-body grid gap-4 sm:grid-cols-3">
          <Tile label="거래" value={myOrders} />
          <Tile label="입금" value={myReceipts} />
          <Tile label="지출" value={myExpenses} />
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">챙길 것</h2></div>
        <div className="card-body grid gap-4 sm:grid-cols-2">
          <Tile label="진행중인 거래" value={openOrders} href="/orders?status=OPEN"
            note="아직 정산이 끝나지 않은 거래입니다." />
          <Tile label="거래에 안 붙은 지출" value={unallocated} tone={unallocated > 0 ? 'text-clay' : ''}
            note="지출을 거래에 연결해야 그 거래의 원가가 됩니다." />
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">내가 최근에 등록한 거래</h2></div>
        {recent.length === 0 ? (
          <div className="card-body text-sm text-ink-muted">아직 등록한 거래가 없습니다.</div>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th className="w-40">거래번호</th>
                  <th>거래처</th>
                  <th className="w-28">일자</th>
                  <th className="w-20">상태</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((o) => (
                  <tr key={o.id.toString()}>
                    <td className="font-mono text-xs">
                      <Link href={`/orders/${o.id}`} className="hover:underline">{o.orderNo}</Link>
                    </td>
                    <td className="text-sm">{o.partner.name}</td>
                    <td className="font-mono text-xs text-ink-muted">
                      {o.orderDate.toISOString().slice(0, 10)}
                    </td>
                    <td className="text-xs">
                      {o.status === 'SETTLED'
                        ? <span className="pill-good">정산완료</span>
                        : <span className="pill-neutral">진행중</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card bg-sunken">
        <div className="card-body hint">
          고치신 내용은 전부 기록에 남습니다 — 무엇을 어떻게 바꾸셨는지, 언제, 누가.
          잘못 넣으셨으면 지우지 마시고 그대로 고치시면 됩니다.
        </div>
      </div>
    </div>
  )
}

function Tile({
  label, value, note, tone = '', href,
}: { label: string; value: number; note?: string; tone?: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-2xl ${tone}`}>{value.toLocaleString('ko-KR')}</div>
      {note && <p className="mt-1 text-xs leading-relaxed text-ink-3">{note}</p>}
    </>
  )
  return href
    ? <Link href={href} className="block no-underline text-ink">{body}</Link>
    : <div>{body}</div>
}
