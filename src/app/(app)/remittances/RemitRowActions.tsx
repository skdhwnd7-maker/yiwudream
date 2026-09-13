'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError } from '@/components/ui'
import { markArrived, voidRemittance, type ActionState } from './actions'

export default function RemitRowActions({
  remittanceId, status, cnyArrival,
}: {
  remittanceId: string; status: string; cnyArrival: string
}) {
  const [arrState, arrAction] = useActionState<ActionState, FormData>(markArrived, {})
  const [voidState, voidAction] = useActionState<ActionState, FormData>(voidRemittance, {})
  const [mode, setMode] = useState<'none' | 'arrive' | 'void'>('none')

  if (mode === 'arrive') {
    return (
      <form action={arrAction} className="min-w-[180px] space-y-1.5">
        <FormError message={arrState.error} />
        <input type="hidden" name="remittanceId" value={remittanceId} />
        <input name="cnyArrivalAmount" defaultValue={cnyArrival} placeholder="CNY 도착금액"
          inputMode="decimal" className="num text-xs" required />
        <div className="flex gap-1.5">
          <SubmitButton className="btn-primary btn-sm" pendingLabel="…">확인</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  if (mode === 'void') {
    return (
      <form action={voidAction} className="min-w-[180px] space-y-1.5">
        <FormError message={voidState.error} />
        <input type="hidden" name="remittanceId" value={remittanceId} />
        <input name="reason" placeholder="취소 사유 (필수)" required className="text-xs" />
        <p className="hint">예치금이 원래대로 되돌아갑니다.</p>
        <div className="flex gap-1.5">
          <SubmitButton className="btn-danger btn-sm" pendingLabel="…">취소</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex gap-1">
      {status !== 'ARRIVED' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('arrive')}>도착확인</button>
      )}
      <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('void')}>취소</button>
    </div>
  )
}
