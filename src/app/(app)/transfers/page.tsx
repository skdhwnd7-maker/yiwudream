import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtKrw, fmtCny, fmtRate, D } from '@/lib/money'
import { fmtDate, plain } from '@/lib/serialize'
import { can } from '@/lib/permissions'
import TransferForm from './TransferForm'

export const dynamic = 'force-dynamic'

export default async function TransfersPage() {
  const user = await requireUser()

  const [transfers, accounts] = await Promise.all([
    prisma.internalTransfer.findMany({
      include: {
        fromAccount: { select: { name: true } },
        toAccount: { select: { name: true } },
      },
      orderBy: [{ transferDate: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
    prisma.account.findMany({ where: { isActive: true }, orderBy: [{ entity: 'asc' }, { name: 'asc' }] }),
  ])

  const live = transfers.filter((t) => !t.isVoid)
  const totalUsd = live.reduce((s, t) => s.plus(t.usdAmount ?? 0), D(0))
  const totalCny = live.reduce((s, t) => s.plus(t.cnyArrivalAmount ?? 0), D(0))
  const avgRate = totalUsd.gt(0) ? totalCny.div(totalUsd).toDecimalPlaces(4) : null

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="section-title text-xl">내부 자금이동</h1>
        <p className="mt-1 text-sm text-ink-muted">
          한국법인에서 중국법인으로 보내는 자체 자금입니다.
        </p>
      </header>

      <div className="card border-gold bg-gold-soft">
        <div className="card-body text-sm leading-relaxed text-ink-2">
          <p className="font-medium text-gold">고객 거래가 아닙니다</p>
          <p className="mt-1.5">
            기존 엑셀에서는 이 송금이 해외송금 시트에 <span className="font-mono">이우드림</span>이라는
            거래처명으로 섞여 있었고, 지출이 없어 <strong>전액이 매출·마진으로 잡히고 있었습니다.</strong>
            (4개월 CNY 7,516,792 — 해외송금 도착액의 33.7%)
            여기 등록한 건은 매출·마진·거래처 순위 어디에도 들어가지 않고, 계좌 잔액만 움직입니다.
          </p>
        </div>
      </div>

      {can(user.role, 'remittance.execute') && (
        <TransferForm
          krAccounts={plain(accounts.filter((a) => a.entity === 'KR'))}
          cnAccounts={plain(accounts.filter((a) => a.entity === 'CN'))}
        />
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">이동 이력</h2>
          <span className="text-xs text-ink-muted">{live.length}건</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-36">번호</th>
                <th className="w-24">일자</th>
                <th className="w-28 n">USD</th>
                <th className="w-28 n">KRW</th>
                <th className="w-32 n">CNY 도착</th>
                <th className="w-24 n">USD/CNY</th>
                <th className="w-28">목적</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-sm text-ink-muted">등록된 자금이동이 없습니다.</td></tr>
              )}
              {transfers.map((t) => (
                <tr key={t.id.toString()} className={t.isVoid ? 'text-ink-muted line-through' : ''}>
                  <td className="num text-xs">{t.transferNo}</td>
                  <td className="num text-xs">{fmtDate(t.transferDate)}</td>
                  <td className="n text-xs">{t.usdAmount ? fmtCny(t.usdAmount) : '—'}</td>
                  <td className="n text-xs">{t.krwAmount ? fmtKrw(t.krwAmount) : '—'}</td>
                  <td className="n text-xs">{t.cnyArrivalAmount ? fmtCny(t.cnyArrivalAmount) : '—'}</td>
                  <td className="n text-xs text-ink-muted">{t.fxRateUsdCny ? fmtRate(t.fxRateUsdCny) : '—'}</td>
                  <td className="text-xs">{t.purpose ?? '—'}</td>
                  <td className="text-xs text-ink-muted">{t.memo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
            {live.length > 0 && (
              <tfoot>
                <tr className="bg-sunken font-semibold">
                  <td colSpan={2} className="text-xs">합계</td>
                  <td className="n text-xs">{fmtCny(totalUsd)}</td>
                  <td className="n text-xs">—</td>
                  <td className="n text-xs">{fmtCny(totalCny)}</td>
                  <td className="n text-xs">{avgRate ? fmtRate(avgRate) : '—'}</td>
                  <td colSpan={2} className="text-[11px] font-normal text-ink-muted">
                    거래액·매출에 포함되지 않습니다
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  )
}
