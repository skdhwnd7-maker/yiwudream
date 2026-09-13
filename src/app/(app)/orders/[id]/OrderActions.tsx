'use client'

import { useActionState, useState } from 'react'
import type { OrderStatus } from '@prisma/client'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { settleOrder, unlockOrder, type ActionState } from '../actions'

export default function OrderActions({
  orderId, status, canSettle, canUnlock,
}: {
  orderId: string; status: OrderStatus; canSettle: boolean; canUnlock: boolean
}) {
  const [settleState, settleAction] = useActionState<ActionState, FormData>(settleOrder, {})
  const [unlockState, unlockAction] = useActionState<ActionState, FormData>(unlockOrder, {})
  const [confirming, setConfirming] = useState(false)
  const [unlocking, setUnlocking] = useState(false)

  if (status === 'SETTLED') {
    if (!canUnlock) return null
    return (
      <div className="min-w-[280px] space-y-2">
        <FormError message={unlockState.error} />
        <FormOk message={unlockState.ok} />
        {!unlocking ? (
          <button type="button" className="btn-ghost" onClick={() => setUnlocking(true)}>잠금해제</button>
        ) : (
          <form action={unlockAction} className="card">
            <div className="card-body space-y-2">
              <p className="hint">잠금해제는 변경이력에 남고 대시보드에 표시됩니다.</p>
              <input name="reason" placeholder="해제 사유 (필수)" required />
              <input type="hidden" name="orderId" value={orderId} />
              <div className="flex gap-2">
                <SubmitButton className="btn-danger" pendingLabel="처리 중…">해제</SubmitButton>
                <button type="button" className="btn-ghost" onClick={() => setUnlocking(false)}>취소</button>
              </div>
            </div>
          </form>
        )}
      </div>
    )
  }

  if (!canSettle) return null

  return (
    <div className="min-w-[260px] space-y-2">
      <FormError message={settleState.error} />
      <FormOk message={settleState.ok} />
      {!confirming ? (
        <button type="button" className="btn-primary" onClick={() => setConfirming(true)}>정산완료 처리</button>
      ) : (
        <form action={settleAction} className="card">
          <div className="card-body space-y-2">
            <p className="hint">
              정산완료하면 이 주문의 입금·지출을 더 넣거나 고칠 수 없습니다.
              마진이 확정값으로 저장됩니다.
            </p>
            <input type="hidden" name="orderId" value={orderId} />
            <div className="flex gap-2">
              <SubmitButton pendingLabel="처리 중…">확정</SubmitButton>
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>취소</button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
