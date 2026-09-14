'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { addExpense, type ActionState } from '../orders/actions'

interface Cat { id: string; code: string; name: string; defaultCurrency: string }
interface Acc { id: string; name: string; currency: string }
interface Ord { id: string; orderNo: string; partner: { name: string } }

/**
 * 임시공·사무실 경비 입력.
 * 주문 원장과 같은 addExpense 를 쓴다. 지출 원장을 하나로 두기 위해서다.
 */
export default function ExpenseEntry({
  mode, categories, accounts, orders,
}: {
  mode: 'temp-labor' | 'office'
  categories: Cat[]
  accounts: Acc[]
  orders?: Ord[]
}) {
  const [state, action] = useActionState<ActionState, FormData>(addExpense, {})
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [orderId, setOrderId] = useState('')
  const [currency, setCurrency] = useState('CNY')

  const isTemp = mode === 'temp-labor'
  const title = isTemp ? '임시공 비용 등록' : '사무실 경비 등록'

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}>+ {title}</button>
  }

  return (
    <form action={action} className="card">
      <div className="card-head"><h2 className="text-sm font-semibold">{title}</h2></div>
      <div className="card-body space-y-3">
        <FormError message={state.error} />
        <FormOk message={state.ok} />

        <div className="grid gap-4 md:grid-cols-4">
          <Field label="일자" name="expenseDate" required>
            <input name="expenseDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="비용분류" name="categoryId" required>
            <select name="categoryId" required defaultValue={categories[0]?.id ?? ''}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="통화 / 금액" name="amount" required>
            <div className="flex gap-1.5">
              <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-24">
                <option value="CNY">CNY</option>
                <option value="KRW">KRW</option>
              </select>
              <input name="amount" inputMode="decimal" className="num" required
                value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </div>
          </Field>
          {currency === 'CNY' && (
            <Field label="적용환율" name="fxRate" required hint="원화 환산용">
              <input name="fxRate" inputMode="decimal" className="num" required placeholder="218.00" />
            </Field>
          )}

          {isTemp ? (
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
          ) : (
            <>
              <Field label="내용" name="workDesc" className="md:col-span-2">
                <input name="workDesc" placeholder="예: 사무실 월세" />
              </Field>
              <Field label="지급처" name="vendorName">
                <input name="vendorName" />
              </Field>
            </>
          )}

          <Field label="지급방법" name="paymentMethod">
            <select name="paymentMethod" defaultValue="">
              <option value="">선택 안 함</option>
              {['계좌이체', '현금', '알리페이', '위챗페이', '카드'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="지급 계좌" name="accountId">
            <select name="accountId" defaultValue="">
              <option value="">선택 안 함</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="지급 상태" name="paymentStatus">
            <select name="paymentStatus" defaultValue="PAID">
              <option value="PAID">지급완료</option>
              <option value="PLANNED">지급예정</option>
            </select>
          </Field>
          <Field label="메모" name="memo">
            <input name="memo" />
          </Field>
        </div>

        {isTemp && orders && (
          <div className="rounded-sm border border-line bg-sunken px-4 py-3">
            <Field label="귀속 주문" name="allocOrderId"
              hint="특정 고객 작업 때문에 쓴 인건비라면 그 주문을 고르세요. 비워두면 운영비가 됩니다.">
              <select name="allocOrderId" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                <option value="">귀속하지 않음 (운영비)</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>{o.orderNo} · {o.partner.name}</option>
                ))}
              </select>
            </Field>
            {orderId && <input type="hidden" name="allocAmount" value={amount} />}
            <p className="hint mt-2">
              {orderId
                ? '이 금액 전액이 해당 주문의 원가로 잡혀 마진에서 차감됩니다.'
                : '중국 운영비로 집계되어 최종 영업마진에서 차감됩니다.'}
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <SubmitButton>저장</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>닫기</button>
        </div>
      </div>
    </form>
  )
}
