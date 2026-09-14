'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { saveVatPeriod, fileVatPeriod, payVatPeriod, reopenVatPeriod, type ActionState } from './actions'
import { todayISO } from '@/lib/serialize'

export function NewPeriodForm() {
  const [state, action] = useActionState<ActionState, FormData>(saveVatPeriod, {})
  const [open, setOpen] = useState(false)

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}>+ 신고기간 추가</button>
  }
  return (
    <form action={action} className="card">
      <div className="card-head"><h2 className="text-sm font-semibold">신고기간 추가</h2></div>
      <div className="card-body space-y-4">
        <FormError message={state.error} />
        <FormOk message={state.ok} />
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="기간 코드" name="code" required hint="예) 2026-1H">
            <input id="code" name="code" required placeholder="2026-1H" className="num" />
          </Field>
          <Field label="이름" name="label" required hint="예) 2026년 1기 확정">
            <input id="label" name="label" required placeholder="2026년 1기 확정" />
          </Field>
          <Field label="시작일" name="periodFrom" required>
            <input id="periodFrom" name="periodFrom" type="date" required />
          </Field>
          <Field label="종료일" name="periodTo" required>
            <input id="periodTo" name="periodTo" type="date" required />
          </Field>
          <Field label="매출세액" name="salesVat" hint="신고서에 적힌 받은 부가세">
            <input id="salesVat" name="salesVat" inputMode="decimal" className="num" placeholder="0" />
          </Field>
          <Field label="매입세액" name="purchaseVat" hint="신고서에 적힌 돌려받을 부가세">
            <input id="purchaseVat" name="purchaseVat" inputMode="decimal" className="num" placeholder="0" />
          </Field>
          <Field label="메모" name="memo" className="md:col-span-2">
            <input id="memo" name="memo" />
          </Field>
        </div>
        <p className="hint">
          금액은 <strong>세무사님이 주신 신고서 값을 그대로</strong> 넣으십시오.
          프로그램은 신고할 금액을 계산하지 않습니다 — 그건 세무 판단입니다.
          대신 시스템이 받은 부가세와 얼마나 다른지는 저장 후 표에서 보여 드립니다.
        </p>
        <div className="flex gap-2">
          <SubmitButton>저장</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>취소</button>
        </div>
      </div>
    </form>
  )
}

export function PeriodActions({
  id, status, netPayable, accounts,
}: {
  id: string
  status: string
  netPayable: string
  accounts: { id: string; name: string }[]
}) {
  const [fileState, fileAction] = useActionState<ActionState, FormData>(fileVatPeriod, {})
  const [payState, payAction] = useActionState<ActionState, FormData>(payVatPeriod, {})
  const [openState, openAction] = useActionState<ActionState, FormData>(reopenVatPeriod, {})
  const [mode, setMode] = useState<'none' | 'pay' | 'reopen'>('none')

  if (mode === 'pay') {
    return (
      <form action={payAction} className="min-w-[220px] space-y-1.5">
        <FormError message={payState.error} />
        <input type="hidden" name="id" value={id} />
        <input name="paidAt" type="date" required className="text-xs"
          defaultValue={todayISO()} />
        <input name="paidAmount" inputMode="decimal" required className="num text-xs"
          defaultValue={netPayable} placeholder="납부액" />
        <select name="accountId" className="text-xs">
          <option value="">출금 계좌 선택 안 함</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <p className="hint">환급이면 음수로 넣으세요.</p>
        <div className="flex gap-1.5">
          <SubmitButton className="btn-primary btn-sm" pendingLabel="…">납부 처리</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  if (mode === 'reopen') {
    return (
      <form action={openAction} className="min-w-[200px] space-y-1.5">
        <FormError message={openState.error} />
        <input type="hidden" name="id" value={id} />
        <input name="reason" required placeholder="되돌리는 이유 (필수)" className="text-xs" />
        <p className="hint">납부 전표도 함께 취소됩니다.</p>
        <div className="flex gap-1.5">
          <SubmitButton className="btn-danger btn-sm" pendingLabel="…">되돌리기</SubmitButton>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('none')}>닫기</button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex gap-1">
      {status === 'OPEN' && (
        <form action={fileAction}>
          <input type="hidden" name="id" value={id} />
          <SubmitButton className="btn-ghost btn-sm" pendingLabel="…">신고 확정</SubmitButton>
        </form>
      )}
      {status === 'FILED' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('pay')}>납부 처리</button>
      )}
      {status !== 'OPEN' && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('reopen')}>되돌리기</button>
      )}
      <FormError message={fileState.error} />
      <FormOk message={fileState.ok} />
    </div>
  )
}
