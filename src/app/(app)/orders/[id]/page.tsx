import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { summarizeOrder, COST_GROUPS } from '@/lib/order-calc'
import { fmtKrw, fmtCny, fmtPercent, fmtRate, D } from '@/lib/money'
import { fmtDate, fmtDateTime, plain } from '@/lib/serialize'
import { AUDIT_ACTION_LABEL } from '@/lib/audit'
import { ROUTE_LABEL, ORDER_STATUS_LABEL, SPLIT_KIND_LABEL, SPLIT_OWNER, VAT_MODE_LABEL } from '@/lib/labels'
import { can } from '@/lib/permissions'
import OrderActions from './OrderActions'
import VoidReceiptButton from './VoidReceiptButton'
import VoidExpenseButton from '@/components/VoidExpenseButton'
import AddReceiptPanel from './AddReceiptPanel'
import AddExpensePanel from './AddExpensePanel'

export const dynamic = 'force-dynamic'

export default async function OrderDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ created?: string }>
}) {
  const user = await requireUser()
  const { id } = await params
  const sp = await searchParams
  let orderId: bigint
  try { orderId = BigInt(id) } catch { notFound() }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      partner: true,
      dealType: true,
      receipts: {
        include: { splits: true, account: { select: { name: true, currency: true } } },
        orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }],
      },
      expenseAllocs: {
        include: { expense: { include: { category: true, account: { select: { name: true } } } } },
        orderBy: { id: 'asc' },
      },
      remitAllocs: { include: { remittance: true } },
    },
  })
  if (!order) notFound()

  const [summary, accounts, categories, logs] = await Promise.all([
    summarizeOrder(orderId),
    prisma.account.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { tableName: 'orders', recordId: orderId },
          { tableName: 'receipts', recordId: { in: order.receipts.map((r) => r.id) } },
          { tableName: 'expenses', recordId: { in: order.expenseAllocs.map((a) => a.expenseId) } },
        ],
      },
      orderBy: { changedAt: 'desc' },
      take: 20,
      include: { user: { select: { name: true } } },
    }),
  ])

  const cur = order.settlementCurrency
  const money = (v: unknown) => (cur === 'CNY' ? fmtCny(String(v)) : fmtKrw(String(v)))
  const locked = order.status === 'SETTLED'
  const isNet = order.dealType.revenueBasis === 'NET'

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {sp.created === '1' && (
        <div className="rounded-sm border border-jade bg-jade-soft px-4 py-3 text-sm text-jade">
          <b className="num">{order.orderNo}</b> 주문을 만들었습니다. 이제 지출을 추가하시면 마진이 자동으로 계산됩니다.
        </div>
      )}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="section-title num text-xl">{order.orderNo}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <Link href={`/partners/${order.partnerId}`} className="no-underline hover:underline">{order.partner.name}</Link>
            <span className="pill-neutral">{ROUTE_LABEL[order.route]}</span>
            <span className="pill-neutral">{order.dealType.name}</span>
            <span className={locked ? 'pill-good' : 'pill-neutral'}>{ORDER_STATUS_LABEL[order.status]}</span>
            {order.externalRef && <span className="pill-gold">기존번호 {order.externalRef}</span>}
            {order.isVoid && <span className="pill-warn">취소됨</span>}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {fmtDate(order.orderDate)} · 정산통화 {cur} · 회계분류 {order.accountingClass}
            {order.title && ` · ${order.title}`}
          </p>
        </div>
        <OrderActions
          orderId={order.id.toString()}
          status={order.status}
          canSettle={can(user.role, 'transaction.write')}
          canUnlock={can(user.role, 'transaction.void')}
        />
      </header>

      {locked && (
        <div className="rounded-sm border border-jade bg-jade-soft px-4 py-2.5 text-sm text-jade">
          정산완료된 주문입니다. 전표를 추가하거나 고치려면 잠금을 해제해야 하고, 그 기록이 남습니다.
          {order.settledMargin && (
            <> 확정 마진 <b className="num">{money(order.settledMargin)}</b></>
          )}
        </div>
      )}

      {/* 요약 */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">정산 요약</h2></div>
          <div className="card-body">
            <table>
              <tbody>
                <Row label="총 입금액" value={money(summary.grossIn)} muted note="통장에 들어온 돈" />
                {summary.depositGoodsIn.gt(0) && (
                  <Row label="├ 상품구매 예치금" value={money(summary.depositGoodsIn)} tone="clay" note="고객 돈" />
                )}
                {summary.depositGeneralIn.gt(0) && (
                  <Row label="├ 용도미지정 예치금" value={money(summary.depositGeneralIn)} tone="clay" note="고객 돈" />
                )}
                {summary.feeIn.gt(0) && <Row label="├ 구매대행 수수료" value={money(summary.feeIn)} tone="jade" />}
                {summary.salesIn.gt(0) && <Row label="├ 공급가액" value={money(summary.salesIn)} tone="jade" />}
                {summary.vatIn.gt(0) && (
                  <Row label="└ 부가세" value={money(summary.vatIn)} tone="gold" note="국세청 돈" />
                )}
                <tr className="border-t border-line-strong">
                  <td className="pt-2 text-sm font-semibold">매출인식액</td>
                  <td className="n pt-2 text-sm font-semibold text-jade">{money(summary.revenue)}</td>
                  <td className="pt-2" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">비용과 마진</h2></div>
          <div className="card-body">
            <table>
              <tbody>
                {COST_GROUPS.map((g) =>
                  summary.costs[g.key].gt(0) ? (
                    <Row key={g.key} label={g.label} value={money(summary.costs[g.key])} />
                  ) : null,
                )}
                {summary.totalCost.isZero() && (
                  <tr><td colSpan={3} className="py-3 text-center text-sm text-ink-muted">아직 지출이 없습니다.</td></tr>
                )}
                {isNet && summary.depositFundedCost.gt(0) && (
                  <Row label="ㄴ 예치금에서 지출" value={`−${money(summary.depositFundedCost)}`} tone="clay"
                    note="회사 비용 아님" />
                )}
                <tr className="border-t border-line">
                  <td className="pt-2 text-sm">회사부담 비용</td>
                  <td className="n pt-2 text-sm">{money(summary.companyCost)}</td>
                  <td className="pt-2" />
                </tr>
                <tr className="border-t border-line-strong">
                  <td className="pt-2 text-sm font-semibold">최종 마진</td>
                  <td className={`n pt-2 text-sm font-semibold ${summary.margin.lt(0) ? 'text-clay' : 'text-jade'}`}>
                    {money(summary.margin)}
                  </td>
                  <td className="pt-2 pl-3 text-xs text-ink-muted">
                    {fmtPercent(summary.marginRatePct)}
                  </td>
                </tr>
                <tr>
                  <td className="text-xs text-ink-muted">원가 대비 수익률</td>
                  <td className="n text-xs text-ink-muted">{fmtPercent(summary.costMarkupPct)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">기존 엑셀 % 열</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {(summary.receivable.gt(0) || summary.depositGoodsIn.gt(0)) && (
        <section className="grid gap-4 md:grid-cols-2">
          {summary.receivable.gt(0) && (
            <div className="card border-clay bg-clay-soft">
              <div className="card-body">
                <p className="text-sm font-medium text-clay">받을 돈 (미수금)</p>
                <p className="mt-1 num text-xl font-semibold text-clay">{money(summary.receivable)}</p>
                <p className="hint mt-1">지출이 입금보다 많습니다. 아직 청구하지 않았거나 못 받은 금액입니다.</p>
              </div>
            </div>
          )}
          {summary.depositGoodsIn.gt(0) && (
            <div className="card">
              <div className="card-body">
                <p className="text-sm font-medium">중국 송금</p>
                <div className="mt-2 h-2 overflow-hidden rounded-sm border border-line bg-sunken">
                  <div className="h-full bg-jade"
                    style={{ width: `${Math.min(100, Number(summary.remitted.div(summary.depositGoodsIn).mul(100)))}%` }} />
                </div>
                <div className="mt-1.5 flex justify-between text-xs">
                  <span className="text-jade">송금완료 {money(summary.remitted)}</span>
                  <span className="text-clay">대기 {money(summary.remitPending)}</span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 입금 내역 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">입금 내역</h2>
          <span className="text-xs text-ink-muted">{order.receipts.length}건</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-24">일자</th>
                <th className="w-32">계좌</th>
                <th className="w-28 n">금액</th>
                <th className="w-20 n">환율</th>
                <th>분해</th>
                <th className="w-20"> </th>
              </tr>
            </thead>
            <tbody>
              {order.receipts.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-muted">입금 내역이 없습니다.</td></tr>
              )}
              {order.receipts.map((r) => (
                <tr key={r.id.toString()} className={r.isVoid ? 'text-ink-muted line-through' : ''}>
                  <td className="num text-xs">{fmtDate(r.receiptDate)}</td>
                  <td className="text-xs">
                    {r.account.name}
                    {r.source === 'FROM_DEPOSIT' && <span className="ml-1 pill-warn">예치금충당</span>}
                  </td>
                  <td className="n text-xs">
                    {r.currency === 'CNY' ? fmtCny(r.amount.toString()) : fmtKrw(r.amount.toString())}
                    {r.usdAmount && <p className="text-[10px] text-ink-muted">USD {fmtCny(r.usdAmount.toString())}</p>}
                  </td>
                  <td className="n text-xs text-ink-muted">{r.fxRate ? fmtRate(r.fxRate.toString()) : '—'}</td>
                  <td className="text-xs">
                    <div className="flex flex-wrap gap-1.5">
                      {r.splits.map((s) => {
                        const owner = SPLIT_OWNER[s.splitKind]
                        return (
                          <span key={s.id.toString()}
                            className={owner === '회사' ? 'pill-good' : owner === '국세청' ? 'pill-gold' : 'pill-warn'}>
                            {SPLIT_KIND_LABEL[s.splitKind]} {r.currency === 'CNY' ? fmtCny(s.amount.toString()) : fmtKrw(s.amount.toString())}
                          </span>
                        )
                      })}
                    </div>
                    {r.isVoid && r.voidReason && <p className="mt-1 text-[11px] text-clay">취소: {r.voidReason}</p>}
                  </td>
                  <td>
                    {!r.isVoid && !locked && can(user.role, 'transaction.void') && (
                      <VoidReceiptButton receiptId={r.id.toString()} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!locked && can(user.role, 'transaction.write') && (
          <div className="border-t border-line px-5 py-4">
            <AddReceiptPanel
              orderId={order.id.toString()}
              accounts={plain(accounts)}
              route={order.route}
              vatMode={order.dealType.vatMode}
              settlementCurrency={order.settlementCurrency}
            />
          </div>
        )}
      </section>

      {/* 지출 내역 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">지출 내역</h2>
          <span className="text-xs text-ink-muted">{order.expenseAllocs.length}건</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-24">일자</th>
                <th className="w-28">분류</th>
                <th>지급처</th>
                <th className="w-28 n">금액</th>
                <th className="w-20 n">환율</th>
                <th className="w-28 n">이 주문 배분</th>
                <th className="w-20">지급</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {order.expenseAllocs.length === 0 && (
                <tr><td colSpan={8} className="py-6 text-center text-sm text-ink-muted">지출 내역이 없습니다.</td></tr>
              )}
              {order.expenseAllocs.map((a) => {
                const e = a.expense
                return (
                  <tr key={a.id.toString()} className={e.isVoid ? 'text-ink-muted line-through' : ''}>
                    <td className="num text-xs">{fmtDate(e.expenseDate)}</td>
                    <td className="text-xs">{e.category.name}</td>
                    <td className="text-xs">
                      {e.vendorName ?? '—'}
                      {e.workDesc && <p className="text-[11px] text-ink-muted">{e.workDesc}</p>}
                    </td>
                    <td className="n text-xs">
                      {e.currency === 'CNY' ? `CNY ${fmtCny(e.amount.toString())}` : fmtKrw(e.amount.toString())}
                    </td>
                    <td className="n text-xs text-ink-muted">{e.fxRate ? fmtRate(e.fxRate.toString()) : '—'}</td>
                    <td className="n text-xs">{money(cur === 'CNY' ? a.allocCny ?? 0 : a.allocKrw)}</td>
                    <td className="text-xs">
                      {e.paymentStatus === 'PAID'
                        ? <span className="pill-good">완료</span>
                        : <span className="pill-warn">예정</span>}
                    </td>
                    <td>
                      {!locked && !e.isVoid && can(user.role, 'transaction.void') && (
                        <VoidExpenseButton expenseId={e.id.toString()} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!locked && can(user.role, 'transaction.write') && (
          <div className="border-t border-line px-5 py-4">
            <AddExpensePanel
              orderId={order.id.toString()}
              orderNo={order.orderNo}
              categories={plain(categories)}
              accounts={plain(accounts)}
            />
          </div>
        )}
      </section>

      {/* 이력 */}
      <section className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">변경이력</h2></div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-44">일시</th>
                <th className="w-24">사용자</th>
                <th className="w-20">동작</th>
                <th>내용</th>
                <th className="w-40">사유</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-sm text-ink-muted">이력이 없습니다.</td></tr>
              )}
              {logs.map((log) => (
                <tr key={log.id.toString()}>
                  <td className="num text-xs text-ink-muted">{fmtDateTime(log.changedAt)}</td>
                  <td className="text-xs">{log.user.name}</td>
                  <td className="text-xs">{AUDIT_ACTION_LABEL[log.action]}</td>
                  <td className="text-xs text-ink-2">
                    {log.fieldName ? (
                      <>
                        <span className="font-mono">{log.fieldName}</span>{' : '}
                        <span className="text-clay">{log.oldValue ?? '—'}</span>{' → '}
                        <span className="text-jade">{log.newValue ?? '—'}</span>
                      </>
                    ) : (
                      <span className="font-mono text-[11px] text-ink-muted">
                        {(log.newValue ?? '').slice(0, 100)}
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-ink-muted">{log.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Row({
  label, value, tone, note, muted,
}: {
  label: string; value: string; tone?: 'jade' | 'clay' | 'gold'; note?: string; muted?: boolean
}) {
  const color = tone === 'jade' ? 'text-jade' : tone === 'clay' ? 'text-clay' : tone === 'gold' ? 'text-gold' : ''
  return (
    <tr>
      <td className={`text-sm ${muted ? 'text-ink-muted' : ''}`}>{label}</td>
      <td className={`n text-sm ${color}`}>{value}</td>
      <td className="pl-3 text-[11px] text-ink-muted">{note ?? ''}</td>
    </tr>
  )
}
