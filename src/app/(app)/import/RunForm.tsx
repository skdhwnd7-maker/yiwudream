'use client'

import { useActionState } from 'react'
import { runImport, type ActionState } from './actions'
import { SubmitButton, FormError } from '@/components/ui'

export default function RunForm({
  batchId, sheets, opsBaseYear, payrollYm, cnyDisplayRate, blocked,
}: {
  batchId: string
  sheets: string[]
  opsBaseYear: number
  payrollYm: string
  cnyDisplayRate: string
  blocked: number
}) {
  const [state, action] = useActionState<ActionState, FormData>(runImport, {})
  return (
    <form action={action} className="card border-jade">
      <div className="card-head">
        <h2 className="text-sm font-semibold">3단계 · 가져오기 실행</h2>
      </div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <input type="hidden" name="batchId" value={batchId} />
        {sheets.map((s) => <input key={s} type="hidden" name="sheets" value={s} />)}
        <input type="hidden" name="opsBaseYear" value={opsBaseYear} />
        <input type="hidden" name="payrollYm" value={payrollYm} />
        <input type="hidden" name="cnyDisplayRate" value={cnyDisplayRate} />
        <p className="text-sm leading-relaxed text-ink-2">
          위에서 본 그대로 한 번에 넣습니다. 중간에 실패하면 아무것도 남지 않습니다.
          {blocked > 0 && (
            <>
              {' '}
              <strong className="text-clay">
                고쳐야 할 {blocked}건은 넣지 않고 원본만 보관합니다.
              </strong>{' '}
              엑셀에서 고친 뒤 다시 올리면 그 건들만 추가로 들어갑니다.
            </>
          )}
        </p>
        <SubmitButton pendingLabel="가져오는 중… 잠시만 기다려 주세요">가져오기 실행</SubmitButton>
      </div>
    </form>
  )
}
