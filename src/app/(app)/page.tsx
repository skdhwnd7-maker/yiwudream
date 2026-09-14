import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { dashboardData, currentYm } from '@/lib/dashboard'
import { latestFxRate } from '@/lib/funds'
import { fmtKrw, fmtCny, fmtPercent, D } from '@/lib/money'
import { can } from '@/lib/permissions'
import MiniBars from '@/components/MiniBars'
import RouteBars from '@/components/RouteBars'
import StaffHome from './StaffHome'

export const dynamic = 'force-dynamic'

// 검증된 조합 (dataviz 팔레트): 대비·색각 검사 통과
const VIZ_REVENUE = '#2a78d6'
const VIZ_MARGIN = '#1baf7a'

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>
}) {
  const user = await requireUser()
  // 입력만 하는 직원에게는 회사 손익 대신 「오늘 할 일」 화면을 보여 준다
  if (!can(user.role, 'profit.view')) {
    return <StaffHome userId={BigInt(user.id)} userName={user.name} />
  }
  const sp = await searchParams
  const ym = /^\d{4}-\d{2}$/.test(sp.ym ?? '') ? sp.ym! : currentYm()

  const [d, fx] = await Promise.all([dashboardData(ym), latestFxRate()])
  const hasData = d.totalRevenue.gt(0) || d.customerDeposits.gt(0) || d.opTotal.gt(0)

  return (
    <div className="mx-auto max-w-[1180px] space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">대시보드</h1>
          <p className="mt-1 text-sm text-ink-muted">{d.label} 기준</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href={`/?ym=${shiftMonth(ym, -1)}`} className="btn-ghost btn-sm no-underline">← 이전달</Link>
          <form method="get" className="flex items-end gap-1.5">
            <input name="ym" defaultValue={ym} className="num w-28" aria-label="조회 월" />
            <button type="submit" className="btn-ghost btn-sm whitespace-nowrap">조회</button>
          </form>
          <Link href={`/?ym=${shiftMonth(ym, 1)}`} className="btn-ghost btn-sm no-underline">다음달 →</Link>
        </div>
      </header>

      {!hasData && (
        <div className="card border-gold bg-gold-soft">
          <div className="card-body text-sm leading-relaxed text-ink-2">
            <p className="font-medium text-gold">{d.label}에 집계할 거래가 없습니다</p>
            <p className="mt-1.5">
              거래를 등록하면 이 화면에 매출·마진·고객 자금이 나타납니다.
              {' '}<Link href="/orders/new" className="no-underline hover:underline">새 거래 등록 →</Link>
            </p>
          </div>
        </div>
      )}

      {/* 대표님이 가장 먼저 볼 네 숫자 */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Hero label="총 거래액" value={fmtKrw(d.totalRevenue)} sub="이 달에 들어온 입금 기준" />
        <Hero label="최종 영업마진" value={fmtKrw(d.operatingMargin)}
          tone={d.operatingMargin.lt(0) ? 'clay' : 'jade'} sub="매출 − 주문원가 − 운영비" />
        <Hero label="마진율" value={fmtPercent(d.operatingMarginRate)} sub="매출 대비" />
        <Hero label="실제 사용가능 자금" value={fmtKrw(d.available)}
          tone={d.available.lt(0) ? 'clay' : 'jade'} sub="월말 기준" href="/funds" />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        {/* 루트별 */}
        <div className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">루트별 거래액</h2>
            <span className="num text-xs text-ink-muted">{fmtKrw(d.totalRevenue)}</span>
          </div>
          <div className="card-body">
            <RouteBars color={VIZ_REVENUE}
              bars={d.byRoute.map((r) => ({
                label: r.label, value: Number(r.revenue), display: fmtKrw(r.revenue), count: r.orderCount,
              }))} />
            {(d.internalTransferUsd.gt(0) || d.internalTransferCny.gt(0)) && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-ink-2">🔁 내부 자금이동</span>
                  <span className="num text-ink-2">
                    USD {fmtCny(d.internalTransferUsd)} → CNY {fmtCny(d.internalTransferCny)}
                  </span>
                </div>
                <p className="hint mt-1">자사 자금이동이라 거래액에 넣지 않습니다.</p>
              </div>
            )}
          </div>
        </div>

        {/* 추이 — 매출과 마진은 크기가 달라 각자 축으로 그린다 */}
        <div className="card">
          <div className="card-head"><h2 className="text-sm font-semibold">최근 12개월 추이</h2></div>
          <div className="card-body space-y-4">
            <MiniBars title="매출인식액" color={VIZ_REVENUE}
              points={d.trend.map((t) => ({
                label: t.ym.slice(2), value: Number(t.revenue), display: fmtKrw(t.revenue),
              }))} />
            <MiniBars title="영업마진" color={VIZ_MARGIN}
              points={d.trend.map((t) => ({
                label: t.ym.slice(2), value: Number(t.margin), display: fmtKrw(t.margin),
              }))} />
            <p className="hint">
              막대에 마우스를 올리면 그 달 값이 위에 표시됩니다. 두 지표는 크기가 달라 각각의 축으로 그렸습니다.
              전표에 적힌 날짜 기준이라 <strong>지난 달 숫자는 나중에 바뀌지 않습니다.</strong>
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {/* 수익 구성 — 전부 이 달 전표 기준 */}
        <div className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">이 달 손익</h2>
            <span className="text-xs text-ink-muted">전표 날짜 기준</span>
          </div>
          <div className="table-wrap border-0">
            <table>
              <tbody>
                <Row label="상품·용역 매출" value={fmtKrw(d.salesRevenue)} />
                <Row label="구매대행 수수료" value={fmtKrw(d.feeRevenue)} />
                <Row label="주문 원가" value={`− ${fmtKrw(d.totalCost)}`} muted />
                <Row label="중국 운영비" value={`− ${fmtKrw(d.opTotal)}`} muted />
                <tr className="border-t border-line">
                  <td className="pt-2 text-sm">영업마진</td>
                  <td className={`n pt-2 text-sm font-medium ${d.operatingMargin.lt(0) ? 'text-clay' : 'text-jade'}`}>
                    {fmtKrw(d.operatingMargin)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card-foot text-xs leading-relaxed text-ink-3">
            매출은 입금일, 비용은 지출일 기준입니다. 받은 부가세 {fmtKrw(d.vatCollected)}원은
            매출이 아니라 국세청에 낼 돈이라 여기 넣지 않았습니다.
          </div>
        </div>

        {/* 중국 운영비 */}
        <div className="card">
          <div className="card-head">
            <h2 className="text-sm font-semibold">중국 운영비</h2>
            <Link href="/office" className="text-xs no-underline hover:underline">자세히 →</Link>
          </div>
          <div className="table-wrap border-0">
            <table>
              <tbody>
                <Row label="직원 급여" value={fmtKrw(d.opSalary)} />
                <Row label="사회보험" value={fmtKrw(d.opInsurance)} />
                <Row label="임시공 비용" value={fmtKrw(d.opTempLabor)} />
                <Row label="사무실 경비" value={fmtKrw(d.opOffice)} />
                {d.opEtc.gt(0) && <Row label="기타" value={fmtKrw(d.opEtc)} />}
                <tr className="border-t border-line">
                  <td className="pt-2 text-sm">합계</td>
                  <td className="n pt-2 text-sm font-medium">{fmtKrw(d.opTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint border-t border-line px-5 py-2">
            주문에 귀속되지 않은 비용만 여기 잡힙니다. 임시공을 특정 주문에 연결하면 그 거래의 원가가 됩니다.
          </p>
        </div>
      </section>

      {/* 주문 기준 — 기간 손익과 뜻이 다르다 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">이 달에 시작한 주문의 수익성</h2>
          <span className="text-xs text-ink-muted">{d.orderStarted.orderCount}건</span>
        </div>
        <div className="card-body grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Mini label="매출" value={fmtKrw(d.orderStarted.revenue)} tone="slate" note="그 주문에 들어온 돈 전부" />
          <Mini label="원가" value={fmtKrw(d.orderStarted.cost)} tone="slate" note="그 주문에 나간 돈 전부" />
          <Mini label="마진" value={fmtKrw(d.orderStarted.margin)}
            tone={d.orderStarted.margin.lt(0) ? 'clay' : 'jade'} />
          <Mini label="마진율" value={fmtPercent(d.orderStarted.marginRate)} tone="slate" note="매출 대비" />
        </div>
        <div className="card-foot text-xs leading-relaxed text-ink-3">
          위 「이 달 손익」과 뜻이 다릅니다. 여기는 <strong>이 달에 받은 일이 남는 장사였나</strong>를 봅니다 —
          그 주문에 나중에 입금이나 지출이 붙으면 이 숫자는 바뀝니다.
          월별 손익은 전표 날짜로 고정되어 바뀌지 않습니다.
          {d.orderStarted.unbilledOrderCount > 0 && (
            <>
              {' '}이 달 주문 {d.orderStarted.unbilledOrderCount}건은 아직 입금이 없어
              비용 {fmtKrw(d.orderStarted.unbilledOrderCost)}원만 나갔고, 마진 집계에서는 뺐습니다.
            </>
          )}
        </div>
      </section>

      {/* 남의 돈 / 받을 돈 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">고객 자금과 받을 돈</h2>
          <Link href="/funds" className="text-xs no-underline hover:underline">자금현황 →</Link>
        </div>
        <div className="card-body grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Mini label="고객 예치금" value={fmtKrw(d.customerDeposits)} tone="clay" note="고객 돈" />
          <Mini label="중국 송금대기금" value={fmtKrw(d.remitPending)} tone="clay" note="보내야 할 돈"
            href={d.remitPending.gt(0) ? '/remittances' : undefined} />
          <Mini label="부가세 예수금" value={fmtKrw(d.vatPayable)} tone="gold"
            note="아직 신고 안 한 몫" href="/invoices/vat" />
          <Mini label="받을 돈 (미수금)" value={fmtKrw(d.receivableTotal)} tone="clay" note="통장에 없는 자산"
            href={d.receivableTotal.gt(0) ? '/funds' : undefined} />
        </div>
      </section>

      {/* 세금계산서 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">세금계산서</h2>
          <Link href="/invoices" className="text-xs no-underline hover:underline">관리 →</Link>
        </div>
        <div className="card-body grid gap-4 sm:grid-cols-3">
          <Mini label="발행 예정" value={fmtKrw(d.invoicePending)} tone="gold" />
          <Mini label="발행 완료" value={fmtKrw(d.invoiceIssued)} tone="jade" note={d.label} />
          <Mini label="미발행 · 부가세 수취" value={fmtKrw(d.unbilledVatAmount)} tone="clay"
            note={`${d.unbilledVatCount}건`}
            href={d.unbilledVatCount > 0 ? '/invoices?tab=unbilled' : undefined} />
        </div>
      </section>

      {/* 거래처 순위 */}
      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">거래처별 순위 (마진 기준)</h2>
          <span className="text-xs text-ink-muted">{d.label}</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-12 n">순위</th>
                <th>거래처</th>
                <th className="w-32 n">매출</th>
                <th className="w-32 n">마진</th>
                <th className="w-24 n">마진율</th>
                <th className="w-20 n">주문수</th>
              </tr>
            </thead>
            <tbody>
              {d.ranks.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-sm text-ink-muted">
                  {d.label}에 거래가 없습니다.
                </td></tr>
              )}
              {d.ranks.map((r, i) => (
                <tr key={r.partnerId}>
                  <td className="n text-xs text-ink-muted">{i + 1}</td>
                  <td className="text-sm">
                    <Link href={`/partners/${r.partnerId}`} className="no-underline hover:underline">{r.partnerName}</Link>
                  </td>
                  <td className="n text-sm">{fmtKrw(r.revenue)}</td>
                  <td className={`n text-sm ${r.margin.lt(0) ? 'text-clay' : 'text-jade'}`}>{fmtKrw(r.margin)}</td>
                  <td className="n text-xs">{fmtPercent(r.marginRate)}</td>
                  <td className="n text-xs text-ink-muted">{r.orderCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint border-t border-line px-5 py-2">
          이우드림(자사) 자체 거래는 순위에서 제외됩니다.
          {fx && ` CNY 정산 주문은 환율 ${fx.toString()}으로 환산했습니다.`}
        </p>
      </section>

      {d.unlockCount > 0 && can(user.role, 'audit.view') && (
        <div className="card border-clay bg-clay-soft">
          <div className="card-body flex items-center justify-between gap-3 text-sm">
            <span className="text-clay">
              {d.label}에 정산완료 주문 <b className="num">{d.unlockCount}건</b>의 잠금이 해제됐습니다.
            </span>
            <Link href="/audit?action=UNLOCK" className="btn-ghost btn-sm no-underline">이력 보기</Link>
          </div>
        </div>
      )}
    </div>
  )
}

function Hero({
  label, value, sub, tone, href,
}: {
  label: string; value: string; sub?: string; tone?: 'jade' | 'clay'; href?: string
}) {
  const color = tone === 'jade' ? 'text-jade' : tone === 'clay' ? 'text-clay' : 'text-ink'
  const body = (
    <div className="card-body">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 num text-2xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-ink-muted">{sub}</p>}
    </div>
  )
  return href
    ? <Link href={href} className="card no-underline transition hover:border-line-strong">{body}</Link>
    : <div className="card">{body}</div>
}

function Mini({
  label, value, tone, note, href,
}: {
  label: string
  value: string
  /** slate = 강조하지 않는 값 (그냥 숫자) */
  tone: 'jade' | 'clay' | 'gold' | 'slate'
  note?: string
  href?: string
}) {
  const color = tone === 'jade' ? 'text-jade'
    : tone === 'clay' ? 'text-clay'
      : tone === 'gold' ? 'text-gold' : 'text-ink'
  const body = (
    <>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 num text-lg font-semibold ${color}`}>{value}</p>
      {note && <p className="text-[11px] text-ink-muted">{note}</p>}
    </>
  )
  return href
    ? <Link href={href} className="block no-underline hover:opacity-80">{body}</Link>
    : <div>{body}</div>
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <tr>
      <td className={`text-sm ${muted ? 'text-ink-muted' : ''}`}>{label}</td>
      <td className={`n text-sm ${muted ? 'text-ink-muted' : ''}`}>{value}</td>
    </tr>
  )
}
