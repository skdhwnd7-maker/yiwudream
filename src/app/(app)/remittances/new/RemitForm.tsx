'use client'

import { useActionState, useMemo, useState } from 'react'
import Link from 'next/link'
import { SubmitButton, FormError } from '@/components/ui'
import { Field } from '@/components/Field'
import { D, fmtKrw, fmtCny } from '@/lib/money'
import { createRemittance, type ActionState } from '../actions'
import { todayISO } from '@/lib/serialize'

interface Row {
  orderId: string; orderNo: string; partnerId: string; partnerName: string
  pending: string; orderDate: string
}
interface Acc { id: string; name: string; currency: string }

export default function RemitForm({
  rows, krAccounts, cnAccounts,
}: {
  rows: Row[]; krAccounts: Acc[]; cnAccounts: Acc[]
}) {
  const [state, action] = useActionState<ActionState, FormData>(createRemittance, {})
  // 이 폼을 연 순간 한 번 만드는 열쇠.
  // 버튼을 두 번 눌러도 같은 값이 가므로 서버에서 두 번째 요청을 알아보고 막는다.
  // useId 를 쓰면 페이지를 새로 열어도 같은 값이 나와 다음 송금이 막힌다 — 마운트마다 새로 만든다.
  const [idemKey] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [krwAmount, setKrwAmount] = useState('')
  const [usdAmount, setUsdAmount] = useState('')
  const [cnyArrival, setCnyArrival] = useState('')

  const allocSum = useMemo(
    () => Object.values(picked).reduce((s, v) => s.plus(D(v || 0)), D(0)),
    [picked],
  )
  const target = D(krwAmount || 0)
  const diff = target.minus(allocSum)
  const matched = target.gt(0) && diff.isZero()

  const effectiveRate = useMemo(() => {
    const k = D(krwAmount || 0), c = D(cnyArrival || 0)
    return k.gt(0) && c.gt(0) ? k.div(c).toDecimalPlaces(2) : null
  }, [krwAmount, cnyArrival])

  function toggle(row: Row, on: boolean) {
    setPicked((p) => {
      const next = { ...p }
      if (on) next[row.orderId] = row.pending
      else delete next[row.orderId]
      return next
    })
  }

  /** 선택한 건들의 대기금 합계를 송금액으로 채운다 */
  function fillFromPicked() {
    setKrwAmount(allocSum.toString())
  }

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="idempotencyKey" value={`remit-${idemKey}`} />
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">해외송금 등록</h1>
          <p className="mt-1 text-sm text-ink-muted">여러 거래처 돈을 합쳐 한 번에 보낼 수 있습니다.</p>
        </div>
        <Link href="/remittances" className="btn-ghost no-underline">목록으로</Link>
      </header>

      <FormError message={state.error} />

      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">이 송금에 포함할 주문</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={fillFromPicked}
            disabled={allocSum.lte(0)}>
            선택 합계를 송금액으로
          </button>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-12"> </th>
                <th>거래처</th>
                <th className="w-40">주문번호</th>
                <th className="w-32 n">송금대기</th>
                <th className="w-36 n">배분액</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = r.orderId in picked
                return (
                  <tr key={r.orderId} className={on ? 'bg-jade-soft' : ''}>
                    <td>
                      <input type="checkbox" checked={on} onChange={(e) => toggle(r, e.target.checked)}
                        aria-label={`${r.orderNo} 포함`} />
                    </td>
                    <td className="text-sm">{r.partnerName}</td>
                    <td className="num text-xs">{r.orderNo}</td>
                    <td className="n text-sm text-clay">{fmtKrw(r.pending)}</td>
                    <td>
                      {on ? (
                        <>
                          <input type="hidden" name="allocOrderId" value={r.orderId} />
                          <input name="allocKrw" inputMode="decimal" className="num text-right text-sm"
                            value={picked[r.orderId]}
                            onChange={(e) => setPicked((p) => ({ ...p, [r.orderId]: e.target.value }))} />
                        </>
                      ) : (
                        <span className="block text-right text-sm text-ink-muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className={matched ? 'bg-jade-soft' : allocSum.gt(0) ? 'bg-clay-soft' : 'bg-sunken'}>
                <td colSpan={3} className="text-sm font-semibold">배분 합계</td>
                <td className="n text-sm">{fmtKrw(target)}</td>
                <td className="n text-sm font-semibold">
                  {fmtKrw(allocSum)}
                  {allocSum.gt(0) && !matched && (
                    <p className="text-[11px] font-normal text-clay">
                      송금액과 {diff.gt(0) ? `${fmtKrw(diff)} 부족` : `${fmtKrw(diff.negated())} 초과`}
                    </p>
                  )}
                  {matched && <p className="text-[11px] font-normal text-jade">송금액과 일치 ✓</p>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">송금 정보</h2></div>
        <div className="card-body grid gap-4 md:grid-cols-3">
          <Field label="송금일" name="remitDate" required>
            <input name="remitDate" type="date" required defaultValue={todayISO()} />
          </Field>
          <Field label="출금 계좌 (한국)" name="fromAccountId" required>
            <select name="fromAccountId" required defaultValue={krAccounts[0]?.id ?? ''}>
              {krAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="수취 계좌 (중국)" name="toAccountId" required>
            <select name="toAccountId" required defaultValue={cnAccounts[0]?.id ?? ''}>
              {cnAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>

          <Field label="KRW 송금액" name="krwAmount" required>
            <input name="krwAmount" inputMode="decimal" className="num" required
              value={krwAmount} onChange={(e) => setKrwAmount(e.target.value)} placeholder="0" />
          </Field>
          <Field label="USD 금액" name="usdAmount">
            <input name="usdAmount" inputMode="decimal" className="num"
              value={usdAmount} onChange={(e) => setUsdAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="CNY 실제 도착금액" name="cnyArrivalAmount"
            hint="아직 모르면 비워두고 나중에 도착확인에서 넣으세요">
            <input name="cnyArrivalAmount" inputMode="decimal" className="num"
              value={cnyArrival} onChange={(e) => setCnyArrival(e.target.value)} placeholder="0.00" />
          </Field>

          <Field label="KRW/USD 환율" name="fxRateKrwUsd">
            <input name="fxRateKrwUsd" inputMode="decimal" className="num" placeholder="1380.00" />
          </Field>
          <Field label="USD/CNY 환율" name="fxRateUsdCny">
            <input name="fxRateUsdCny" inputMode="decimal" className="num" placeholder="7.078" />
          </Field>
          <Field label="송금수수료 (KRW)" name="bankFeeKrw" hint="회사 비용으로 자동 등록됩니다">
            <input name="bankFeeKrw" inputMode="decimal" className="num" placeholder="0" />
          </Field>

          <Field label="상태" name="status">
            <select name="status" defaultValue="SENT">
              <option value="SENT">송금완료</option>
              <option value="ARRIVED">도착확인</option>
              <option value="DRAFT">작성중</option>
            </select>
          </Field>
          <Field label="메모" name="memo" className="md:col-span-2">
            <input name="memo" />
          </Field>
        </div>

        {effectiveRate && (
          <div className="border-t border-line px-5 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">실효환율</span>
            <span className="num ml-2 text-sm font-semibold">
              {effectiveRate.toString()} 원/위안
            </span>
            <span className="ml-2 text-xs text-ink-muted">
              ₩{fmtKrw(krwAmount)} → CNY {fmtCny(cnyArrival)}
            </span>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="등록 중…">송금 등록</SubmitButton>
        <Link href="/remittances" className="btn-ghost no-underline">취소</Link>
        {!matched && allocSum.gt(0) && (
          <span className="text-xs text-clay">배분 합계와 송금액이 정확히 같아야 저장됩니다.</span>
        )}
      </div>
    </form>
  )
}
