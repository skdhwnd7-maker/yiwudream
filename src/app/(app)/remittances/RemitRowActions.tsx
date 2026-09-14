'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError } from '@/components/ui'
import { markArrived, sendRemittance, voidRemittance, type ActionState } from './actions'

export default function RemitRowActions({
  remittanceId, status, cnyArrival,
}: {
  remittanceId: string; status: string; cnyArrival: string
}) {
  const [arrState, arrAction] = useActionState<ActionState, FormData>(markArrived, {})
  const [sendState, sendAction] = useActionState<ActionState, FormData>(sendRemittance, {})
  const [voidState, voidAction] = useActionState<ActionState, FormData>(voidRemittance, {})
  const [mode, setMode] = useState<'none' | 'arrive' | 'void' | 'send'>('none')

  if (mode === 'send') {
    return (
      <form action={sendAction} className="min-w-[180px] space-y-1.5">
        <FormError message={sendState.error} />
        <input type="hidden" name="remittanceId" value={remittanceId} />
        <p className="hint">
          보낸 것으로 처리합니다. 이때 고객 예치금에서 차감되고 한국 통장에서 빠집니다.
        </p>
        <div className="flex gap-1.5">
          <SubmitButton className="btn-primary btn-sm" pendingLabel="…">송금완료</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

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
        <p className="hint">
          {status === 'DRAFT'
            ? '작성중이라 예치금을 건드린 적이 없습니다. 되돌릴 것이 없습니다.'
            : '예치금과 송금수수료가 원래대로 되돌아갑니다.'}
        </p>
        <div className="flex gap-1.5">
          <SubmitButton className="btn-danger btn-sm" pendingLabel="…">취소</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  // 상태에 따라 할 수 있는 것만 보여 준다 — 서버에서도 같은 규칙으로 막는다
  return (
    <div className="flex gap-1">
      {status === 'DRAFT' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('send')}>송금완료</button>
      )}
      {status === 'SENT' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('arrive')}>도착확인</button>
      )}
      {status !== 'CANCELLED' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('void')}>취소</button>
      )}
    </div>
  )
}
