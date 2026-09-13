'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Route } from '@prisma/client'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { ROUTE_LABEL } from '@/lib/labels'
import type { ActionState } from './actions'

export interface PartnerFormValues {
  id?: string
  name: string
  bizNo: string
  ceoName: string
  contact: string
  phone: string
  email: string
  defaultRoute: string
  defaultDealTypeId: string
  taxInvoiceDefault: boolean
  defaultFeeRate: string
  defaultMarkupRate: string
  memo: string
}

export default function PartnerForm({
  action,
  values,
  dealTypes,
  mode,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>
  values: PartnerFormValues
  dealTypes: { id: string; name: string; code: string }[]
  mode: 'create' | 'edit'
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {})

  return (
    <form action={formAction} className="space-y-5">
      <FormError message={state.error} />
      <FormOk message={state.ok} />
      {values.id && <input type="hidden" name="id" value={values.id} />}

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">기본 정보</h2></div>
        <div className="card-body grid gap-4 md:grid-cols-2">
          <Field label="거래처명" name="name" required
            hint={mode === 'create' ? '끝에 붙은 일련번호는 자동으로 분리됩니다 (아르미르샵133 → 아르미르샵)' : undefined}>
            <input id="name" name="name" defaultValue={values.name} required maxLength={100} />
          </Field>
          <Field label="사업자등록번호" name="bizNo">
            <input id="bizNo" name="bizNo" defaultValue={values.bizNo} placeholder="123-45-67890" />
          </Field>
          <Field label="대표자" name="ceoName">
            <input id="ceoName" name="ceoName" defaultValue={values.ceoName} />
          </Field>
          <Field label="담당자" name="contact">
            <input id="contact" name="contact" defaultValue={values.contact} />
          </Field>
          <Field label="연락처" name="phone">
            <input id="phone" name="phone" defaultValue={values.phone} placeholder="010-0000-0000" />
          </Field>
          <Field label="이메일" name="email">
            <input id="email" name="email" type="email" defaultValue={values.email} />
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">거래 기본값</h2></div>
        <div className="card-body grid gap-4 md:grid-cols-2">
          <Field label="주 결제루트" name="defaultRoute" hint="새 거래 등록 시 이 루트가 미리 선택됩니다.">
            <select id="defaultRoute" name="defaultRoute" defaultValue={values.defaultRoute}>
              <option value="">선택 안 함</option>
              {(['OVERSEAS', 'BANK_GEN', 'BANK_CORP', 'SITE'] as Route[]).map((r) => (
                <option key={r} value={r}>{ROUTE_LABEL[r]}</option>
              ))}
            </select>
          </Field>
          <Field label="기본 거래유형" name="defaultDealTypeId" hint="세금계산서 대상금액·부가세 방식이 여기서 결정됩니다.">
            <select id="defaultDealTypeId" name="defaultDealTypeId" defaultValue={values.defaultDealTypeId}>
              <option value="">선택 안 함</option>
              {dealTypes.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="구매대행 수수료율 (%)" name="defaultFeeRate" hint="사이트 루트에서 입금액을 예치금과 수수료로 나눌 때 씁니다.">
            <input id="defaultFeeRate" name="defaultFeeRate" inputMode="decimal" defaultValue={values.defaultFeeRate} placeholder="9.09" />
          </Field>
          <Field label="마크업율 (%)" name="defaultMarkupRate" hint="지출액에 얹어 청구하는 거래처. 미수금 청구예정액 계산에 씁니다.">
            <input id="defaultMarkupRate" name="defaultMarkupRate" inputMode="decimal" defaultValue={values.defaultMarkupRate} placeholder="8.89" />
          </Field>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" name="taxInvoiceDefault" defaultChecked={values.taxInvoiceDefault} />
              세금계산서 발행 대상 (건별로 바꿀 수 있습니다)
            </label>
          </div>
          <Field label="메모" name="memo" className="md:col-span-2">
            <textarea id="memo" name="memo" rows={3} defaultValue={values.memo} />
          </Field>
        </div>
      </div>

      {mode === 'edit' && (
        <div className="card">
          <div className="card-body">
            <Field label="변경 사유" name="reason"
              hint="거래처·금액 관련 항목을 바꾸면 사유가 필요합니다. 변경이력에 그대로 남습니다.">
              <input id="reason" name="reason" placeholder="예: 사업자번호 정정" />
            </Field>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <SubmitButton>{mode === 'create' ? '등록' : '저장'}</SubmitButton>
        <Link href="/partners" className="btn-ghost no-underline">목록으로</Link>
      </div>
    </form>
  )
}
