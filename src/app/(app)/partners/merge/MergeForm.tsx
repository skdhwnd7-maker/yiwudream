'use client'

import { useActionState, useState } from 'react'
import { mergePartners, type ActionState } from '../actions'
import { SubmitButton, FormError, FormOk } from '@/components/ui'

export default function MergeForm({
  groupKey,
  partners,
}: {
  groupKey: string
  partners: { id: string; code: string; name: string }[]
}) {
  const [state, action] = useActionState<ActionState, FormData>(mergePartners, {})
  const [targetId, setTargetId] = useState(partners[0]?.id ?? '')

  return (
    <form action={action} className="card">
      <div className="card-head">
        <h2 className="text-sm font-semibold">
          <span className="font-mono text-xs text-ink-muted">{groupKey}</span>
          <span className="ml-2">{partners.length}건</span>
        </h2>
      </div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <FormOk message={state.ok} />

        <table>
          <thead>
            <tr>
              <th className="w-20">남길 곳</th>
              <th className="w-20">코드</th>
              <th>거래처명</th>
              <th className="w-24">처리</th>
            </tr>
          </thead>
          <tbody>
            {partners.map((p) => {
              const isTarget = p.id === targetId
              return (
                <tr key={p.id} className={isTarget ? 'bg-jade-soft' : ''}>
                  <td>
                    <input
                      type="radio"
                      name="targetId"
                      value={p.id}
                      checked={isTarget}
                      onChange={() => setTargetId(p.id)}
                      className="w-4"
                      aria-label={`${p.name}을 대표 거래처로`}
                    />
                  </td>
                  <td className="num text-xs">{p.code}</td>
                  <td className="text-sm">{p.name}</td>
                  <td className="text-xs">
                    {isTarget ? (
                      <span className="pill-good">유지</span>
                    ) : (
                      <>
                        <input type="hidden" name="sourceIds" value={p.id} />
                        <span className="pill-warn">별칭으로 흡수</span>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <div>
          <label htmlFor={`reason-${groupKey}`}>병합 사유 <span className="text-clay">*</span></label>
          <input id={`reason-${groupKey}`} name="reason" placeholder="예: 띄어쓰기만 다른 동일 거래처" required />
        </div>

        <SubmitButton pendingLabel="병합 중…">병합 실행</SubmitButton>
      </div>
    </form>
  )
}
