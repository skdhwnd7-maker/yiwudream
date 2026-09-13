'use client'

import { useActionState, useState } from 'react'
import type { Route } from '@prisma/client'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { addReceipt, type ActionState } from '../actions'

interface AccountOpt { id: string; name: string; currency: string; route: Route }

export default function AddReceiptPanel({
  orderId, accounts, route, vatMode, settlementCurrency,
}: {
  orderId: string; accounts: AccountOpt[]; route: Route; vatMode: string; settlementCurrency: string
}) {
  const [state, action] = useActionState<ActionState, FormData>(addReceipt, {})
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState(accounts.find((a) => a.route === route)?.id ?? '')

  const account = accounts.find((a) => a.id === accountId)
  const needsFx = !!account && account.currency !== settlementCurrency
  const vatPossible = vatMode === 'INCLUDED' || vatMode === 'EXCLUDED'

  if (!open) {
    return <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>+ 입금 추가</button>
  }

  return (
    <form action={action} className="space-y-3">
      <FormError message={state.error} />
      <FormOk message={state.ok} />
      <input type="hidden" name="orderId" value={orderId} />

      <div className="grid gap-4 md:grid-cols-4">
        <Field label="일자" name="receiptDate" required>
          <input name="receiptDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
        </Field>
        <Field label="계좌" name="accountId" required>
          <select name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            <option value="">선택</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
          </select>
        </Field>
        <Field label="실제 입금액" name="amount" required>
          <input name="amount" inputMode="decimal" className="num" required placeholder="0" />
        </Field>
        <Field label="적용환율" name="fxRate" required={needsFx}
          hint={needsFx ? '환산에 필요합니다' : 'CNY 환산 참고용'}>
          <input name="fxRate" inputMode="decimal" className="num" required={needsFx} placeholder="218.00" />
        </Field>
        {route === 'OVERSEAS' && (
          <Field label="USD 인보이스" name="usdAmount">
            <input name="usdAmount" inputMode="decimal" className="num" />
          </Field>
        )}
        {route === 'SITE' && (
          <Field label="상품구매 예치금" name="depositGoods" hint="고객 돈">
            <input name="depositGoods" inputMode="decimal" className="num" />
          </Field>
        )}
        <Field label="메모" name="memo" className="md:col-span-2">
          <input name="memo" />
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {vatPossible && (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="vatCharged" defaultChecked />
            부가세를 받았음
          </label>
        )}
        {route === 'BANK_GEN' && (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="fromDeposit" />
            예치금에서 충당
          </label>
        )}
      </div>

      <div className="flex gap-2">
        <SubmitButton>입금 저장</SubmitButton>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>닫기</button>
      </div>
    </form>
  )
}
