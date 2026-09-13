'use client'

import { useActionState } from 'react'
import { addAlias, removeAlias, type ActionState } from '../actions'
import { SubmitButton, FormError, FormOk } from '@/components/ui'

export default function AliasPanel({
  partnerId,
  partnerName,
  aliases,
}: {
  partnerId: string
  partnerName: string
  aliases: { id: string; alias: string; source: string }[]
}) {
  const [addState, addAction] = useActionState<ActionState, FormData>(addAlias, {})
  const [rmState, rmAction] = useActionState<ActionState, FormData>(removeAlias, {})

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="text-sm font-semibold">별칭</h2>
        <span className="text-xs text-ink-muted">{aliases.length}건</span>
      </div>
      <div className="card-body space-y-3">
        <p className="hint">
          엑셀에서 <strong>{partnerName}</strong>이(가) 다른 표기로 적혀 있었다면 여기에 등록하세요.
          가져오기와 검색에서 같은 거래처로 묶입니다. (예: <span className="font-mono">코러스 코리아</span> ↔ <span className="font-mono">코러스코리아</span>)
        </p>

        <FormError message={addState.error ?? rmState.error} />
        <FormOk message={addState.ok ?? rmState.ok} />

        {aliases.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {aliases.map((a) => (
              <li key={a.id}>
                <form action={rmAction} className="flex items-center gap-1.5 rounded-sm border border-line bg-sunken px-2.5 py-1">
                  <input type="hidden" name="aliasId" value={a.id} />
                  <span className="font-mono text-xs">{a.alias}</span>
                  {a.source === 'IMPORT' && <span className="font-mono text-[9px] text-ink-muted">가져옴</span>}
                  <button type="submit" className="text-xs text-ink-muted hover:text-clay" aria-label={`${a.alias} 별칭 삭제`}>✕</button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action={addAction} className="flex gap-2">
          <input type="hidden" name="partnerId" value={partnerId} />
          <input name="alias" placeholder="다른 표기를 입력하세요" maxLength={100} className="flex-1" />
          <SubmitButton className="btn-ghost" pendingLabel="추가 중…">별칭 추가</SubmitButton>
        </form>
      </div>
    </section>
  )
}
