'use client'

import { useActionState, useState } from 'react'
import { SubmitButton, FormError, FormOk } from '@/components/ui'
import { Field } from '@/components/Field'
import { D, fmtCny } from '@/lib/money'
import { saveEmployee, savePayroll, toggleEmployeeActive, type ActionState } from './actions'

interface Employee {
  id: string; empCode: string; name: string; nameCn: string | null
  position: string | null; baseSalary: string | null; isActive: boolean; memo: string | null
}
interface Payroll {
  id: string; employeeId: string; baseSalary: string; allowance: string; deduction: string
  insuranceCompany: string; insuranceEmployee: string; actualPaid: string
  paidAt: string | null; memo: string | null
  employee: { name: string; nameCn: string | null }
}

export default function PayrollBoard({
  yearMonth, months, employees, payrolls, totals,
}: {
  yearMonth: string
  months: string[]
  employees: Employee[]
  payrolls: Payroll[]
  totals: { base: string; actual: string; insurance: string; diff: string }
}) {
  const [payState, payAction] = useActionState<ActionState, FormData>(savePayroll, {})
  const [empState, empAction] = useActionState<ActionState, FormData>(saveEmployee, {})
  const [toggleState, toggleAction] = useActionState<ActionState, FormData>(toggleEmployeeActive, {})
  const [editing, setEditing] = useState<string | null>(null)
  const [addingEmp, setAddingEmp] = useState(false)

  const payMap = new Map(payrolls.map((p) => [p.employeeId, p]))
  const active = employees.filter((e) => e.isActive)
  const diff = D(totals.diff)

  return (
    <div className="space-y-5">
      <form method="get" className="card">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ym">귀속월</label>
            <input id="ym" name="ym" defaultValue={yearMonth} placeholder="2026-05" className="num w-32" />
          </div>
          {months.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-1">
              {months.slice(0, 8).map((m) => (
                <a key={m} href={`/payroll?ym=${m}`}
                  className={`pill no-underline ${m === yearMonth ? 'pill-good' : 'pill-neutral'}`}>{m}</a>
              ))}
            </div>
          )}
          <button type="submit" className="btn-ghost mb-0.5 whitespace-nowrap">조회</button>
        </div>
      </form>

      <FormError message={payState.error ?? empState.error ?? toggleState.error} />
      <FormOk message={payState.ok ?? empState.ok ?? toggleState.ok} />

      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">{yearMonth} 급여</h2>
          <span className="text-xs text-ink-muted">재직 {active.length}명 · 입력 {payrolls.length}명</span>
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-20">코드</th>
                <th>직원</th>
                <th className="w-24 n">기본급</th>
                <th className="w-24 n">수당</th>
                <th className="w-28 n">사회보험(회사)</th>
                <th className="w-24 n">실지급</th>
                <th className="w-20 n">차액</th>
                <th className="w-24"> </th>
              </tr>
            </thead>
            <tbody>
              {active.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-sm text-ink-muted">
                  등록된 직원이 없습니다. 아래에서 추가하세요.
                </td></tr>
              )}
              {active.map((e) => {
                const p = payMap.get(e.id)
                const d = p ? D(p.actualPaid).minus(D(p.baseSalary)) : D(0)
                const isEditing = editing === e.id
                return (
                  <tr key={e.id} className={isEditing ? 'bg-sunken' : ''}>
                    <td className="num text-xs">{e.empCode}</td>
                    <td className="text-sm">
                      {e.nameCn ?? e.name}
                      {e.position && <p className="text-[11px] text-ink-muted">{e.position}</p>}
                    </td>
                    {p && !isEditing ? (
                      <>
                        <td className="n text-sm">{fmtCny(p.baseSalary)}</td>
                        <td className="n text-sm">{D(p.allowance).gt(0) ? fmtCny(p.allowance) : '—'}</td>
                        <td className="n text-sm">{D(p.insuranceCompany).gt(0) ? fmtCny(p.insuranceCompany) : '—'}</td>
                        <td className="n text-sm font-medium">{fmtCny(p.actualPaid)}</td>
                        <td className={`n text-xs ${d.isZero() ? 'text-ink-muted' : 'text-clay'}`}>
                          {d.isZero() ? '—' : `${d.gt(0) ? '+' : ''}${fmtCny(d)}`}
                        </td>
                      </>
                    ) : !isEditing ? (
                      <td colSpan={5} className="text-sm text-ink-muted">입력 전</td>
                    ) : null}
                    {!isEditing && (
                      <td>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(e.id)}>
                          {p ? '수정' : '입력'}
                        </button>
                      </td>
                    )}
                    {isEditing && (
                      <td colSpan={6} className="p-0">
                        <form action={payAction} className="space-y-3 px-3 py-3">
                          <input type="hidden" name="yearMonth" value={yearMonth} />
                          <input type="hidden" name="employeeId" value={e.id} />
                          <div className="grid gap-3 md:grid-cols-4">
                            <Field label="기본급" name="baseSalary">
                              <input name="baseSalary" inputMode="decimal" className="num"
                                defaultValue={p?.baseSalary ?? e.baseSalary ?? ''} />
                            </Field>
                            <Field label="수당" name="allowance">
                              <input name="allowance" inputMode="decimal" className="num" defaultValue={p?.allowance ?? '0'} />
                            </Field>
                            <Field label="공제" name="deduction">
                              <input name="deduction" inputMode="decimal" className="num" defaultValue={p?.deduction ?? '0'} />
                            </Field>
                            <Field label="실지급액" name="actualPaid" required hint="집계 기준">
                              <input name="actualPaid" inputMode="decimal" className="num" required
                                defaultValue={p?.actualPaid ?? e.baseSalary ?? ''} />
                            </Field>
                            <Field label="사회보험 회사부담" name="insuranceCompany">
                              <input name="insuranceCompany" inputMode="decimal" className="num"
                                defaultValue={p?.insuranceCompany ?? '0'} />
                            </Field>
                            <Field label="사회보험 본인부담" name="insuranceEmployee">
                              <input name="insuranceEmployee" inputMode="decimal" className="num"
                                defaultValue={p?.insuranceEmployee ?? '0'} />
                            </Field>
                            <Field label="적용환율" name="fxRate" required hint="원화 환산용">
                              <input name="fxRate" inputMode="decimal" className="num" required placeholder="218.00" />
                            </Field>
                            <Field label="지급일" name="paidAt">
                              <input name="paidAt" type="date" defaultValue={p?.paidAt?.slice(0, 10) ?? ''} />
                            </Field>
                            <Field label="메모" name="memo" className="md:col-span-3">
                              <input name="memo" defaultValue={p?.memo ?? ''} />
                            </Field>
                            {p && (
                              <Field label="변경 사유" name="reason">
                                <input name="reason" placeholder="재입력 사유" />
                              </Field>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <SubmitButton>저장</SubmitButton>
                            <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>취소</button>
                          </div>
                        </form>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
            {payrolls.length > 0 && (
              <tfoot>
                <tr className="bg-sunken font-semibold">
                  <td colSpan={2} className="text-xs">합계</td>
                  <td className="n text-sm">{fmtCny(totals.base)}</td>
                  <td className="n text-sm">—</td>
                  <td className="n text-sm">{fmtCny(totals.insurance)}</td>
                  <td className="n text-sm text-jade">{fmtCny(totals.actual)}</td>
                  <td className={`n text-xs ${diff.isZero() ? '' : 'text-clay'}`}>
                    {diff.isZero() ? '—' : `${diff.gt(0) ? '+' : ''}${fmtCny(diff)}`}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!diff.isZero() && (
          <p className="border-t border-line px-5 py-2 text-xs text-clay">
            기본급 합계와 실지급 합계가 {fmtCny(diff.abs())} CNY 다릅니다.
            집계에는 <strong>실지급액</strong>을 씁니다.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">직원 명단</h2>
          {!addingEmp && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setAddingEmp(true)}>+ 직원 추가</button>
          )}
        </div>
        {addingEmp && (
          <form action={empAction} className="border-b border-line px-5 py-4">
            <div className="grid gap-3 md:grid-cols-5">
              <Field label="이름" name="name"><input name="name" /></Field>
              <Field label="중국어 이름" name="nameCn"><input name="nameCn" placeholder="沈丹凤" /></Field>
              <Field label="직책" name="position"><input name="position" /></Field>
              <Field label="기본급 (CNY)" name="baseSalary">
                <input name="baseSalary" inputMode="decimal" className="num" />
              </Field>
              <Field label="입사일" name="hireDate"><input name="hireDate" type="date" /></Field>
            </div>
            <div className="mt-3 flex gap-2">
              <SubmitButton>등록</SubmitButton>
              <button type="button" className="btn-ghost" onClick={() => setAddingEmp(false)}>취소</button>
            </div>
          </form>
        )}
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th className="w-20">코드</th>
                <th>이름</th>
                <th className="w-32">중국어 이름</th>
                <th className="w-28">직책</th>
                <th className="w-28 n">기본급</th>
                <th className="w-20">상태</th>
                <th className="w-20"> </th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-sm text-ink-muted">직원이 없습니다.</td></tr>
              )}
              {employees.map((e) => (
                <tr key={e.id} className={e.isActive ? '' : 'text-ink-muted'}>
                  <td className="num text-xs">{e.empCode}</td>
                  <td className="text-sm">{e.name}</td>
                  <td className="text-sm">{e.nameCn ?? '—'}</td>
                  <td className="text-xs">{e.position ?? '—'}</td>
                  <td className="n text-sm">{e.baseSalary ? fmtCny(e.baseSalary) : '—'}</td>
                  <td className="text-xs">
                    {e.isActive ? <span className="pill-good">재직</span> : <span className="pill-warn">퇴사</span>}
                  </td>
                  <td>
                    <form action={toggleAction}>
                      <input type="hidden" name="id" value={e.id} />
                      <SubmitButton className="btn-ghost btn-sm" pendingLabel="…">
                        {e.isActive ? '퇴사' : '복직'}
                      </SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
