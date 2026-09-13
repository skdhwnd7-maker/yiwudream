'use client'

import { useState } from 'react'
import { Field } from '@/components/Field'

const KNOWN_HELP: Record<string, string> = {
  해외송금: 'CNY 정산. 「이우드림」 행은 내부 자금이동으로 따로 뺍니다.',
  일반통장: 'KRW 입금. 환율은 D열 수식에서 꺼냅니다 (헤더의 192는 쓰지 않습니다).',
  법인통장: 'C열은 공급가액, M열이 실제 입금액입니다. 부가세를 나눠 기록합니다.',
  Sheet1: '중국 운영비 — 급여·사회보험·임시공·사무실 경비.',
}

export default function OptionsForm({
  batchId, sheets, chosen, opsBaseYear, payrollYm, cnyDisplayRate,
}: {
  batchId: string
  sheets: { name: string; rows: number; known: boolean }[]
  chosen: string[]
  opsBaseYear: number
  payrollYm: string
  cnyDisplayRate: string
}) {
  const [picked, setPicked] = useState<string[]>(chosen)
  const needsOps = picked.includes('Sheet1')

  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]))

  return (
    <form method="GET" action={`/import/${batchId}`} className="card">
      <div className="card-head">
        <h2 className="text-sm font-semibold">2단계 · 가져올 시트와 기준 정하기</h2>
      </div>
      <div className="card-body space-y-4">
        <input type="hidden" name="preview" value="1" />

        <div className="space-y-2">
          {sheets.map((s) => (
            <label
              key={s.name}
              className={`flex items-start gap-3 rounded border px-3 py-2
                ${s.rows === 0 ? 'border-line bg-sunken opacity-60' : 'border-line'}`}
            >
              <input
                type="checkbox" name="sheets" value={s.name}
                checked={picked.includes(s.name)}
                disabled={s.rows === 0}
                onChange={() => toggle(s.name)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="text-sm font-medium">{s.name}</span>
                <span className="ml-2 font-mono text-xs text-ink-muted">{s.rows}행</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">
                  {s.rows === 0 ? '빈 시트입니다.'
                    : KNOWN_HELP[s.name]
                    ?? '다룰 줄 모르는 시트입니다. 켜도 원본만 보관하고 아무것도 만들지 않습니다.'}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="해외송금 원화 환산환율" name="cnyDisplayRate" required
            hint="CNY 1 당 원화. 해외송금은 CNY로 정산하므로 마진 계산에는 쓰지 않습니다. 대시보드에서 원화로 합산해 보여줄 때만 씁니다."
          >
            <input
              id="cnyDisplayRate" name="cnyDisplayRate" inputMode="decimal" required
              defaultValue={cnyDisplayRate} placeholder="218" className="num"
            />
          </Field>

          {needsOps && (
            <>
              <Field
                label="급여 귀속월" name="payrollYm" required
                hint="엑셀은 9月总合 인데 내용은 12~2월이 섞여 있습니다. 어느 달 급여로 잡을지 정해 주세요."
              >
                <input id="payrollYm" name="payrollYm" type="month" required defaultValue={payrollYm} />
              </Field>

              <Field
                label="임시공 기간 기준연도" name="opsBaseYear"
                hint="１２／２８－１／３ 처럼 연도가 없습니다. 시작 월 기준 연도를 넣으시면 해 넘김은 알아서 처리합니다."
              >
                <input id="opsBaseYear" name="opsBaseYear" type="number" min="2000" max="2100"
                  defaultValue={opsBaseYear} className="num" />
              </Field>
            </>
          )}
        </div>

        <button type="submit" className="btn-primary">검증 미리보기</button>
      </div>
    </form>
  )
}
