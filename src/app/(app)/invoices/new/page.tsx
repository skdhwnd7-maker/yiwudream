import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { draftInvoice } from '@/lib/invoice-calc'
import { plain } from '@/lib/serialize'
import InvoiceForm from './InvoiceForm'

export const dynamic = 'force-dynamic'

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ orders?: string; partner?: string }>
}) {
  await requirePermission('invoice.confirm')
  const sp = await searchParams

  // 발행 대상 주문 — 발행예정이거나, 부가세는 받았는데 미발행인 건
  const candidates = await prisma.order.findMany({
    where: {
      isVoid: false,
      OR: [
        { invoiceStatus: 'PENDING' },
        {
          invoiceStatus: 'NONE',
          receipts: { some: { isVoid: false, splits: { some: { splitKind: 'VAT' } } } },
        },
      ],
      ...(sp.partner ? { partnerId: BigInt(sp.partner) } : {}),
    },
    include: {
      partner: { select: { id: true, name: true } },
      dealType: { select: { name: true, invoiceBase: true, vatMode: true } },
    },
    orderBy: [{ partnerId: 'asc' }, { orderDate: 'asc' }],
    take: 200,
  })

  const preselected = sp.orders ? sp.orders.split(',').filter(Boolean) : []
  const initialDraft = preselected.length > 0
    ? await draftInvoice(preselected.map((v) => BigInt(v)))
    : null

  if (candidates.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="card">
          <div className="card-body text-center">
            <p className="text-sm text-ink-muted">발행 대상 주문이 없습니다.</p>
            <p className="hint mt-1">
              거래 등록 시 「세금계산서 발행 대상」을 체크하면 여기에 나타납니다.
            </p>
            <Link href="/invoices" className="btn-ghost mt-3 no-underline">목록으로</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <InvoiceForm
        candidates={plain(candidates)}
        preselected={preselected}
        initialDraft={initialDraft ? plain(initialDraft) : null}
      />
    </div>
  )
}
