'use client'

/**
 * 지출 전표 취소 버튼.
 *
 * 잘못 넣은 지출을 물릴 때 쓴다. 행을 지우지는 않는다 —
 * 누가 언제 왜 물렸는지가 변경이력에 남아야 나중에 장부를 맞춰 볼 수 있다.
 * 취소한 전표는 합계에서 빠지고 목록에서도 보이지 않는다.
 *
 * 중국 운영비·임시공 비용·주문 상세에서 같이 쓴다.
 */
import { useActionState, useState } from 'react'
import { SubmitButton, FormError } from '@/components/ui'
import { voidExpense, type ActionState } from '@/app/(app)/orders/actions'

export default function VoidExpenseButton({ expenseId }: { expenseId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(voidExpense, {})
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        취소
      </button>
    )
  }

  return (
    <form action={action} className="min-w-[220px] space-y-1.5">
      <FormError message={state.error} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <input name="reason" placeholder="취소 사유 (필수)" required className="text-xs" />
      <p className="hint">행은 지워지지 않고 취소 표시만 남습니다.</p>
      <div className="flex gap-1.5">
        <SubmitButton className="btn-danger btn-sm" pendingLabel="…">확인</SubmitButton>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>닫기</button>
      </div>
    </form>
  )
}
