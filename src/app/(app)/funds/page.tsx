import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { fundsSnapshot, latestFxRate } from '@/lib/funds'
import { fmtKrw, fmtCny, D } from '@/lib/money'
import { fmtDate } from '@/lib/serialize'
import { ENTITY_LABEL } from '@/lib/labels'

export const dynamic = 'force-dynamic'

export default async function FundsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>
}) {
  await requireUser()
  const sp = await searchParams
  const asOf = sp.asOf ? new Date(`${sp.asOf}T23:59:59`) : undefined

  const [f, fxRate] = await Promise.all([fundsSnapshot(asOf), latestFxRate()])
  const unconvertible = f.accounts.filter((a) => a.currency !== 'KRW' && !fxRate)

  const pct = (v: typeof f.customerDeposits) =>
    f.totalBalanceKrw.gt(0) ? Math.max(0, Number(v.div(f.totalBalanceKrw).mul(100))) : 0

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">자금현황</h1>
          <p className="mt-1 text-sm text-ink-muted">
            통장에 있는 돈과 회사가 쓸 수 있는 돈은 다릅니다.
          </p>
        </div>
        <form method="get" className="flex items-end gap-2">
          <div>
            <label htmlFor="asOf">기준일</label>
            <input id="asOf" name="asOf" type="date" defaultValue={sp.asOf ?? ''} />
          </div>
          <button type="submit" className="btn-ghost whitespace-nowrap">조회</button>
        </form>
      </header>

      {/* 가장 중요한 숫자 하나 */}
      <section className="card border-jade">
        <div className="card-body text-center">
          <p className="text-sm text-ink-muted">실제 사용가능 자금</p>
          <p className={`mt-1 num text-4xl font-semibold ${f.available.lt(0) ? 'text-clay' : 'text-jade'}`}>
            ₩ {fmtKrw(f.available)}
          </p>
          <p className="mt-2 text-xs text-ink-muted">
            계좌 {fmtKrw(f.totalBalanceKrw)} − 고객예치금 {fmtKrw(f.customerDeposits)}
            {' '}− 부가세 {fmtKrw(f.vatPayable)} − 미지급 {fmtKrw(f.unpaidExpenses)}
          </p>
        </div>
      </section>

      {/* 구성 막대 */}
      {f.totalBalanceKrw.gt(0) && (
        <section className="card">
          <div className="card-body">
            <p className="font-mono text-[10px] uppercase tracking-[0.11em] text-ink-muted">
              계좌잔액 ₩{fmtKrw(f.totalBalanceKrw)} 의 구성
            </p>
            <div className="mt-2.5 flex h-12 overflow-hidden rounded-sm border border-line-strong">
              {f.remitPending.gt(0) && (
                <Seg width={pct(f.remitPending)} bg="bg-clay-soft" text="text-clay"
                  label="송금대기" value={fmtKrw(f.remitPending)} />
              )}
              {f.customerDeposits.minus(f.remitPending).gt(0) && (
                <Seg width={pct(f.customerDeposits.minus(f.remitPending))} bg="bg-clay-soft/60" text="text-clay"
                  label="예치금" value={fmtKrw(f.customerDeposits.minus(f.remitPending))} />
              )}
              {f.vatPayable.gt(0) && (
                <Seg width={pct(f.vatPayable)} bg="bg-gold-soft" text="text-gold"
                  label="부가세" value={fmtKrw(f.vatPayable)} />
              )}
              {f.available.gt(0) && (
                <Seg width={pct(f.available)} bg="bg-jade-soft" text="text-jade"
                  label="회사 몫" value={fmtKrw(f.available)} />
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span className="text-clay">
                ■ 고객 돈 <span className="num">{fmtKrw(f.customerDeposits)}</span>
                <span className="ml-1 text-ink-muted">{pct(f.customerDeposits).toFixed(1)}%</span>
              </span>
              <span className="text-gold">
                ■ 국세청 돈 <span className="num">{fmtKrw(f.vatPayable)}</span>
                <span className="ml-1 text-ink-muted">{pct(f.vatPayable).toFixed(1)}%</span>
              </span>
              <span className="text-jade">
                ■ 회사 돈 <span className="num">{fmtKrw(f.available)}</span>
                <span className="ml-1 text-ink-muted">{pct(f.available).toFixed(1)}%</span>
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        {/* 계좌 */}
        <div className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">계좌별 잔액</h2></div>
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr><th>계좌</th><th className="w-20">주체</th><th className="w-32 n">잔액</th></tr>
              </thead>
              <tbody>
                {f.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{a.name}</td>
                    <td className="text-xs">
                      <span className={a.entity === 'CN' ? 'pill-warn' : 'pill-neutral'}>{ENTITY_LABEL[a.entity]}</span>
                    </td>
                    <td className="n text-sm">
                      {a.currency === 'KRW' ? fmtKrw(a.balance) : `${a.currency} ${fmtCny(a.balance)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-sunken font-semibold">
                  <td colSpan={2} className="text-xs">합계 (원화 환산)</td>
                  <td className="n text-sm">{fmtKrw(f.totalBalanceKrw)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {fxRate && (
            <p className="hint border-t border-line px-5 py-2">
              CNY 환산에 최근 적용환율 <span className="num">{fxRate.toString()}</span>을 썼습니다.
            </p>
          )}
          {unconvertible.length > 0 && (
            <p className="border-t border-line px-5 py-2 text-xs text-clay">
              환율 기록이 없어 {unconvertible.map((a) => a.name).join(', ')} 잔액은 합계에 넣지 못했습니다.
              거래를 한 건이라도 환율과 함께 등록하면 반영됩니다.
            </p>
          )}
        </div>

        {/* 남의 돈 */}
        <div className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">빼야 할 돈</h2></div>
          <div className="card-body">
            <table>
              <tbody>
                <tr>
                  <td className="text-sm">고객 예치금</td>
                  <td className="n text-sm text-clay">{fmtKrw(f.customerDeposits)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">고객 돈</td>
                </tr>
                <tr>
                  <td className="pl-4 text-sm text-ink-muted">└ 중국 송금대기금</td>
                  <td className="n text-sm text-clay">{fmtKrw(f.remitPending)}</td>
                  <td className="pl-3">
                    {f.remitPending.gt(0) && <Link href="/remittances" className="text-[11px] no-underline hover:underline">송금하기 →</Link>}
                  </td>
                </tr>
                <tr>
                  <td className="text-sm">부가세 예수금</td>
                  <td className="n text-sm text-gold">{fmtKrw(f.vatPayable)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">국세청에 낼 돈</td>
                </tr>
                <tr>
                  <td className="text-sm">미지급 비용</td>
                  <td className="n text-sm">{fmtKrw(f.unpaidExpenses)}</td>
                  <td className="pl-3 text-[11px] text-ink-muted">지급예정</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 받을 돈 */}
      {f.receivables.length > 0 && (
        <section className="card border-clay">
          <div className="card-head bg-clay-soft">
            <h2 className="text-sm font-semibold text-clay">받을 돈 (미수금)</h2>
            <span className="num text-sm font-semibold text-clay">₩ {fmtKrw(f.receivableTotal)}</span>
          </div>
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr>
                  <th>거래처</th>
                  <th className="w-40">주문번호</th>
                  <th className="w-32 n">미수 원금</th>
                  <th className="w-32 n">청구예정</th>
                  <th className="w-24 n">경과</th>
                </tr>
              </thead>
              <tbody>
                {f.receivables.map((r) => (
                  <tr key={r.orderId}>
                    <td className="text-sm">
                      <Link href={`/partners/${r.partnerId}`} className="no-underline hover:underline">{r.partnerName}</Link>
                    </td>
                    <td>
                      <Link href={`/orders/${r.orderId}`} className="num text-xs no-underline hover:underline">{r.orderNo}</Link>
                      <p className="text-[11px] text-ink-muted">{fmtDate(r.firstDate)}</p>
                    </td>
                    <td className="n text-sm text-clay">
                      {r.currency === 'KRW' ? fmtKrw(r.amount) : `CNY ${fmtCny(r.amount)}`}
                      {r.currency !== 'KRW' && <p className="text-[11px] text-ink-muted">≈ ₩{fmtKrw(r.amountKrw)}</p>}
                    </td>
                    <td className="n text-sm">{r.billableKrw.gt(r.amountKrw) ? `₩${fmtKrw(r.billableKrw)}` : '—'}</td>
                    <td className="n text-xs">
                      <span className={r.daysOld >= 90 ? 'pill-warn' : r.daysOld >= 30 ? 'pill-gold' : 'pill-neutral'}>
                        {r.daysOld}일
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint border-t border-line px-5 py-2">
            지출은 나갔는데 아직 입금되지 않은 금액입니다. 통장에는 없지만 받을 권리가 있는 자산이라
            위 계좌잔액에 더하지 않고 따로 보여드립니다. 30일·90일에 색이 바뀝니다.
          </p>
        </section>
      )}

      {/* 거래처별 예치금 */}
      {f.depositsByPartner.length > 0 && (
        <section className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">거래처별 예치금 잔액</h2></div>
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr>
                  <th>거래처</th>
                  <th className="w-36 n">상품구매자금</th>
                  <th className="w-36 n">용도미지정</th>
                  <th className="w-36 n">합계</th>
                  <th className="w-24"> </th>
                </tr>
              </thead>
              <tbody>
                {f.depositsByPartner.map((d) => (
                  <tr key={d.partnerId}>
                    <td className="text-sm">
                      <Link href={`/partners/${d.partnerId}`} className="no-underline hover:underline">{d.partnerName}</Link>
                    </td>
                    <td className="n text-sm text-clay">{fmtKrw(d.goodsFund)}</td>
                    <td className="n text-sm">{fmtKrw(d.general)}</td>
                    <td className="n text-sm font-medium">{fmtKrw(d.total)}</td>
                    <td>
                      {d.goodsFund.gt(0) && (
                        <Link href={`/remittances/new?partner=${d.partnerId}`} className="btn-ghost btn-sm no-underline">송금</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {f.depositsByPartner.length === 0 && f.receivables.length === 0 && f.totalBalanceKrw.isZero() && (
        <div className="card">
          <div className="card-body text-center text-sm text-ink-muted">
            아직 거래가 없습니다. 계좌 기초잔액을 넣거나 거래를 등록하면 여기에 나타납니다.
          </div>
        </div>
      )}
    </div>
  )
}

function Seg({ width, bg, text, label, value }: { width: number; bg: string; text: string; label: string; value: string }) {
  // 비중이 작으면 글자가 잘려 읽을 수 없다. 색만 남기고 값은 아래 범례에서 읽게 한다.
  const showText = width >= 14
  return (
    <div
      className={`flex min-w-0 flex-col justify-center overflow-hidden ${showText ? 'px-2.5' : ''} ${bg}`}
      style={{ flex: `0 0 ${Math.max(width, 1.5)}%` }}
      title={`${label} ${value}`}
    >
      {showText && (
        <>
          <span className={`num truncate text-xs font-medium ${text}`}>{value}</span>
          <span className={`truncate text-[10px] ${text}`}>{label}</span>
        </>
      )}
    </div>
  )
}
