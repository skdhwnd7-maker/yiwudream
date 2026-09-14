'use client'

import { useActionState, useState } from 'react'
import type { InvoiceStatus } from '@prisma/client'
import { SubmitButton, FormError } from '@/components/ui'
import { issueInvoice, cancelInvoice, type ActionState } from './actions'
import { todayISO } from '@/lib/serialize'

export default function InvoiceRowActions({
  invoiceId, status,
}: {
  invoiceId: string; status: InvoiceStatus
}) {
  const [issState, issAction] = useActionState<ActionState, FormData>(issueInvoice, {})
  const [canState, canAction] = useActionState<ActionState, FormData>(cancelInvoice, {})
  const [mode, setMode] = useState<'none' | 'issue' | 'cancel'>('none')

  if (mode === 'issue') {
    return (
      <form action={issAction} className="min-w-[180px] space-y-1.5">
        <FormError message={issState.error} />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input name="issueDate" type="date" defaultValue={todayISO()} className="text-xs" />
        <input name="ntsApprovalNo" placeholder="승인번호 (선택)" className="text-xs" />
        <div className="flex gap-1.5">
          <SubmitButton className="btn-primary btn-sm" pendingLabel="…">발행</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  if (mode === 'cancel') {
    return (
      <form action={canAction} className="min-w-[180px] space-y-1.5">
        <FormError message={canState.error} />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input name="reason" placeholder="취소 사유 (필수)" required className="text-xs" />
        <div className="flex gap-1.5">
          <SubmitButton className="btn-danger btn-sm" pendingLabel="…">취소</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex gap-1">
      {status === 'PENDING' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('issue')}>발행처리</button>
      )}
      {status !== 'CANCELLED' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('cancel')}>취소</button>
      )}
    </div>
  )
}
