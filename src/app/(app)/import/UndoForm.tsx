'use client'

import { useActionState } from 'react'
import { undoImport, type ActionState } from './actions'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'

export default function UndoForm({ batchId }: { batchId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(undoImport, {})
  return (
    <form action={action} className="card border-clay">
      <div className="card-head">
        <h2 className="text-sm font-semibold">되돌리기</h2>
      </div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <FormOk message={state.ok} />
        <input type="hidden" name="batchId" value={batchId} />
        <Field label="되돌리는 이유" name="reason" required>
          <input id="reason" name="reason" required minLength={2}
            placeholder="예) 환율을 잘못 지정해 다시 넣습니다" />
        </Field>
        <p className="hint">
          이 배치가 만든 주문·입금·지출·세금계산서·자금이동·급여를 지웁니다.
          다른 곳에서 쓰이고 있는 거래처와 직원은 남깁니다. 원본 행과 변경이력은 지우지 않습니다.
        </p>
        <SubmitButton className="btn-danger" pendingLabel="되돌리는 중…">이 배치 되돌리기</SubmitButton>
      </div>
    </form>
  )
}
