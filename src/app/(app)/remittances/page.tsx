import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { listRemitPending } from '@/lib/funds'
import { fmtKrw, fmtCny, fmtRate, D } from '@/lib/money'
import { fmtDate, plain } from '@/lib/serialize'
import { can } from '@/lib/permissions'
import RemitRowActions from './RemitRowActions'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중', SENT: '송금완료', ARRIVED: '도착확인', CANCELLED: '취소',
}

export default async function RemittancesPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; done?: string }>
}) {
  const user = await requirePermission('remittance.execute')
  const sp = await searchParams
  const showDone = sp.done === '1'

  const [pending, history] = await Promise.all([
    listRemitPending(showDone),
    prisma.remittance.findMany({
      include: {
        fromAccount: { select: { name: true } },
        toAccount: { select: { name: true } },
        allocs: { include: { partner: { select: { name: true } }, order: { select: { orderNo: true } } } },
      },
      orderBy: [{ remitDate: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
  ])

  const totalPending = pending.reduce((s, r) => s.plus(r.pending), D(0))
  const canExecute = can(user.role, 'remittance.execute')

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {sp.created && (
        <div className="rounded-sm border border-jade bg-jade-soft px-4 py-3 text-sm text-jade">
          송금을 등록했습니다. 해당 거래처의 예치금에서 자동으로 차감됐습니다.
        </div>
      )}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">해외송금 관리</h1>
          <p className="mt-1 text-sm text-ink-muted">
            고객에게 받아 중국으로 보내야 할 돈을 관리합니다.
          </p>
        </div>
        {canExecute && pending.length > 0 && (
          <Link href="/remittances/new" className="btn-primary no-underline">+ 송금 등록</Link>
        )}
      </header>

      {/* 보내야 할 돈 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">송금해야 할 돈</h2>
          <span className="num text-sm font-semibold text-clay">₩ {fmtKrw(totalPending)}</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th>거래처</th>
                <th className="w-40">주문번호</th>
                <th className="w-32 n">상품자금</th>
                <th className="w-32 n">송금완료</th>
                <th className="w-32 n">송금대기</th>
                <th className="w-24">상태</th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-ink-muted">
                    보내야 할 돈이 없습니다. 사이트통장으로 상품구매 예치금이 들어오면 여기에 나타납니다.
                  </td>
                </tr>
              )}
              {pending.map((r) => (
                <tr key={r.orderId}>
                  <td className="text-sm">
                    <Link href={`/partners/${r.partnerId}`} className="no-underline hover:underline">{r.partnerName}</Link>
                  </td>
                  <td>
                    <Link href={`/orders/${r.orderId}`} className="num text-xs no-underline hover:underline">{r.orderNo}</Link>
                    <p className="text-[11px] text-ink-muted">{fmtDate(r.orderDate)}</p>
                  </td>
                  <td className="n text-sm">{fmtKrw(r.goodsFund)}</td>
                  <td className="n text-sm text-jade">{fmtKrw(r.remitted)}</td>
                  <td className="n text-sm font-medium text-clay">{fmtKrw(r.pending)}</td>
                  <td className="text-xs">
                    <span className={
                      r.status === 'OVER' ? 'pill-warn'
                        : r.status === 'DONE' ? 'pill-good'
                          : r.status === 'PARTIAL' ? 'pill-gold' : 'pill-warn'
                    } title={r.status === 'OVER'
                      ? `예치금보다 ${r.excess.toDecimalPlaces(0).toString()}원 더 보냈습니다. 확인이 필요합니다.`
                      : undefined}>
                      {r.status === 'OVER' ? '초과송금 ⚠'
                        : r.status === 'DONE' ? '완료'
                          : r.status === 'PARTIAL' ? '일부송금' : '대기'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-2.5">
          <Link href={showDone ? '/remittances' : '/remittances?done=1'} className="text-xs no-underline hover:underline">
            {showDone ? '대기 건만 보기' : '완료 건도 보기'}
          </Link>
          {canExecute && pending.length > 0 && (
            <Link href="/remittances/new" className="text-xs no-underline hover:underline">여러 건 합쳐서 송금 →</Link>
          )}
        </div>
      </section>

      {/* 송금 이력 */}
      <section className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">송금 이력</h2></div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-36">송금번호</th>
                <th className="w-24">송금일</th>
                <th className="w-28 n">KRW</th>
                <th className="w-24 n">USD</th>
                <th className="w-28 n">CNY 도착</th>
                <th className="w-20 n">실효환율</th>
                <th>배분</th>
                <th className="w-24">상태</th>
                <th className="w-24"> </th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-sm text-ink-muted">송금 이력이 없습니다.</td></tr>
              )}
              {history.map((r) => (
                <tr key={r.id.toString()} className={r.isVoid ? 'text-ink-muted line-through' : ''}>
                  <td className="num text-xs">{r.remitNo}</td>
                  <td className="num text-xs">{fmtDate(r.remitDate)}</td>
                  <td className="n text-xs">{fmtKrw(r.krwAmount)}</td>
                  <td className="n text-xs">{r.usdAmount ? fmtCny(r.usdAmount) : '—'}</td>
                  <td className="n text-xs">{r.cnyArrivalAmount ? fmtCny(r.cnyArrivalAmount) : '—'}</td>
                  <td className="n text-xs text-ink-muted">{r.fxRateKrwCny ? fmtRate(r.fxRateKrwCny) : '—'}</td>
                  <td className="text-xs">
                    <div className="flex flex-wrap gap-1">
                      {r.allocs.map((a) => (
                        <span key={a.id.toString()} className="pill-neutral">
                          {a.partner.name} {fmtKrw(a.allocKrw)}
                        </span>
                      ))}
                    </div>
                    {r.isVoid && r.voidReason && <p className="mt-1 text-[11px] text-clay">취소: {r.voidReason}</p>}
                  </td>
                  <td className="text-xs">
                    <span className={r.status === 'ARRIVED' ? 'pill-good' : r.status === 'CANCELLED' ? 'pill-warn' : 'pill-neutral'}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td>
                    {canExecute && !r.isVoid && (
                      <RemitRowActions
                        remittanceId={r.id.toString()}
                        status={r.status}
                        cnyArrival={r.cnyArrivalAmount?.toString() ?? ''}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
