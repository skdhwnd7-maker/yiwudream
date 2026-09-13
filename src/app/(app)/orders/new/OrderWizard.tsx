'use client'

import { useActionState, useMemo, useState } from 'react'
import Link from 'next/link'
import { Route } from '@prisma/client'
import { SubmitButton, FormError } from '@/components/ui'
import { Field } from '@/components/Field'
import { ROUTE_LABEL, VAT_MODE_LABEL } from '@/lib/labels'
import { D, splitVat, krwToCny, fmtKrw, fmtCny } from '@/lib/money'
import { createOrderWithReceipt, type ActionState } from '../actions'

interface PartnerOpt {
  id: string; code: string; name: string
  defaultRoute: Route | null; defaultDealTypeId: string | null
  defaultFeeRate: string | null; taxInvoiceDefault: boolean
}
interface DealTypeOpt {
  id: string; code: string; name: string; revenueBasis: string
  vatMode: string; vatRate: string; invoiceDefault: boolean
  accountingClass: string; defaultRoute: Route | null
}
interface AccountOpt { id: string; name: string; entity: string; route: Route; currency: string }

const ROUTES: { value: Route; label: string; icon: string; hint: string }[] = [
  { value: 'OVERSEAS', label: '해외송금', icon: '🌏', hint: '중국법인 계좌로 직접 들어온 돈' },
  { value: 'BANK_GEN', label: '일반통장', icon: '🏦', hint: '예치금 성격. 부가세와 무관' },
  { value: 'BANK_CORP', label: '법인통장', icon: '🏛', hint: '부가세 포함 입금. 계산서는 건별 선택' },
  { value: 'SITE', label: '사이트 결제', icon: '🛒', hint: '예치금 + 수수료로 나뉜다' },
]

