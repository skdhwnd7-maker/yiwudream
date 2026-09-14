'use client'

import { useActionState, useMemo, useState } from 'react'
import Link from 'next/link'
import { SubmitButton, FormError } from '@/components/ui'
import { Field } from '@/components/Field'
import { D, fmtKrw } from '@/lib/money'
import { VAT_MODE_LABEL, INVOICE_BASE_LABEL } from '@/lib/labels'
import { createInvoice, type ActionState } from '../actions'
import { todayISO } from '@/lib/serialize'

interface Candidate {
  id: string; orderNo: string; orderDate: string; accountingClass: string
  partner: { id: string; name: string }
  dealType: { name: string; invoiceBase: string; vatMode: string }
}
interface Draft {
  targetAmount: string; supplyAmount: string; vatAmount: string
  totalAmount: string; totalReceiptAmount: string; vatMode: string
  basisLabel: string; manual: boolean; vatFromCollected: boolean
}

export default function InvoiceForm({
  candidates, preselected, initialDraft,
}: {
  candidates: Candidate[]; preselected: string[]; initialDraft: Draft | null
}) {
  const [state, action] = useActionState<ActionState, FormData>(createInvoice, {})
  const [picked, setPicked] = useState<string[]>(preselected)
  const [targetOverride, setTargetOverride] = useState('')

  const pickedOrders = candidates.filter((c) => picked.includes(c.id))
  const partnerIds = new Set(pickedOrders.map((o) => o.partner.id))
  const mixedPartner = partnerIds.size > 1
  const mixedDealType = new Set(pickedOrders.map((o) => o.dealType.name)).size > 1
  const dealType = pickedOrders[0]?.dealType

  // 화면 미리보기 — 서버에서 최종 확정한다
  const preview = useMemo(() => {
    if (!initialDraft || picked.join(',') !== preselected.join(',')) return null
    return initialDraft
  }, [initialDraft, picked, preselected])

  const effectiveTarget = targetOverride || preview?.targetAmount || ''
  const isManual = !!targetOverride && targetOverride !== preview?.targetAmount

  function toggle(id: string, on: boolean) {
    setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)))
  }

  return (
    <form action={action} className="space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">세금계산서 생성</h1>
          <p className="mt-1 text-sm text-ink-muted">여러 주문을 한 장으로 묶을 수 있습니다.</p>
        </div>
        <Link href="/invoices" className="btn-ghost no-underline">목록으로</Link>
      </header>

      <FormError message={state.error} />

      <section className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">발행 대상 주문</h2></div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-12"> </th>
                <th>거래처</th>
                <th className="w-40">주문번호</th>
                <th className="w-24">일자</th>
                <th className="w-36">거래유형</th>
                <th className="w-32">대상금액 기준</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const on = picked.includes(c.id)
                return (
                  <tr key={c.id} className={on ? 'bg-jade-soft' : ''}>
                    <td>
                      <input type="checkbox" checked={on} onChange={(e) => toggle(c.id, e.target.checked)}
                        aria-label={`${c.orderNo} 포함`} />
                      {on && <input type="hidden" name="orderId" value={c.id} />}
                    </td>
                    <td className="text-sm">{c.partner.name}</td>
                    <td className="num text-xs">{c.orderNo}</td>
                    <td className="num text-xs">{c.orderDate.slice(0, 10)}</td>
                    <td className="text-xs">{c.dealType.name}</td>
                    <td className="text-xs text-ink-muted">
                      {INVOICE_BASE_LABEL[c.dealType.invoiceBase as keyof typeof INVOICE_BASE_LABEL]}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {mixedPartner && (
          <p className="border-t border-line px-5 py-2 text-xs text-clay">
            서로 다른 거래처의 주문은 한 장으로 묶을 수 없습니다.
          </p>
        )}
        {mixedDealType && !mixedPartner && (
          <p className="border-t border-line px-5 py-2 text-xs text-clay">
            거래유형이 섞여 있습니다. 첫 주문의 규칙으로 계산되므로 확인이 필요합니다.
          </p>
        )}
        {picked.length > 0 && !preview && (
          <p className="border-t border-line px-5 py-2 text-xs text-ink-muted">
            선택을 바꾸셨습니다. 저장하면 선택한 주문 기준으로 금액이 다시 계산됩니다.
          </p>
        )}
      </section>

      {preview && dealType && (
        <section className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">금액 산출</h2>
            <span className="text-xs text-ink-muted">
              {preview.basisLabel} · {VAT_MODE_LABEL[preview.vatMode as keyof typeof VAT_MODE_LABEL]}
            </span>
          </div>
          <div className="card-body space-y-3">
            <table>
              <tbody>
                <tr>
                  <td className="text-sm text-ink-muted">주문 총입금액</td>
                  <td className="n text-sm text-ink-muted">{fmtKrw(preview.totalReceiptAmount)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">참고</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="pt-2 text-sm font-medium">발행대상금액</td>
                  <td className="n pt-2 text-sm font-medium">{fmtKrw(preview.targetAmount)}</td>
                  <td className="pt-2 pl-3 text-[11px] text-ink-muted">{preview.basisLabel}</td>
                </tr>
                <tr>
                  <td className="text-sm">공급가액</td>
                  <td className="n text-sm text-jade">{fmtKrw(preview.supplyAmount)}</td>
                  <td />
                </tr>
                <tr>
                  <td className="text-sm">부가세</td>
                  <td className="n text-sm text-gold">{fmtKrw(preview.vatAmount)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">
                    {preview.vatFromCollected ? '실제로 받은 금액' : '설정에 따라 계산'}
                  </td>
                </tr>
                <tr className="border-t border-line-strong">
                  <td className="pt-2 text-sm font-semibold">합계금액</td>
                  <td className="n pt-2 text-sm font-semibold">{fmtKrw(preview.totalAmount)}</td>
                  <td />
                </tr>
              </tbody>
            </table>

            {preview.vatFromCollected && (
              <p className="hint">
                통장에 찍힌 금액에는 이미 부가세가 들어 있습니다. 공급가액과 부가세를
                <strong> 실제 받은 금액 그대로</strong> 씁니다 — 다시 계산하면 1원씩 어긋납니다.
              </p>
            )}

            <Field label="발행대상금액 직접 입력" name="targetAmount"
              hint="비워두면 위 자동 산출값을 씁니다. 다른 금액을 넣으면 사유가 필요합니다.">
              <input name="targetAmount" inputMode="decimal" className="num"
                value={targetOverride} onChange={(e) => setTargetOverride(e.target.value)}
                placeholder={preview.targetAmount} />
            </Field>

            {isManual && (
              <Field label="수정 사유" name="targetReason" required>
                <input name="targetReason" required placeholder="예: 일부 금액만 발행하기로 협의" />
              </Field>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-body grid gap-4 md:grid-cols-3">
          <Field label="발행일" name="issueDate">
            <input name="issueDate" type="date" defaultValue={todayISO()} />
          </Field>
          <Field label="국세청 승인번호" name="ntsApprovalNo">
            <input name="ntsApprovalNo" />
          </Field>
          <Field label="메모" name="memo">
            <input name="memo" />
          </Field>
          <div className="md:col-span-3">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" name="issueNow" />
              지금 바로 발행완료로 처리 (체크하지 않으면 발행예정 상태)
            </label>
          </div>
        </div>
      </section>

      <div className="flex gap-2">
        <SubmitButton pendingLabel="생성 중…">세금계산서 생성</SubmitButton>
        <Link href="/invoices" className="btn-ghost no-underline">취소</Link>
      </div>
    </form>
  )
}
