'use client'

import { useActionState } from 'react'
import { uploadFile, type ActionState } from './actions'
import { SubmitButton, FormError } from '@/components/ui'

export default function UploadForm() {
  const [state, action] = useActionState<ActionState, FormData>(uploadFile, {})
  return (
    <form action={action} className="card">
      <div className="card-head">
        <h2 className="text-sm font-semibold">1단계 · 엑셀 올리기</h2>
      </div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <input
          type="file" name="file" accept=".xlsx"
          required
          className="block w-full text-sm file:mr-3 file:rounded file:border file:border-line
            file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink-2"
        />
        <p className="hint">
          지금 쓰시는 엑셀 파일을 그대로 올리시면 됩니다. 올린다고 바로 들어가지 않습니다 —
          다음 화면에서 무엇이 어떻게 들어가는지 먼저 보여 드립니다.
        </p>
        <SubmitButton pendingLabel="읽는 중…">올리고 확인하기</SubmitButton>
      </div>
    </form>
  )
}