export default function OrderWizard({
  partners, dealTypes, accounts, deposits, refRate, initialPartnerId,
}: {
  partners: PartnerOpt[]; dealTypes: DealTypeOpt[]; accounts: AccountOpt[]
  deposits: Record<string, string>; refRate: string | null; initialPartnerId: string
}) {
  const [state, action] = useActionState<ActionState, FormData>(createOrderWithReceipt, {})

  const [partnerId, setPartnerId] = useState(initialPartnerId)
  const [route, setRoute] = useState<Route | ''>('')
  const [dealTypeId, setDealTypeId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [fxRate, setFxRate] = useState(refRate ?? '')
  const [depositGoods, setDepositGoods] = useState('')
  const [feeRate, setFeeRate] = useState('')
  const [asDeposit, setAsDeposit] = useState(false)
  const [fromDeposit, setFromDeposit] = useState(false)
  const [vatCharged, setVatCharged] = useState(false)
  const [issueInvoice, setIssueInvoice] = useState(false)

  const partner = partners.find((p) => p.id === partnerId)
  const dealType = dealTypes.find((d) => d.id === dealTypeId)
  const account = accounts.find((a) => a.id === accountId)
  const depositBalance = partnerId ? (deposits[partnerId] ?? '0') : '0'

  // 거래처를 고르면 그 거래처의 기본값을 따라간다
  function onPickPartner(id: string) {
    setPartnerId(id)
    const p = partners.find((x) => x.id === id)
    if (!p) return
    if (p.defaultRoute) applyRoute(p.defaultRoute, p)
    if (p.defaultFeeRate) setFeeRate(p.defaultFeeRate)
  }

  function applyRoute(r: Route, p?: PartnerOpt) {
    setRoute(r)
    const target = p ?? partner
    // 거래처 기본 거래유형이 이 루트와 맞으면 그것을, 아니면 루트 기본값을 쓴다
    const preferred = dealTypes.find((d) => d.id === target?.defaultDealTypeId && d.defaultRoute === r)
    const fallback = dealTypes.find((d) => d.defaultRoute === r)
    const dt = preferred ?? fallback
    if (dt) {
      setDealTypeId(dt.id)
      setIssueInvoice(dt.invoiceDefault)
      // 법인통장은 발행 여부와 무관하게 부가세를 받는다(대표님 확인)
      setVatCharged(dt.vatMode === 'EXCLUDED' || dt.vatMode === 'INCLUDED')
    }
    const acc = accounts.find((a) => a.route === r)
    if (acc) setAccountId(acc.id)
    if (r !== 'SITE') setDepositGoods('')
  }

  // 사이트: 수수료율을 넣으면 예치금이 자동으로 갈린다
  function onFeeRateChange(v: string) {
    setFeeRate(v)
    const amt = D(amount || 0), rate = D(v || 0)
    if (amt.gt(0) && rate.gt(0)) {
      const fee = amt.mul(rate).div(100).toDecimalPlaces(0)
      setDepositGoods(amt.minus(fee).toString())
    }
  }

  const preview = useMemo(() => {
    const amt = D(amount || 0)
    if (amt.lte(0) || !dealType) return null
    const dep = route === 'SITE' ? D(depositGoods || 0) : D(0)
    const remainder = amt.minus(dep)
    if (remainder.lt(0)) return { error: '예치금이 입금액보다 큽니다.', rows: [], company: '0', cny: null }

    const rows: { label: string; amount: string; owner: '회사' | '고객' | '국세청' }[] = []
    if (dep.gt(0)) rows.push({ label: '상품구매 예치금', amount: dep.toString(), owner: '고객' })

    if (remainder.gt(0)) {
      const kindLabel = dep.gt(0) ? '구매대행 수수료' : '공급가액'
      if (vatCharged && dealType.vatMode !== 'NONE' && dealType.vatMode !== 'EXEMPT' && dealType.vatMode !== 'ZERO') {
        const { supply, vat } = splitVat(remainder, 'INCLUDED', dealType.vatRate, 'FLOOR')
        rows.push({ label: kindLabel, amount: supply.toString(), owner: '회사' })
        rows.push({ label: '부가세', amount: vat.toString(), owner: '국세청' })
      } else {
        rows.push({ label: kindLabel, amount: remainder.toString(), owner: '회사' })
      }
    }
    const company = rows.filter((r) => r.owner === '회사').reduce((s, r) => s.plus(D(r.amount)), D(0))
    const cny = fxRate && D(fxRate).gt(0) ? krwToCny(company, fxRate) : null
    return { error: undefined as string | undefined, rows, company: company.toString(), cny: cny?.toString() ?? null }
  }, [amount, depositGoods, dealType, route, vatCharged, fxRate])

  const step = !partnerId ? 1 : !route ? 2 : 3
  // 해외송금은 CNY 정산, 나머지는 KRW 정산. 계좌통화와 다를 때만 환율이 필요하다.
  const settlementCurrency = route === 'OVERSEAS' ? 'CNY' : 'KRW'
  const needsFx = !!account && account.currency !== settlementCurrency

  return (
    <form action={action} className="space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">새 거래 등록</h1>
          <p className="mt-1 text-sm text-ink-muted">거래처 → 루트 → 입금액 순서로 넣으시면 됩니다.</p>
        </div>
        <Link href="/orders" className="btn-ghost no-underline">목록으로</Link>
      </header>

      <FormError message={state.error} />

      {/* STEP 1 */}
      <Step n={1} title="거래처 선택" done={!!partnerId} active={step === 1}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="거래처" name="partnerId" required>
            <select id="partnerId" name="partnerId" value={partnerId} onChange={(e) => onPickPartner(e.target.value)} required>
              <option value="">선택하세요</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
              ))}
            </select>
          </Field>
          {partner && (
            <div className="self-end pb-1">
              {D(depositBalance).gt(0) ? (
                <p className="rounded-sm border border-clay bg-clay-soft px-3 py-2 text-sm text-clay">
                  현재 예치금 <b className="num">{fmtKrw(depositBalance)}</b>원 보유 중
                </p>
              ) : (
                <p className="hint pb-1.5">예치금 잔액 없음</p>
              )}
            </div>
          )}
        </div>
      </Step>

      {/* STEP 2 */}
      <Step n={2} title="돈이 들어온 루트" done={!!route} active={step === 2} disabled={!partnerId}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {ROUTES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => applyRoute(r.value)}
              className={`rounded-sm border px-3 py-3 text-left transition ${
                route === r.value ? 'border-jade bg-jade-soft' : 'border-line bg-surface hover:bg-sunken'
              }`}
            >
              <span className="text-base" aria-hidden>{r.icon}</span>
              <span className={`ml-1.5 text-sm font-medium ${route === r.value ? 'text-jade' : ''}`}>{r.label}</span>
              <span className="mt-1 block text-[11px] leading-snug text-ink-muted">{r.hint}</span>
            </button>
          ))}
        </div>
        <input type="hidden" name="route" value={route} />
      </Step>

      {/* STEP 3 */}
      <Step n={3} title="입금 입력" done={false} active={step === 3} disabled={!route}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="일자" name="orderDate" required>
            <input id="orderDate" name="orderDate" type="date" required
              defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="거래유형" name="dealTypeId" required
            hint={dealType ? `${VAT_MODE_LABEL[dealType.vatMode as keyof typeof VAT_MODE_LABEL]} · ${dealType.accountingClass}` : undefined}>
            <select id="dealTypeId" name="dealTypeId" value={dealTypeId}
              onChange={(e) => {
                setDealTypeId(e.target.value)
                const d = dealTypes.find((x) => x.id === e.target.value)
                if (d) {
                  setIssueInvoice(d.invoiceDefault)
                  setVatCharged(d.vatMode === 'EXCLUDED' || d.vatMode === 'INCLUDED')
                }
              }} required>
              <option value="">선택하세요</option>
              {dealTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="입금 계좌" name="accountId" required>
            <select id="accountId" name="accountId" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
              <option value="">선택하세요</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
            </select>
          </Field>

          <Field label={account?.currency === 'CNY' ? 'CNY 실제 도착금액' : '실제 입금액 (KRW)'} name="amount" required
            hint={route === 'OVERSEAS' ? '마진은 이 금액 기준으로 계산됩니다' : '통장에 찍힌 금액 그대로 넣으세요'}>
            <input id="amount" name="amount" inputMode="decimal" className="num" required
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </Field>

          {route === 'OVERSEAS' && (
            <Field label="USD 인보이스 금액" name="usdAmount" hint="통관 서류용 참고값. 마진 계산에 쓰지 않습니다.">
              <input id="usdAmount" name="usdAmount" inputMode="decimal" className="num" placeholder="0.00" />
            </Field>
          )}

          <Field label="적용환율 (1위안당 원)" name="fxRate" required={needsFx}
            hint={needsFx
              ? '정산통화가 달라 환산에 필요합니다'
              : 'CNY 환산 참고용입니다. 비워두셔도 됩니다.'}>
            <input id="fxRate" name="fxRate" inputMode="decimal" className="num" required={needsFx}
              value={fxRate} onChange={(e) => setFxRate(e.target.value)} placeholder="218.00" />
          </Field>

          {route === 'SITE' && (
            <>
              <Field label="구매대행 수수료율 (%)" name="feeRatePct" hint="넣으면 예치금이 자동으로 갈립니다">
                <input id="feeRatePct" inputMode="decimal" className="num"
                  value={feeRate} onChange={(e) => onFeeRateChange(e.target.value)} placeholder="9.09" />
              </Field>
              <Field label="상품구매 예치금" name="depositGoods" required
                hint="고객 돈입니다. 중국으로 보내야 할 금액.">
                <input id="depositGoods" name="depositGoods" inputMode="decimal" className="num" required
                  value={depositGoods} onChange={(e) => setDepositGoods(e.target.value)} placeholder="0" />
              </Field>
            </>
          )}

          <Field label="건명" name="title" className="md:col-span-2">
            <input id="title" name="title" placeholder="예: 5월 1차 의류 주문" />
          </Field>
          <Field label="기존 관리번호" name="externalRef" hint="엑셀에서 쓰시던 번호 (아르미르샵133 등)">
            <input id="externalRef" name="externalRef" />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="vatCharged" checked={vatCharged} onChange={(e) => setVatCharged(e.target.checked)} />
            부가세를 받았음
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="issueInvoice" checked={issueInvoice} onChange={(e) => setIssueInvoice(e.target.checked)} />
            세금계산서 발행 대상
          </label>
          {route === 'BANK_GEN' && (
            <>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" name="asDeposit" checked={asDeposit}
                  onChange={(e) => { setAsDeposit(e.target.checked); if (e.target.checked) setFromDeposit(false) }} />
                예치금으로 적립 (주문 만들지 않음)
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" name="fromDeposit" checked={fromDeposit}
                  onChange={(e) => { setFromDeposit(e.target.checked); if (e.target.checked) setAsDeposit(false) }} />
                예치금에서 충당
              </label>
            </>
          )}
        </div>

        {/* 입력한 금액이 어떻게 갈리는지 저장 전에 보여준다 */}
        {preview && !preview.error && preview.rows.length > 0 && !asDeposit && (
          <div className="mt-4 rounded-sm border border-line bg-surface px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">이 입금은 이렇게 나뉩니다</p>
            <table className="mt-2">
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="border-0 py-1 text-sm">{r.label}</td>
                    <td className="n border-0 py-1 text-sm">
                      {account?.currency === 'CNY' ? fmtCny(r.amount) : fmtKrw(r.amount)}
                    </td>
                    <td className="border-0 py-1 pl-3">
                      <span className={r.owner === '회사' ? 'pill-good' : r.owner === '국세청' ? 'pill-gold' : 'pill-warn'}>
                        {r.owner} 돈
                      </span>
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line-strong">
                  <td className="border-0 pt-2 text-sm font-semibold">매출로 인식되는 금액</td>
                  <td className="n border-0 pt-2 text-sm font-semibold text-jade">
                    {account?.currency === 'CNY' ? fmtCny(preview.company) : fmtKrw(preview.company)}
                  </td>
                  <td className="border-0 pt-2 pl-3 text-xs text-ink-muted">
                    {preview.cny && `≈ CNY ${fmtCny(preview.cny)}`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {preview?.error && <p className="field-error mt-3">{preview.error}</p>}

        <Field label="메모" name="memo" className="mt-4">
          <input id="memo" name="memo" />
        </Field>
      </Step>

      <div className="flex gap-2">
        <SubmitButton pendingLabel="등록 중…">거래 등록</SubmitButton>
        <Link href="/orders" className="btn-ghost no-underline">취소</Link>
      </div>
    </form>
  )
}

function Step({
  n, title, children, done, active, disabled,
}: {
  n: number; title: string; children: React.ReactNode
  done: boolean; active: boolean; disabled?: boolean
}) {
  return (
    <section className={`card ${disabled ? 'opacity-50' : ''} ${active ? 'border-jade' : ''}`}>
      <div className="card-head">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] ${
            done ? 'bg-jade text-white' : active ? 'bg-jade-soft text-jade' : 'bg-sunken text-ink-muted'
          }`}>{done ? '✓' : n}</span>
          {title}
        </h2>
      </div>
      <div className="card-body">{children}</div>
    </section>
  )
}
