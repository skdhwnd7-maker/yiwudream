'use client'

import { useState } from 'react'
import { RevenueBasis, InvoiceBase, VatMode, Rounding, Route } from '@prisma/client'
import { Field } from '@/components/Field'
import { REVENUE_BASIS_LABEL, INVOICE_BASE_LABEL, VAT_MODE_LABEL, ROUTE_LABEL, ACCOUNTING_CLASSES } from '@/lib/labels'
import { splitVat, fmtKrw } from '@/lib/money'

interface Values {
  code: string; name: string; revenueBasis: RevenueBasis; invoiceBase: InvoiceBase
  invoiceDefault: boolean; vatMode: VatMode; vatRate: string; rounding: Rounding
  accountingClass: string; defaultRoute: string; sortOrder: number; memo: string
}

export default function DealTypeFields({ d, showReason }: { d?: Values; showReason?: boolean }) {
  const [vatMode, setVatMode] = useState<VatMode>(d?.vatMode ?? VatMode.NONE)
  const [vatRate, setVatRate] = useState(d?.vatRate ?? '0.10')
  const [rounding, setRounding] = useState<Rounding>(d?.rounding ?? Rounding.FLOOR)

  // 설정을 바꾸면 100,000원이 어떻게 갈리는지 바로 보여준다.
  const preview = (() => {
    try {
      return splitVat('100000', vatMode, vatRate || '0', rounding)
    } catch {
      return null
    }
  })()

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="코드" name="code" required>
        <input name="code" defaultValue={d?.code ?? ''} required className="num uppercase" placeholder="CORP_FULL" />
      </Field>
      <Field label="이름" name="name" required className="md:col-span-2">
        <input name="name" defaultValue={d?.name ?? ''} required placeholder="법인통장 전액발행" />
      </Field>

      <Field label="매출 인식 기준" name="revenueBasis"
        hint="순액이면 수수료만 매출로 봅니다 (사이트통장)">
        <select name="revenueBasis" defaultValue={d?.revenueBasis ?? RevenueBasis.GROSS}>
          {Object.values(RevenueBasis).map((v) => <option key={v} value={v}>{REVENUE_BASIS_LABEL[v]}</option>)}
        </select>
      </Field>
      <Field label="세금계산서 대상금액" name="invoiceBase">
        <select name="invoiceBase" defaultValue={d?.invoiceBase ?? InvoiceBase.NONE}>
          {Object.values(InvoiceBase).map((v) => <option key={v} value={v}>{INVOICE_BASE_LABEL[v]}</option>)}
        </select>
      </Field>
      <Field label="회계분류" name="accountingClass" hint="발행 여부와 별개로 기록됩니다.">
        <select name="accountingClass" defaultValue={d?.accountingClass ?? '상품매출'}>
          {ACCOUNTING_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      <Field label="부가세 방식" name="vatMode">
        <select name="vatMode" value={vatMode} onChange={(e) => setVatMode(e.target.value as VatMode)}>
          {Object.values(VatMode).map((v) => <option key={v} value={v}>{VAT_MODE_LABEL[v]}</option>)}
        </select>
      </Field>
      <Field label="부가세율" name="vatRate" hint="0.10 = 10%">
        <input name="vatRate" value={vatRate} onChange={(e) => setVatRate(e.target.value)} inputMode="decimal" className="num" />
      </Field>
      <Field label="원 단위 처리" name="rounding">
        <select name="rounding" value={rounding} onChange={(e) => setRounding(e.target.value as Rounding)}>
          <option value={Rounding.FLOOR}>절사 (FLOOR)</option>
          <option value={Rounding.ROUND}>반올림 (ROUND)</option>
          <option value={Rounding.CEIL}>올림 (CEIL)</option>
        </select>
      </Field>

      {/* 설정이 실제로 어떤 숫자를 만드는지 바로 확인시킨다 */}
      {preview && vatMode !== VatMode.NONE && (
        <div className="md:col-span-3 rounded-sm border border-line bg-surface px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">
            대상금액 100,000원일 때
          </p>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <span>공급가액 <b className="num ml-1 text-jade">{fmtKrw(preview.supply)}</b></span>
            <span>부가세 <b className="num ml-1 text-gold">{fmtKrw(preview.vat)}</b></span>
            <span>합계 <b className="num ml-1">{fmtKrw(preview.total)}</b></span>
          </div>
          <p className="hint mt-1.5">
            {vatMode === 'INCLUDED'
              ? '대상금액 안에 부가세가 들어 있습니다. 고객이 100,000원을 냅니다.'
              : vatMode === 'EXCLUDED'
                ? '대상금액이 공급가액입니다. 고객이 110,000원을 냅니다.'
                : '부가세가 붙지 않습니다.'}
          </p>
        </div>
      )}

      <Field label="기본 루트" name="defaultRoute">
        <select name="defaultRoute" defaultValue={d?.defaultRoute ?? ''}>
          <option value="">선택 안 함</option>
          {Object.values(Route).map((r) => <option key={r} value={r}>{ROUTE_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="정렬 순서" name="sortOrder">
        <input name="sortOrder" type="number" defaultValue={d?.sortOrder ?? 0} className="num" />
      </Field>
      <div className="flex items-end pb-2">
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" name="invoiceDefault" defaultChecked={d?.invoiceDefault ?? false} />
          기본 발행 대상
        </label>
      </div>

      <Field label="설명" name="memo" className="md:col-span-3">
        <textarea name="memo" rows={2} defaultValue={d?.memo ?? ''} />
      </Field>

      {showReason && (
        <Field label="변경 사유" name="reason" className="md:col-span-3"
          hint="부가세 방식·대상금액 기준을 바꾸면 사유가 필요합니다.">
          <input name="reason" placeholder="예: 세무사 검토 후 부가세 방식 변경" />
        </Field>
      )}
    </div>
  )
}
