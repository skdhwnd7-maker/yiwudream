import Link from 'next/link'
import { OrderStatus, Route } from '@prisma/client'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { summarizeOrders } from '@/lib/order-calc'
import { fmtKrw, fmtCny, fmtPercent, D } from '@/lib/money'
import { fmtDate } from '@/lib/serialize'
import { ROUTE_LABEL, ORDER_STATUS_LABEL } from '@/lib/labels'
import { EmptyRow } from '@/components/ui'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; route?: string; status?: string; from?: string; to?: string; page?: string; void?: string }>
}) {
  await requireUser()
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page ?? 1) || 1)

  const where = {
    ...(sp.void === '1' ? {} : { isVoid: false }),
    ...(sp.route && sp.route in Route ? { route: sp.route as Route } : {}),
    ...(sp.status && sp.status in OrderStatus ? { status: sp.status as OrderStatus } : {}),
    ...(sp.q
      ? {
          OR: [
            { orderNo: { contains: sp.q, mode: 'insensitive' as const } },
            { externalRef: { contains: sp.q, mode: 'insensitive' as const } },
            { title: { contains: sp.q, mode: 'insensitive' as const } },
            { partner: { name: { contains: sp.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
    ...(sp.from || sp.to
      ? {
          orderDate: {
            ...(sp.from ? { gte: new Date(`${sp.from}T00:00:00`) } : {}),
            ...(sp.to ? { lte: new Date(`${sp.to}T23:59:59`) } : {}),
          },
        }
      : {}),
  }

  const [orders, total, partnerCount] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { partner: { select: { name: true } }, dealType: { select: { name: true } } },
      orderBy: [{ orderDate: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.order.count({ where }),
    prisma.partner.count({ where: { isActive: true, isInternal: false } }),
  ])

  const summaryMap = await summarizeOrders(orders.map((o) => o.id))
  const summaries = orders.map((o) => summaryMap.get(o.id.toString())!)

  // 합계 — 통화가 섞이므로 KRW 환산 기준으로 낸다
  let sumRevenueKrw = D(0), sumCostKrw = D(0), sumMarginKrw = D(0)
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i], s = summaries[i]
    if (o.isVoid) continue
    // 정산통화가 CNY면 환산 KRW 값을 다시 구해야 하므로 여기선 KRW 주문만 합산한다
    if (o.settlementCurrency === 'KRW') {
      sumRevenueKrw = sumRevenueKrw.plus(s.revenue)
      sumCostKrw = sumCostKrw.plus(s.companyCost)
      sumMarginKrw = sumMarginKrw.plus(s.margin)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">거래 목록</h1>
          <p className="mt-1 text-sm text-ink-muted">
            한 주문에 입금과 지출을 모두 묶어 마진을 계산합니다.
          </p>
        </div>
        {partnerCount > 0 ? (
          <Link href="/orders/new" className="btn-primary no-underline">+ 새 거래 등록</Link>
        ) : (
          <Link href="/partners/new" className="btn-ghost no-underline">먼저 거래처를 등록하세요</Link>
        )}
      </header>

      <form className="card" method="get">
        <div className="card-body grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_auto]">
          <div>
            <label htmlFor="q">검색</label>
            <input id="q" name="q" defaultValue={sp.q ?? ''} placeholder="주문번호 · 거래처 · 건명 · 기존번호" />
          </div>
          <div>
            <label htmlFor="route">루트</label>
            <select id="route" name="route" defaultValue={sp.route ?? ''}>
              <option value="">전체</option>
              {(['OVERSEAS', 'BANK_GEN', 'BANK_CORP', 'SITE'] as Route[]).map((r) => (
                <option key={r} value={r}>{ROUTE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="status">상태</label>
            <select id="status" name="status" defaultValue={sp.status ?? ''}>
              <option value="">전체</option>
              {Object.values(OrderStatus).map((s) => (
                <option key={s} value={s}>{ORDER_STATUS_LABEL[s]}</option>
              ))}
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
              <th className="w-40">주문번호</th>
              <th className="w-24">일자</th>
              <th>거래처</th>
              <th className="w-24">루트</th>
              <th className="w-32 n">매출인식액</th>
              <th className="w-32 n">총비용</th>
              <th className="w-32 n">마진</th>
              <th className="w-20 n">마진율</th>
              <th className="w-24">상태</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && <EmptyRow colSpan={9} label="거래가 없습니다. 새 거래를 등록해 보세요." />}
            {orders.map((o, i) => {
              const s = summaries[i]
              const cur = o.settlementCurrency
              const money = (v: unknown) => (cur === 'CNY' ? fmtCny(String(v)) : fmtKrw(String(v)))
              const negative = s.margin.lt(0)
              return (
                <tr key={o.id.toString()} className={o.isVoid ? 'text-ink-muted line-through' : negative ? 'bg-clay-soft/40' : ''}>
                  <td>
                    <Link href={`/orders/${o.id}`} className="num text-xs no-underline hover:underline">{o.orderNo}</Link>
                    {o.externalRef && <span className="ml-1.5 pill-neutral">{o.externalRef}</span>}
                    {o.title && <p className="mt-0.5 text-[11px] text-ink-muted">{o.title}</p>}
                  </td>
                  <td className="num text-xs">
                    {fmtDate(o.orderDate)}
                    {o.orderDateEstimated && <span className="ml-1 text-clay" title="일자 추정">📅?</span>}
                  </td>
                  <td className="text-sm">{o.partner.name}</td>
                  <td className="text-xs">{ROUTE_LABEL[o.route]}</td>
                  <td className="n text-xs">{money(s.revenue)}</td>
                  <td className="n text-xs">{money(s.companyCost)}</td>
                  <td className={`n text-xs font-medium ${negative ? 'text-clay' : 'text-jade'}`}>{money(s.margin)}</td>
                  <td className="n text-xs">{fmtPercent(s.marginRatePct)}</td>
                  <td className="text-xs">
                    <span className={o.status === 'SETTLED' ? 'pill-good' : o.status === 'CANCELLED' ? 'pill-warn' : 'pill-neutral'}>
                      {ORDER_STATUS_LABEL[o.status]}
                    </span>
                    {s.receivable.gt(0) && <span className="ml-1 pill-warn">미수</span>}
                    {s.remitStatus === 'PENDING' && <span className="ml-1 pill-warn">송금대기</span>}
                    {s.remitStatus === 'PARTIAL' && <span className="ml-1 pill-gold">일부송금</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {orders.length > 0 && (
            <tfoot>
              <tr className="bg-sunken font-semibold">
                <td colSpan={4} className="text-xs">이 페이지 합계 (원화 주문만)</td>
                <td className="n text-xs">{fmtKrw(sumRevenueKrw)}</td>
                <td className="n text-xs">{fmtKrw(sumCostKrw)}</td>
                <td className={`n text-xs ${sumMarginKrw.lt(0) ? 'text-clay' : 'text-jade'}`}>{fmtKrw(sumMarginKrw)}</td>
                <td className="n text-xs">
                  {sumRevenueKrw.gt(0) ? fmtPercent(sumMarginKrw.div(sumRevenueKrw).mul(100).toDecimalPlaces(2)) : '—'}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-ink-muted">
        <span className="num">{total.toLocaleString('ko-KR')}건</span>
        <span>{page} / {totalPages}</span>
      </div>
    </div>
  )
}
