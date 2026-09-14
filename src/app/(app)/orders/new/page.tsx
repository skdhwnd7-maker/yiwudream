import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { plain } from '@/lib/serialize'
import OrderWizard from './OrderWizard'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string; route?: string }>
}) {
  await requirePermission('transaction.write')
  const sp = await searchParams

  const [partners, dealTypes, accounts, fxRef] = await Promise.all([
    prisma.partner.findMany({
      where: { isActive: true, isInternal: false },
      select: {
        id: true, code: true, name: true, defaultRoute: true, defaultDealTypeId: true,
        defaultFeeRate: true, taxInvoiceDefault: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.dealType.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: [{ entity: 'asc' }, { name: 'asc' }] }),
    prisma.fxRateRef.findFirst({
      where: { baseCurrency: 'CNY', quoteCurrency: 'KRW' },
      orderBy: { rateDate: 'desc' },
    }),
  ])

  // 거래처별 예치금 잔액 — 등록 화면에서 바로 보여준다
  const depositRows = await prisma.depositLedger.groupBy({
    by: ['partnerId'],
    _sum: { amountKrw: true },
  })
  const deposits = Object.fromEntries(
    depositRows.map((r) => [r.partnerId.toString(), (r._sum.amountKrw ?? 0).toString()]),
  )

  return (
    <div className="mx-auto max-w-4xl">
      <OrderWizard
        partners={plain(partners)}
        dealTypes={plain(dealTypes)}
        accounts={plain(accounts)}
        deposits={deposits}
        refRate={fxRef ? fxRef.rate.toString() : null}
        initialPartnerId={sp.partner ?? ''}
        initialRoute={sp.route ?? ''}
      />
    </div>
  )
}
