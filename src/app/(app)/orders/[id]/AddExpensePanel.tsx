'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { addExpense, type ActionState } from '../actions'

interface CategoryOpt { id: string; code: string; name: string; defaultCurrency: string; costType: string }
interface AccountOpt { id: string; name: string; currency: string }

export default function AddExpensePanel({
  orderId, orderNo, categories, accounts,
}: {
  orderId: string; orderNo: string; categories: CategoryOpt[]; accounts: AccountOpt[]
}) {
  const [state, action] = useActionState<ActionState, FormData>(addExpense, {})
  const [open, setOpen] = useState(false)
  const [categoryId, setCategoryId] = useState('')
  const [currency, setCurrency] = useState('CNY')
  const [amount, setAmount] = useState('')
  const [allocAll, setAllocAll] = useState(true)

  const category = categories.find((c) => c.id === categoryId)
  const isTempLabor = category?.code === 'TEMP_LABOR'

  if (!open) {
    return <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>+ 지출 추가</button>
  }

  return (
    <form action={action} className="space-y-3">
      <FormError message={state.error} />
      <FormOk message={state.ok} />

      <div className="grid gap-4 md:grid-cols-4">
        <Field label="일자" name="expenseDate" required>
          <input name="expenseDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
        </Field>
        <Field label="비용분류" name="categoryId" required>
          <select name="categoryId" value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value)
              const c = categories.find((x) => x.id === e.target.value)
              if (c) setCurrency(c.defaultCurrency)
            }} required>
            <option value="">선택</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="지급처" name="vendorName">
          <input name="vendorName" placeholder="예: 义乌工厂" />
        </Field>
        <Field label="통화 / 금액" name="amount" required>
          <div className="flex gap-1.5">
            <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-24">
              <option value="CNY">CNY</option>
              <option value="KRW">KRW</option>
              <option value="USD">USD</option>
            </select>
            <input name="amount" inputMode="decimal" className="num" required placeholder="0"
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </Field>

        {currency === 'CNY' && (
          <Field label="적용환율" name="fxRate" required hint="원화 환산에 쓰입니다">
            <input name="fxRate" inputMode="decimal" className="num" required placeholder="218.00" />
          </Field>
        )}
        <Field label="지급 계좌" name="accountId">
          <select name="accountId" defaultValue="">
            <option value="">선택 안 함</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="지급방법" name="paymentMethod">
          <select name="paymentMethod" defaultValue="">
            <option value="">선택 안 함</option>
            {['계좌이체', '현금', '알리페이', '위챗페이', '카드'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="지급 상태" name="paymentStatus">
          <select name="paymentStatus" defaultValue="PAID">
            <option value="PAID">지급완료</option>
            <option value="PLANNED">지급예정 (미지급금)</option>
          </select>
        </Field>

        {isTempLabor && (
          <>
            <Field label="작업 시작" name="workPeriodFrom">
              <input name="workPeriodFrom" type="date" />
            </Field>
            <Field label="작업 종료" name="workPeriodTo">
              <input name="workPeriodTo" type="date" />
            </Field>
            <Field label="작업 내용" name="workDesc" className="md:col-span-2">
              <input name="workDesc" placeholder="예: 의류 검품·포장" />
            </Field>
          </>
        )}

        <Field label="메모" name="memo" className="md:col-span-2">
          <input name="memo" />
        </Field>
      </div>

      <div className="rounded-sm border border-line bg-sunken px-4 py-3">
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={allocAll} onChange={(e) => setAllocAll(e.target.checked)} />
          이 지출 전액을 <span className="num">{orderNo}</span>에 귀속
        </label>
        <p className="hint mt-1">
          {allocAll
            ? '이 주문의 원가로 잡혀 마진에서 차감됩니다.'
            : '귀속하지 않으면 중국 운영비로 집계됩니다. 여러 주문에 나누려면 주문 상세가 아닌 지출 화면에서 배분하세요.'}
        </p>
        {allocAll && (
          <>
            <input type="hidden" name="allocOrderId" value={orderId} />
            <input type="hidden" name="allocAmount" value={amount} />
          </>
        )}
      </div>

      <div className="flex gap-2">
        <SubmitButton>지출 저장</SubmitButton>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>닫기</button>
      </div>
    </form>
  )
}
