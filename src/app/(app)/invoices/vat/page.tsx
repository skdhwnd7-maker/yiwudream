import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { listVatPeriods, vatStanding } from '@/lib/vat'
import { fundsSnapshot } from '@/lib/funds'
import { fmtKrw } from '@/lib/money'
import { fmtDate } from '@/lib/serialize'
import { NewPeriodForm, PeriodActions } from './VatForms'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  OPEN: '진행중', FILED: '신고완료', PAID: '납부완료',
}
const STATUS_PILL: Record<string, string> = {
  OPEN: 'pill-neutral', FILED: 'pill-gold', PAID: 'pill-good',
}

export default async function VatPage() {
  await requirePermission('invoice.confirm')

  const [periods, standing, funds, accounts] = await Promise.all([
    listVatPeriods(),
    vatStanding(),
    fundsSnapshot(),
    prisma.account.findMany({
      where: { isActive: true, entity: 'KR' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">부가세 신고·납부</h1>
          <p className="mt-1 text-sm text-ink-muted">
            신고를 마친 기간은 예수금에서 빠집니다. 이미 낸 부가세가 계속 회사 돈에서
            빠져 있으면 쓸 수 있는 돈을 실제보다 적게 보게 됩니다.
          </p>
        </div>
        <Link href="/invoices" className="btn-ghost no-underline">세금계산서로</Link>
      </header>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">지금 상태</h2></div>
        <div className="card-body grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="지금까지 받은 부가세" value={fmtKrw(standing.collectedTotal)} />
          <Stat label="신고를 마친 몫" value={fmtKrw(standing.settled)}
            note={standing.settledThrough
              ? `${fmtDate(standing.settledThrough)} 까지`
              : '아직 신고한 기간이 없습니다'} />
          <Stat label="갖고 있어야 할 돈" value={fmtKrw(standing.payable)} tone="text-gold"
            note="국세청에 낼 돈" />
          <Stat label="실제 사용가능 자금" value={fmtKrw(funds.available)}
            tone={funds.available.lt(0) ? 'text-clay' : 'text-jade'} />
        </div>
        {standing.filedUnpaid.gt(0) && (
          <div className="card-foot text-xs text-ink-2">
            신고는 했는데 아직 내지 않은 금액이 {fmtKrw(standing.filedUnpaid)}원 있습니다.
            곧 나갈 돈이라 사용가능 자금에서 빼 두었습니다.
          </div>
        )}
        {standing.receivable.gt(0) && (
          <div className="card-foot text-xs text-ink-2">
            환급받을 금액이 {fmtKrw(standing.receivable)}원 있습니다.
            아직 통장에 들어오지 않은 돈이라 사용가능 자금에 더하지 않았습니다.
            실제로 받으시면 납부 처리에서 <b>음수</b>로 넣고 입금 계좌를 고르세요.
          </div>
        )}
      </div>

      <NewPeriodForm />

      <div className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">신고기간</h2>
          <span className="text-xs text-ink-muted">{periods.length}건</span>
        </div>
        {periods.length === 0 ? (
          <div className="card-body text-sm text-ink-muted">
            아직 등록한 신고기간이 없습니다. 지금은 받은 부가세 전액이 예수금으로 잡혀 있습니다.
          </div>
        ) : (
          <div className="table-wrap border-0">
            <table>
              <thead>
                <tr>
                  <th>기간</th>
                  <th className="w-44">날짜</th>
                  <th className="w-28 text-right">신고 매출세액</th>
                  <th className="w-28 text-right">시스템 집계</th>
                  <th className="w-24 text-right">차이</th>
                  <th className="w-28 text-right">납부예정</th>
                  <th className="w-20">상태</th>
                  <th className="w-40"> </th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id.toString()}>
                    <td className="text-sm">
                      {p.label}
                      <span className="ml-2 font-mono text-[11px] text-ink-muted">{p.code}</span>
                    </td>
                    <td className="font-mono text-xs text-ink-muted">
                      {fmtDate(p.periodFrom)} ~ {fmtDate(p.periodTo)}
                    </td>
                    <td className="n text-xs">{fmtKrw(p.salesVat)}</td>
                    <td className="n text-xs text-ink-muted">{fmtKrw(p.collected)}</td>
                    <td className={`n text-xs ${p.diff.isZero() ? 'text-ink-muted' : 'text-gold'}`}>
                      {p.diff.isZero() ? '—' : fmtKrw(p.diff)}
                    </td>
                    <td className="n text-xs">{fmtKrw(p.netPayable)}</td>
                    <td className="text-xs">
                      <span className={STATUS_PILL[p.status]}>{STATUS_LABEL[p.status]}</span>
                    </td>
                    <td>
                      <PeriodActions
                        id={p.id.toString()} status={p.status}
                        netPayable={p.netPayable.toString()}
                        accounts={accounts.map((a) => ({ id: a.id.toString(), name: a.name }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-foot text-xs leading-relaxed text-ink-3">
          <strong>신고 매출세액</strong>은 세무사님이 주신 신고서 값입니다.
          <strong className="ml-2">시스템 집계</strong>는 그 기간에 이 프로그램이 받은 부가세입니다.
          둘이 다르면 차이 칸에 표시됩니다 — 어느 쪽이 맞는지는 프로그램이 판단하지 않습니다.
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, note, tone = '' }: {
  label: string; value: string; note?: string; tone?: string
}) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 num text-lg font-semibold ${tone}`}>{value}</p>
      {note && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{note}</p>}
    </div>
  )
}
