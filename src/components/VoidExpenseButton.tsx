'use client'

/**
 * 지출 전표 삭제 버튼.
 *
 * 화면에서는 「삭제」다 — 누르면 목록에서도 합계에서도 사라진다.
 * 속으로는 행을 지우지 않고 삭제 표시(isVoid)를 단다.
 * 나중에 통장과 대조하다 "이 돈이 왜 없어졌지" 를 따라갈 근거가 필요하고,
 * 그 기록은 변경이력에만 남는다. 쓰는 사람이 보는 결과는 삭제와 같다.
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
        삭제
      </button>
    )
  }

  return (
    <form action={action} className="min-w-[220px] space-y-1.5">
      <FormError message={state.error} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <input name="reason" placeholder="삭제 사유 (필수)" required className="text-xs" />
      <p className="hint">목록과 합계에서 빠집니다. 변경이력에는 기록이 남습니다.</p>
      <div className="flex gap-1.5">
        <SubmitButton className="btn-danger btn-sm" pendingLabel="…">삭제</SubmitButton>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>닫기</button>
      </div>
    </form>
  )
}
