import { Entity, Route, Currency } from '@prisma/client'
import { Field } from '@/components/Field'
import { ENTITY_LABEL, ROUTE_LABEL, CURRENCY_LABEL } from '@/lib/labels'

export default function AccountFields({
  account,
  showReason,
}: {
  account?: {
    name: string; entity: Entity; route: Route; currency: Currency
    bankName: string; accountNo: string; openingBalance: string; openingDate: string; memo: string
  }
  showReason?: boolean
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="계좌명" name="name" required className="md:col-span-2">
        <input name="name" defaultValue={account?.name ?? ''} required placeholder="예: 한국 법인통장" />
      </Field>
      <Field label="자금주체" name="entity" hint="한국과 중국 자금은 절대 합산하지 않습니다.">
        <select name="entity" defaultValue={account?.entity ?? Entity.KR}>
          {Object.values(Entity).map((e) => <option key={e} value={e}>{ENTITY_LABEL[e]}</option>)}
        </select>
      </Field>
      <Field label="루트" name="route">
        <select name="route" defaultValue={account?.route ?? Route.BANK_CORP}>
          {Object.values(Route).map((r) => <option key={r} value={r}>{ROUTE_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="통화" name="currency">
        <select name="currency" defaultValue={account?.currency ?? Currency.KRW}>
          {Object.values(Currency).map((c) => <option key={c} value={c}>{CURRENCY_LABEL[c]}</option>)}
        </select>
      </Field>
      <Field label="은행" name="bankName">
        <input name="bankName" defaultValue={account?.bankName ?? ''} />
      </Field>
      <Field label="계좌번호" name="accountNo" className="md:col-span-2">
        <input name="accountNo" defaultValue={account?.accountNo ?? ''} />
      </Field>
      <Field label="기초잔액" name="openingBalance" hint="시스템 사용 시작 시점의 잔액">
        <input name="openingBalance" inputMode="decimal" defaultValue={account?.openingBalance ?? '0'} className="num" />
      </Field>
      <Field label="기초잔액 기준일" name="openingDate">
        <input name="openingDate" type="date" defaultValue={account?.openingDate ?? ''} />
      </Field>
      <Field label="메모" name="memo" className="md:col-span-3">
        <input name="memo" defaultValue={account?.memo ?? ''} />
      </Field>
      {showReason && (
        <Field label="변경 사유" name="reason" className="md:col-span-3"
          hint="기초잔액을 바꾸면 사유가 필요합니다. 변경이력에 남습니다.">
          <input name="reason" placeholder="예: 통장 재확인 후 기초잔액 정정" />
        </Field>
      )}
    </div>
  )
}
