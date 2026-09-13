import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import PartnerForm from '../PartnerForm'
import { createPartner } from '../actions'

export default async function NewPartnerPage() {
  await requireUser()
  const dealTypes = await prisma.dealType.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, code: true },
  })

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h1 className="section-title text-xl">거래처 등록</h1>
      <PartnerForm
        mode="create"
        action={createPartner}
        dealTypes={dealTypes.map((d) => ({ ...d, id: d.id.toString() }))}
        values={{
          name: '', bizNo: '', ceoName: '', contact: '', phone: '', email: '',
          defaultRoute: '', defaultDealTypeId: '', taxInvoiceDefault: false,
          defaultFeeRate: '', defaultMarkupRate: '', memo: '',
        }}
      />
    </div>
  )
}
