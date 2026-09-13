import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtCny, fmtKrw, D } from '@/lib/money'
import { plain } from '@/lib/serialize'
import PayrollBoard from './PayrollBoard'

export const dynamic = 'force-dynamic'

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>
}) {
  await requirePermission('payroll.view')
  const sp = await searchParams
  const ym = /^\d{4}-\d{2}$/.test(sp.ym ?? '') ? sp.ym! : thisMonth()

  const [employees, payrolls, months] = await Promise.all([
    prisma.employee.findMany({ orderBy: [{ isActive: 'desc' }, { empCode: 'asc' }] }),
    prisma.payroll.findMany({
      where: { yearMonth: ym },
      include: { employee: { select: { name: true, nameCn: true } } },
    }),
    prisma.payroll.groupBy({ by: ['yearMonth'], orderBy: { yearMonth: 'desc' }, take: 24 }),
  ])

  const totals = payrolls.reduce(
    (acc, p) => ({
      base: acc.base.plus(p.baseSalary),
      actual: acc.actual.plus(p.actualPaid),
      insurance: acc.insurance.plus(p.insuranceCompany),
    }),
    { base: D(0), actual: D(0), insurance: D(0) },
  )

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="section-title text-xl">중국 직원 급여</h1>
        <p className="mt-1 text-sm text-ink-muted">
          급여를 확정하면 지출 전표가 자동으로 만들어져 중국 운영비에 집계됩니다.
        </p>
      </header>

      <div className="card border-gold bg-gold-soft">
        <div className="card-body text-sm leading-relaxed text-ink-2">
          <p className="font-medium text-gold">집계는 실지급액 기준입니다</p>
          <p className="mt-1.5">
            기존 엑셀은 합계를 <strong>기본급(111,450)</strong>으로 내고 있었는데 실지급 합계는
            116,300이었습니다. 4,850 CNY 차이입니다. 이 프로그램은 실제로 나간 돈인
            <strong> 실지급액</strong>으로 집계합니다. 그리고 <strong>귀속월이 필수</strong>라
            1월과 9월 데이터가 섞이지 않습니다.
          </p>
        </div>
      </div>

      <PayrollBoard
        yearMonth={ym}
        months={months.map((m) => m.yearMonth)}
        employees={plain(employees)}
        payrolls={plain(payrolls)}
        totals={{
          base: totals.base.toString(),
          actual: totals.actual.toString(),
          insurance: totals.insurance.toString(),
          diff: totals.actual.minus(totals.base).toString(),
        }}
      />
    </div>
  )
}
