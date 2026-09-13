'use client'

import { useActionState, useMemo, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { D } from '@/lib/money'
import { createInternalTransfer, type ActionState } from '../remittances/actions'

interface Acc { id: string; name: string; currency: string }

export default function TransferForm({ krAccounts, cnAccounts }: { krAccounts: Acc[]; cnAccounts: Acc[] }) {
  const [state, action] = useActionState<ActionState, FormData>(createInternalTransfer, {})
  const [open, setOpen] = useState(false)
  const [usd, setUsd] = useState('')
  const [cny, setCny] = useState('')

  const rate = useMemo(() => {
    const u = D(usd || 0), c = D(cny || 0)
    return u.gt(0) && c.gt(0) ? c.div(u).toDecimalPlaces(4) : null
  }, [usd, cny])

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}>+ 자금이동 등록</button>
  }

  return (
    <form action={action} className="card">
      <div className="card-head"><h2 className="text-sm font-semibold">자금이동 등록</h2></div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <FormOk message={state.ok} />

        <div className="grid gap-4 md:grid-cols-3">
          <Field label="일자" name="transferDate" required>
            <input name="transferDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="출금 계좌 (한국)" name="fromAccountId">
            <select name="fromAccountId" defaultValue={krAccounts[0]?.id ?? ''}>
              <option value="">선택 안 함</option>
              {krAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="수취 계좌 (중국)" name="toAccountId">
            <select name="toAccountId" defaultValue={cnAccounts[0]?.id ?? ''}>
              <option value="">선택 안 함</option>
              {cnAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>

          <Field label="USD 금액" name="usdAmount">
            <input name="usdAmount" inputMode="decimal" className="num"
              value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="99000" />
          </Field>
          <Field label="KRW 금액" name="krwAmount">
            <input name="krwAmount" inputMode="decimal" className="num" placeholder="0" />
          </Field>
          <Field label="CNY 도착금액" name="cnyArrivalAmount" required>
            <input name="cnyArrivalAmount" inputMode="decimal" className="num" required
              value={cny} onChange={(e) => setCny(e.target.value)} placeholder="672190" />
          </Field>

          <Field label="송금수수료" name="bankFee">
            <input name="bankFee" inputMode="decimal" className="num" placeholder="0" />
          </Field>
          <Field label="목적" name="purpose">
            <select name="purpose" defaultValue="운영자금">
              <option value="운영자금">운영자금</option>
              <option value="상품대금 선지급">상품대금 선지급</option>
              <option value="기타">기타</option>
            </select>
          </Field>
          <Field label="메모" name="memo">
            <input name="memo" />
          </Field>
        </div>

        {rate && (
          <div className="rounded-sm border border-line bg-sunken px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">USD/CNY 환율</span>
            <span className="num ml-2 text-sm font-semibold">{rate.toString()}</span>
            <span className="ml-2 text-xs text-ink-muted">
              엑셀 실측 범위 6.7481 ~ 6.8028
            </span>
          </div>
        )}

        <div className="flex gap-2">
          <SubmitButton>등록</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>취소</button>
        </div>
      </div>
    </form>
  )
}
