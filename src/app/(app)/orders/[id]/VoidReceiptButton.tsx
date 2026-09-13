'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError } from '@/components/ui'
import { voidReceipt, type ActionState } from '../actions'

export default function VoidReceiptButton({ receiptId }: { receiptId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(voidReceipt, {})
  const [open, setOpen] = useState(false)

  if (!open) {
    return <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>취소</button>
  }

  return (
    <form action={action} className="min-w-[220px] space-y-1.5">
      <FormError message={state.error} />
      <input type="hidden" name="receiptId" value={receiptId} />
      <input name="reason" placeholder="취소 사유 (필수)" required className="text-xs" />
      <p className="hint">행은 지워지지 않고 취소 표시만 남습니다.</p>
      <div className="flex gap-1.5">
        <SubmitButton className="btn-danger btn-sm" pendingLabel="…">확인</SubmitButton>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>닫기</button>
      </div>
    </form>
  )
}
