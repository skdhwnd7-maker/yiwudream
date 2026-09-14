import Link from 'next/link'
import { InvoiceStatus } from '@prisma/client'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { listUnbilledVat } from '@/lib/invoice-calc'
import { fmtKrw, D } from '@/lib/money'
import { fmtDate } from '@/lib/serialize'
import { VAT_MODE_LABEL } from '@/lib/labels'
import { can } from '@/lib/permissions'
import InvoiceRowActions from './InvoiceRowActions'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  NONE: '대상 아님', PENDING: '발행예정', ISSUED: '발행완료', CANCELLED: '취소',
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; created?: string }>
}) {
  const user = await requirePermission('invoice.confirm')
  const sp = await searchParams
  const tab = sp.tab === 'unbilled' ? 'unbilled' : 'list'

  const [invoices, unbilled, pendingOrders] = await Promise.all([
    prisma.invoice.findMany({
      include: {
        partner: { select: { name: true } },
        dealType: { select: { name: true } },
        orders: { include: { order: { select: { orderNo: true, id: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    }),
    listUnbilledVat(),
    prisma.order.count({ where: { invoiceStatus: 'PENDING', isVoid: false } }),
  ])

  const live = invoices.filter((i) => !i.isVoid)
  const sumPending = live.filter((i) => i.issueStatus === 'PENDING').reduce((s, i) => s.plus(i.totalAmount), D(0))
  const sumIssued = live.filter((i) => i.issueStatus === 'ISSUED').reduce((s, i) => s.plus(i.totalAmount), D(0))
  const unbilledVat = unbilled.reduce((s, r) => s.plus(r.vatKrw), D(0))
  const canConfirm = can(user.role, 'invoice.confirm')

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {sp.created && (
        <div className="rounded-sm border border-jade bg-jade-soft px-4 py-3 text-sm text-jade">
          세금계산서를 만들었습니다.
        </div>
      )}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">세금계산서 관리</h1>
          <p className="mt-1 text-sm text-ink-muted">
            대상금액은 거래유형 설정으로 산출합니다. 코드에 박아두지 않았습니다.
          </p>
        </div>
        {canConfirm && pendingOrders > 0 && (
          <Link href="/invoices/new" className="btn-primary no-underline">+ 계산서 생성</Link>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="발행 예정" value={fmtKrw(sumPending)} tone="gold" />
        <Stat label="발행 완료" value={fmtKrw(sumIssued)} tone="jade" />
        <Stat label="미발행·부가세 수취" value={fmtKrw(unbilledVat)} tone="clay" sub={`${unbilled.length}건`} />
      </div>

      <nav className="flex gap-1 border-b border-line">
        <Tab href="/invoices" active={tab === 'list'} label={`계산서 목록 (${live.length})`} />
        <Tab href="/invoices?tab=unbilled" active={tab === 'unbilled'} label={`미발행·부가세 수취 (${unbilled.length})`} />
      </nav>

      {tab === 'list' ? (
        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="w-36">번호</th>
                <th>거래처</th>
                <th className="w-36">주문</th>
                <th className="w-32">거래유형</th>
                <th className="w-28 n">공급가액</th>
                <th className="w-24 n">부가세</th>
                <th className="w-28 n">합계</th>
                <th className="w-24">상태</th>
                <th className="w-28"> </th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-sm text-ink-muted">
                  발행한 세금계산서가 없습니다.
                  {pendingOrders === 0 && ' 거래 등록 시 「세금계산서 발행 대상」을 체크하면 여기에 나타납니다.'}
                </td></tr>
              )}
              {invoices.map((i) => (
                <tr key={i.id.toString()} className={i.isVoid ? 'text-ink-muted line-through' : ''}>
                  <td className="num text-xs">
                    {i.invoiceNo}
                    {i.targetAmountSource === 'MANUAL' && <span className="ml-1 pill-gold">수동</span>}
                  </td>
                  <td className="text-sm">{i.partner.name}</td>
                  <td className="text-xs">
                    {i.orders.map((o) => (
                      <Link key={o.id.toString()} href={`/orders/${o.order.id}`}
                        className="num mr-1 no-underline hover:underline">{o.order.orderNo}</Link>
                    ))}
                  </td>
                  <td className="text-xs">
                    {i.dealType.name}
                    <p className="text-[10px] text-ink-muted">{VAT_MODE_LABEL[i.vatMode]}</p>
                  </td>
                  <td className="n text-xs">{fmtKrw(i.supplyAmount)}</td>
                  <td className="n text-xs text-gold">{fmtKrw(i.vatAmount)}</td>
                  <td className="n text-sm font-medium">{fmtKrw(i.totalAmount)}</td>
                  <td className="text-xs">
                    <span className={i.issueStatus === 'ISSUED' ? 'pill-good' : i.issueStatus === 'CANCELLED' ? 'pill-warn' : 'pill-gold'}>
                      {STATUS_LABEL[i.issueStatus]}
                    </span>
                    {i.issueDate && <p className="num mt-0.5 text-[10px] text-ink-muted">{fmtDate(i.issueDate)}</p>}
                  </td>
                  <td>
                    {canConfirm && !i.isVoid && (
                      <InvoiceRowActions invoiceId={i.id.toString()} status={i.issueStatus} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <>
          <div className="card border-clay bg-clay-soft">
            <div className="card-body text-sm leading-relaxed text-ink-2">
              <p className="font-medium text-clay">부가세는 받았는데 세금계산서를 발행하지 않은 건입니다</p>
              <p className="mt-1.5">
                받은 부가세는 신고·납부 의무가 따르고, 세금계산서 미발행은 그와 별개로 문제가 될 수 있습니다.
                <strong> 세무사와 확인해 보시기를 권합니다.</strong>
                프로그램은 세무 판단을 하지 않습니다 — 금액과 목록만 보여드립니다.
              </p>
            </div>
          </div>

          <section className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="w-24">일자</th>
                  <th>거래처</th>
                  <th className="w-40">주문번호</th>
                  <th className="w-32 n">공급가액</th>
                  <th className="w-28 n">받은 부가세</th>
                  <th className="w-20 n">경과</th>
                  <th className="w-24"> </th>
                </tr>
              </thead>
              <tbody>
                {unbilled.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-ink-muted">
                    해당하는 건이 없습니다.
                  </td></tr>
                )}
                {unbilled.map((r) => (
                  <tr key={r.orderId}>
                    <td className="num text-xs">{fmtDate(r.orderDate)}</td>
                    <td className="text-sm">
                      <Link href={`/partners/${r.partnerId}`} className="no-underline hover:underline">{r.partnerName}</Link>
                    </td>
                    <td>
                      <Link href={`/orders/${r.orderId}`} className="num text-xs no-underline hover:underline">{r.orderNo}</Link>
                    </td>
                    <td className="n text-sm">{fmtKrw(r.supplyKrw)}</td>
                    <td className="n text-sm text-clay">{fmtKrw(r.vatKrw)}</td>
                    <td className="n text-xs">
                      <span className={r.daysOld >= 90 ? 'pill-warn' : 'pill-neutral'}>{r.daysOld}일</span>
                    </td>
                    <td>
                      {canConfirm && (
                        <Link href={`/invoices/new?orders=${r.orderId}`} className="btn-ghost btn-sm no-underline">발행</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {unbilled.length > 0 && (
                <tfoot>
                  <tr className="bg-sunken font-semibold">
                    <td colSpan={3} className="text-xs">{unbilled.length}건 합계</td>
                    <td className="n text-sm">{fmtKrw(unbilled.reduce((s, r) => s.plus(r.supplyKrw), D(0)))}</td>
                    <td className="n text-sm text-clay">{fmtKrw(unbilledVat)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone: 'jade' | 'gold' | 'clay'; sub?: string }) {
  const color = tone === 'jade' ? 'text-jade' : tone === 'gold' ? 'text-gold' : 'text-clay'
  return (
    <div className="card">
      <div className="card-body">
        <p className="text-xs text-ink-muted">{label}</p>
        <p className={`mt-1 num text-xl font-semibold ${color}`}>{value}</p>
        {sub && <p className="text-[11px] text-ink-muted">{sub}</p>}
      </div>
    </div>
  )
}

function Tab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link href={href}
      className={`-mb-px border-b-2 px-3 py-2 text-sm no-underline ${
        active ? 'border-jade font-medium text-jade' : 'border-transparent text-ink-2 hover:border-line-strong hover:text-ink'
      }`}>
      {label}
    </Link>
  )
}
