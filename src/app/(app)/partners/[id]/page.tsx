import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtDateTime } from '@/lib/serialize'
import { AUDIT_ACTION_LABEL } from '@/lib/audit'
import { ROUTE_LABEL } from '@/lib/labels'
import PartnerForm from '../PartnerForm'
import AliasPanel from './AliasPanel'
import { updatePartner } from '../actions'

export const dynamic = 'force-dynamic'

export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser()
  const { id } = await params
  let partnerId: bigint
  try { partnerId = BigInt(id) } catch { notFound() }

  const [partner, dealTypes, logs] = await Promise.all([
    prisma.partner.findUnique({
      where: { id: partnerId },
      include: { aliases: { orderBy: { alias: 'asc' } }, defaultDealType: true },
    }),
    prisma.dealType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, code: true } }),
    prisma.auditLog.findMany({
      where: { tableName: 'partners', recordId: partnerId },
      orderBy: { changedAt: 'desc' },
      take: 15,
      include: { user: { select: { name: true } } },
    }),
  ])

  if (!partner) notFound()

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">{partner.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className="num">{partner.code}</span>
            {partner.defaultRoute && <span className="pill-neutral">{ROUTE_LABEL[partner.defaultRoute]}</span>}
            {!partner.isActive && <span className="pill-warn">비활성</span>}
            {partner.isInternal && <span className="pill-gold">내부 계정</span>}
          </p>
        </div>
        <Link href="/partners" className="btn-ghost no-underline">목록으로</Link>
      </header>

      {/* Phase 2 전까지는 누적 실적을 계산할 전표가 없다. 자리만 잡아 둔다. */}
      <div className="card bg-sunken">
        <div className="card-body text-sm text-ink-muted">
          누적 입금·상품구매·마진·예치금·미수금은 <strong>Phase 2 거래 원장</strong>이 올라간 뒤 이 자리에 표시됩니다.
        </div>
      </div>

      <AliasPanel
        partnerId={partner.id.toString()}
        partnerName={partner.name}
        aliases={partner.aliases.map((a) => ({ id: a.id.toString(), alias: a.alias, source: a.source }))}
      />

      <PartnerForm
        mode="edit"
        action={updatePartner}
        dealTypes={dealTypes.map((d) => ({ ...d, id: d.id.toString() }))}
        values={{
          id: partner.id.toString(),
          name: partner.name,
          bizNo: partner.bizNo ?? '',
          ceoName: partner.ceoName ?? '',
          contact: partner.contact ?? '',
          phone: partner.phone ?? '',
          email: partner.email ?? '',
          defaultRoute: partner.defaultRoute ?? '',
          defaultDealTypeId: partner.defaultDealTypeId?.toString() ?? '',
          taxInvoiceDefault: partner.taxInvoiceDefault,
          defaultFeeRate: partner.defaultFeeRate?.toString() ?? '',
          defaultMarkupRate: partner.defaultMarkupRate?.toString() ?? '',
          memo: partner.memo ?? '',
        }}
      />

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
                <tr><td colSpan={5} className="py-8 text-center text-sm text-ink-muted">이력이 없습니다.</td></tr>
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
                    ) : '생성'}
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
