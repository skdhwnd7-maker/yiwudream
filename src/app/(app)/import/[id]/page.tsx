import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ImportStatus } from '@prisma/client'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtDateTime } from '@/lib/serialize'
import { readWorkbook } from '@/lib/excel/read'
import {
  buildPlan, ISSUE_SUMMARY, SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS,
  type ImportPlan, type PlanIssue,
} from '@/lib/excel/plan'
import { readUpload, hasUpload } from '../storage'
import RunForm from '../RunForm'
import UndoForm from '../UndoForm'
import OptionsForm from './OptionsForm'
import IssueList from './IssueList'

export const dynamic = 'force-dynamic'

const KNOWN = [SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS]

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-lg ${tone}`}>{value}</div>
    </div>
  )
}

export default async function ImportBatchPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('settings.manage')
  const { id } = await params
  const sp = await searchParams

  let batchId: bigint
  try { batchId = BigInt(id) } catch { notFound() }

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } })
  if (!batch) notFound()

  const committed = batch.status === ImportStatus.COMMITTED
  const rolledBack = batch.status === ImportStatus.ROLLED_BACK
  const summary = (batch.summary ?? null) as Record<string, unknown> | null

  const fileExists = await hasUpload(batchId)

  // ── 이미 가져온 배치: 결과만 보여 준다
  if (committed || rolledBack) {
    const totals = (summary?.totals ?? []) as {
      label: string; rows: { item: string; excel: string; system: string }[]; note?: string
    }[]
    const n = (k: string) => Number(summary?.[k] ?? 0).toLocaleString('ko-KR')
    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="section-title text-xl">{batch.fileName}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {committed ? '가져오기를 마쳤습니다.' : '되돌린 배치입니다. 만들어졌던 자료는 지워졌습니다.'}
              {' '}{fmtDateTime(batch.committedAt ?? batch.uploadedAt)}
            </p>
          </div>
          <Link href="/import" className="btn-ghost no-underline">목록으로</Link>
        </header>

        {committed && (
          <>
            <div className="card">
              <div className="card-body grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <Stat label="거래처" value={n('partners')} />
                <Stat label="주문" value={n('orders')} />
                <Stat label="입금" value={n('receipts')} />
                <Stat label="지출" value={n('expenses')} />
                <Stat label="세금계산서" value={n('invoices')} />
                <Stat label="내부 자금이동" value={n('transfers')} />
                <Stat label="직원" value={n('employees')} />
                <Stat label="급여" value={n('payrolls')} />
                <Stat label="중국 운영비" value={n('opExpenses')} />
                <Stat label="넣지 못한 건" value={n('skippedOrders')}
                  tone={Number(summary?.skippedOrders ?? 0) > 0 ? 'text-clay' : ''} />
              </div>
            </div>

            <div className="card border-gold bg-gold-soft">
              <div className="card-body space-y-2 text-sm leading-relaxed text-ink-2">
                <p className="font-semibold">가져오기 다음에 꼭 하실 일</p>
                <p>
                  ① <Link href="/settings/accounts" className="underline">계좌 기초잔액</Link>을 넣어 주세요.
                  엑셀에는 한국에서 중국으로 보낸 송금 기록이 없어서, 지금 통장 잔액이 실제보다 크게 잡혀 있습니다.
                </p>
                <p>
                  ② <Link href="/partners/merge" className="underline">거래처 병합 후보</Link>를 확인해 주세요.
                  띄어쓰기만 다른 이름은 자동으로 합치지 않았습니다.
                </p>
                <p>
                  ③ <Link href="/funds" className="underline">자금현황의 「받을 돈」</Link>을 확인해 주세요.
                  입금 없이 지출만 있던 행들을 거래처별로 한 주문에 묶어 두었습니다.
                </p>
                <p>
                  ④ <Link href="/invoices" className="underline">세금계산서 · 미발행 부가세 수취</Link> 목록을
                  세무사님과 확인해 주세요. 프로그램은 세무 판단을 하지 않습니다.
                </p>
              </div>
            </div>

            {totals.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h2 className="text-sm font-semibold">대조표 — 엑셀 vs 시스템</h2>
                </div>
                <div className="card-body space-y-4">
                  {totals.map((t) => (
                    <ReconTable key={t.label} label={t.label} rows={t.rows} note={t.note} />
                  ))}
                </div>
              </div>
            )}

            <UndoForm batchId={batch.id.toString()} />
          </>
        )}
      </div>
    )
  }

  // ── 아직 안 가져온 배치: 미리보기
  if (!fileExists) {
    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <h1 className="section-title text-xl">{batch.fileName}</h1>
        <div className="card border-clay">
          <div className="card-body text-sm text-ink-2">
            올려 둔 파일을 찾지 못했습니다. 파일을 다시 올려 주세요.
          </div>
        </div>
        <Link href="/import" className="btn-ghost no-underline">목록으로</Link>
      </div>
    )
  }

  const bytes = await readUpload(batchId)
  const wb = await readWorkbook(bytes)

  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined
  const many = (k: string) => {
    const v = sp[k]
    return v === undefined ? undefined : Array.isArray(v) ? v : [v]
  }

  const detected = wb.sheets.map((s) => ({
    name: s.name, rows: s.rows.length, known: KNOWN.includes(s.name),
  }))
  const chosen = many('sheets')
    ?? detected.filter((s) => s.known && s.rows > 0).map((s) => s.name)
  const opsBaseYear = Number(one('opsBaseYear') ?? new Date().getFullYear() - 1)
  const payrollYm = one('payrollYm') ?? ''
  const cnyDisplayRate = one('cnyDisplayRate') ?? ''
  const previewed = one('preview') === '1'

  let plan: ImportPlan | null = null
  if (previewed) {
    plan = buildPlan(wb, { sheets: chosen, opsBaseYear, payrollYm, cnyDisplayRate })
  }

  const blocked = plan
    ? plan.orders.filter((o) => o.status === 'ERROR' || o.status === 'HOLD')
    : []

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">{batch.fileName}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            아직 아무것도 들어가지 않았습니다. 확인하신 뒤 실행하십시오.
          </p>
        </div>
        <Link href="/import" className="btn-ghost no-underline">목록으로</Link>
      </header>

      <OptionsForm
        batchId={batch.id.toString()}
        sheets={detected}
        chosen={chosen}
        opsBaseYear={opsBaseYear}
        payrollYm={payrollYm}
        cnyDisplayRate={cnyDisplayRate}
      />

      {plan && (
        <>
          <div className="card">
            <div className="card-head">
              <h2 className="text-sm font-semibold">검증 결과</h2>
              <span className="text-xs text-ink-muted">
                주문 {plan.orders.length.toLocaleString('ko-KR')}건 ·
                거래처 {plan.partners.length}곳
              </span>
            </div>
            <div className="card-body grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="정상" value={plan.counts.ok.toLocaleString('ko-KR')} tone="text-jade" />
              <Stat label="경고 (넣습니다)" value={plan.counts.warn.toLocaleString('ko-KR')} tone="text-gold" />
              <Stat label="오류 (안 넣습니다)" value={plan.counts.error.toLocaleString('ko-KR')} tone="text-clay" />
              <Stat label="보류 (안 넣습니다)" value={plan.counts.hold.toLocaleString('ko-KR')} tone="text-clay" />
              <Stat label="건너뛴 행" value={plan.counts.skip.toLocaleString('ko-KR')} />
            </div>
            {plan.transfers.length > 0 && (
              <div className="card-foot text-xs text-ink-3">
                「{'이우드림'}」 {plan.transfers.length}건은 매출이 아니라 내부 자금이동으로 넣습니다.
                거래액·마진·거래처 순위 어디에도 잡히지 않습니다.
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2 className="text-sm font-semibold">대조표 — 엑셀 vs 시스템</h2>
            </div>
            <div className="card-body space-y-4">
              {plan.totals.map((t) => (
                <ReconTable key={t.label} label={t.label} rows={t.rows} note={t.note} />
              ))}
              <p className="hint">
                마진과 마진율은 가져오지 않습니다. 엑셀은 마진율을 지출금액으로 나눠 계산해서
                매출 대비 마진율과 값이 다릅니다. 시스템은 두 가지를 모두 다시 계산해 보여 드립니다.
              </p>
            </div>
          </div>

          <IssueList plan={serializePlan(plan)} />

          {blocked.length > 0 && (
            <div className="card border-clay">
              <div className="card-head">
                <h2 className="text-sm font-semibold text-clay">
                  고쳐야 넣을 수 있는 {blocked.length}건
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th className="w-24">시트</th>
                      <th className="w-16 text-right">행</th>
                      <th className="w-32">거래처</th>
                      <th>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocked.slice(0, 50).map((o) => (
                      <tr key={`${o.sheet}-${o.rowIndex}`}>
                        <td className="text-xs">{o.sheet}</td>
                        <td className="text-right font-mono text-xs">{o.rowIndex}</td>
                        <td className="text-xs">{o.partnerRaw}</td>
                        <td className="text-xs leading-relaxed text-ink-2">
                          {o.issues
                            .filter((i: PlanIssue) => i.level === 'ERROR' || i.level === 'HOLD')
                            .map((i: PlanIssue) => i.message).join(' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {blocked.length > 50 && (
                <div className="card-foot text-xs text-ink-muted">
                  … 외 {blocked.length - 50}건. 전부 원본 그대로 보관하므로 나중에 다시 넣을 수 있습니다.
                </div>
              )}
            </div>
          )}

          {plan.mergeCandidates.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2 className="text-sm font-semibold">
                  이름이 비슷한 거래처 {plan.mergeCandidates.length}그룹
                </h2>
              </div>
              <div className="card-body space-y-1.5 text-sm">
                {plan.mergeCandidates.map((m) => (
                  <div key={m.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-xs text-ink-muted">{m.key}</span>
                    {m.variants.map((v) => (
                      <span key={v.raw} className="pill-neutral">{v.raw} {v.count}</span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="card-foot text-xs text-ink-3">
                자동으로 합치지 않습니다. 가져온 뒤{' '}
                <Link href="/partners/merge" className="underline">거래처 병합</Link> 화면에서
                하나씩 확인하고 합치십시오. 원래 이름은 별칭으로 남습니다.
              </div>
            </div>
          )}

          {plan.skipped.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2 className="text-sm font-semibold">가져오지 않는 시트·행</h2>
              </div>
              <div className="card-body space-y-1 text-sm text-ink-2">
                {plan.skipped.map((s, i) => (
                  <div key={i}>
                    <span className="font-medium">{s.sheet}</span>{' '}
                    <span className="font-mono text-xs">{s.rowCount}행</span>{' '}
                    <span className="text-ink-muted">— {s.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <RunForm
            batchId={batch.id.toString()}
            sheets={chosen}
            opsBaseYear={opsBaseYear}
            payrollYm={payrollYm}
            cnyDisplayRate={cnyDisplayRate}
            blocked={blocked.length}
          />
        </>
      )}
    </div>
  )
}

function ReconTable({
  label, rows, note,
}: {
  label: string
  rows: { item: string; excel: string; system: string }[]
  note?: string
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{label}</h3>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>항목</th>
              <th className="text-right">엑셀</th>
              <th className="text-right">시스템</th>
              <th className="w-20 text-center">일치</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = Number(r.excel), sysv = Number(r.system)
              const comparable = Number.isFinite(e) && Number.isFinite(sysv)
              const diff = comparable ? Math.abs(e - sysv) : null
              return (
                <tr key={r.item}>
                  <td className="text-sm">{r.item}</td>
                  <td className="text-right font-mono text-xs">{r.excel}</td>
                  <td className="text-right font-mono text-xs">{r.system}</td>
                  <td className="text-center text-xs">
                    {diff === null ? <span className="text-ink-muted">—</span>
                      : diff === 0 ? <span className="text-jade">✓</span>
                        /* 원 단위 미만 차이는 행마다 2자리로 맞추며 생긴 반올림이다 */
                        : diff < 1 ? <span className="text-ink-muted" title={`차이 ${diff.toFixed(2)}`}>반올림</span>
                          : <span className="text-gold">차이</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="hint mt-1.5">{note}</p>}
    </div>
  )
}

/** Decimal 은 클라이언트로 못 넘어간다. 화면에 쓸 만큼만 문자열로 바꾼다 */
function serializePlan(plan: ImportPlan) {
  const byCode = new Map<string, { level: string; message: string; rows: string[]; count: number }>()
  const push = (sheet: string, rowIndex: number, i: PlanIssue) => {
    const e = byCode.get(i.code) ?? { level: i.level, message: i.message, rows: [], count: 0 }
    e.count++
    // 행별 메시지에는 그 행의 날짜·금액이 들어 있다. 여러 건을 묶을 때는 일반 설명을 쓴다
    if (e.count > 1) e.message = ISSUE_SUMMARY[i.code] ?? e.message
    if (e.rows.length < 12) e.rows.push(`${sheet} ${rowIndex}행`)
    byCode.set(i.code, e)
  }
  for (const o of plan.orders) for (const i of o.issues) push(o.sheet, o.rowIndex, i)
  for (const t of plan.transfers) for (const i of t.issues) push('해외송금', t.rowIndex, i)
  for (const e of plan.employees) for (const i of e.issues) push('Sheet1', e.rowIndex, i)
  for (const e of plan.opExpenses) for (const i of e.issues) push('Sheet1', e.rowIndex, i)

  return [...byCode.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.count - a.count)
}
