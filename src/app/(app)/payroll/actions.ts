'use server'

import { revalidate } from '@/lib/revalidate'
import { Prisma, Entity, Currency, PaymentStatus, AuditAction } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, logAction, AuditReasonRequiredError } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { cnyToKrw } from '@/lib/money'

export type ActionState = { error?: string; ok?: string }

const dec = (v: FormDataEntryValue | null): Prisma.Decimal => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  return new Prisma.Decimal(s && Number.isFinite(Number(s)) ? s : '0')
}
const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

// ── 직원 ─────────────────────────────────────────────────────

export async function saveEmployee(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('payroll.view')
  const idRaw = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const nameCn = String(formData.get('nameCn') ?? '').trim() || null
  const position = String(formData.get('position') ?? '').trim() || null
  const baseSalary = dec(formData.get('baseSalary'))
  const hireDate = dateOrNull(formData.get('hireDate'))
  const memo = String(formData.get('memo') ?? '').trim() || null

  if (!name && !nameCn) return { error: '직원명을 입력하세요.' }
  const displayName = name || nameCn!

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.employee.findUnique({ where: { id } })
      if (!before) return { error: '직원을 찾을 수 없습니다.' }
      await prisma.$transaction(async (tx) => {
        await logUpdate(tx, 'employees', id,
          { name: before.name, nameCn: before.nameCn, position: before.position, baseSalary: before.baseSalary },
          { name: displayName, nameCn, position, baseSalary },
          await auditContext(user))
        await tx.employee.update({
          where: { id },
          data: { name: displayName, nameCn, position, baseSalary, hireDate, memo },
        })
      })
    } else {
      await prisma.$transaction(async (tx) => {
        const count = await tx.employee.count()
        const created = await tx.employee.create({
          data: {
            empCode: `E${String(count + 1).padStart(4, '0')}`,
            name: displayName, nameCn, position, baseSalary, hireDate, memo,
          },
        })
        await logCreate(tx, 'employees', created.id, { name: displayName, nameCn, baseSalary: baseSalary.toString() }, await auditContext(user))
      })
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/payroll')
  return { ok: '저장했습니다.' }
}

export async function toggleEmployeeActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('payroll.view')
  const id = BigInt(String(formData.get('id')))
  const emp = await prisma.employee.findUnique({ where: { id } })
  if (!emp) return { error: '직원을 찾을 수 없습니다.' }

  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'employees', id, { isActive: emp.isActive }, { isActive: !emp.isActive },
      await auditContext(user, '재직 상태 변경'))
    await tx.employee.update({
      where: { id },
      data: { isActive: !emp.isActive, resignDate: emp.isActive ? new Date() : null },
    })
  })
  revalidate('/payroll')
  return { ok: emp.isActive ? '퇴사 처리했습니다.' : '재직으로 되돌렸습니다.' }
}

// ── 급여 ─────────────────────────────────────────────────────

/**
 * 급여 저장.
 *
 * 귀속월이 필수다. 엑셀에서는 월 구분이 없어 1월과 9월 데이터가 섞여 있었다.
 * 집계는 실지급액 기준으로 한다 — 엑셀 합계는 기본급으로 내고 있었고 4,850 CNY 차이가 났다.
 */
export async function savePayroll(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('payroll.view')

  const yearMonth = String(formData.get('yearMonth') ?? '').trim()
  const employeeId = BigInt(String(formData.get('employeeId') ?? '0'))
  const baseSalary = dec(formData.get('baseSalary'))
  const allowance = dec(formData.get('allowance'))
  const deduction = dec(formData.get('deduction'))
  const insuranceCompany = dec(formData.get('insuranceCompany'))
  const insuranceEmployee = dec(formData.get('insuranceEmployee'))
  const actualPaid = dec(formData.get('actualPaid'))
  const fxRate = dec(formData.get('fxRate'))
  const paidAt = dateOrNull(formData.get('paidAt'))
  const memo = String(formData.get('memo') ?? '').trim() || null
  const reason = String(formData.get('reason') ?? '').trim() || undefined

  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return { error: '귀속월을 YYYY-MM 형식으로 입력하세요.' }
  if (!employeeId) return { error: '직원을 선택하세요.' }
  if (actualPaid.lte(0)) return { error: '실지급액을 입력하세요.' }
  if (fxRate.lte(0)) return { error: '원화 환산에 쓸 적용환율을 입력하세요.' }

  const existing = await prisma.payroll.findUnique({
    where: { yearMonth_employeeId: { yearMonth, employeeId } },
  })

  const data = {
    yearMonth, employeeId, baseSalary, allowance, deduction,
    insuranceCompany, insuranceEmployee, actualPaid,
    currency: Currency.CNY, paidAt, memo,
  }

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, reason)
      const payDate = paidAt ?? new Date(`${yearMonth}-01T00:00:00`)

      // 급여를 확정하면 지출 전표가 따라 생긴다.
      // 지출 원장을 하나로 두어야 자금현황·대시보드 집계가 어긋나지 않는다.
      const catSalary = await tx.expenseCategory.findFirstOrThrow({ where: { code: 'SALARY' } })
      const catIns = await tx.expenseCategory.findFirstOrThrow({ where: { code: 'INSURANCE' } })
      const emp = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } })

      if (existing) {
        await logUpdate(tx, 'payrolls', existing.id,
          { baseSalary: existing.baseSalary, actualPaid: existing.actualPaid, insuranceCompany: existing.insuranceCompany },
          { baseSalary, actualPaid, insuranceCompany }, ctx)

        // 급여에서 파생된 전표는 급여·사회보험 둘 다 취소한다.
        // 사회보험 쪽을 빠뜨리면 옛 전표가 살아남아 같은 달 사회보험이 두 번 잡힌다.
        const stale = [existing.expenseId, existing.insuranceExpenseId]
          .filter((x): x is bigint => x !== null)
        for (const expenseId of stale) {
          const before = await tx.expense.findUnique({ where: { id: expenseId } })
          if (!before || before.isVoid) continue
          await tx.expense.update({
            where: { id: expenseId },
            data: {
              isVoid: true, voidReason: `${yearMonth} 급여 재입력`,
              voidedBy: BigInt(user.id), voidedAt: new Date(),
            },
          })
          await logAction(tx, 'expenses', expenseId, AuditAction.VOID, ctx, {
            field: 'isVoid', oldValue: 'false',
            newValue: `true — ${yearMonth} 급여 재입력으로 취소 (${before.expenseNo}, ${before.amount})`,
          })
        }
      }

      const salaryNo = await nextDocNo(tx, 'EX', payDate)
      const salaryExpense = await tx.expense.create({
        data: {
          expenseNo: salaryNo, entity: Entity.CN, expenseDate: payDate, categoryId: catSalary.id,
          vendorName: emp.nameCn ?? emp.name, currency: Currency.CNY, amount: actualPaid,
          fxRate, amountKrw: cnyToKrw(actualPaid, fxRate, 'FLOOR'), amountCny: actualPaid,
          paymentStatus: paidAt ? PaymentStatus.PAID : PaymentStatus.PLANNED, paidAt,
          memo: `${yearMonth} 급여 · ${emp.name}`, createdBy: BigInt(user.id),
        },
      })

      let insuranceExpenseId: bigint | null = null
      if (insuranceCompany.gt(0)) {
        const insNo = await nextDocNo(tx, 'EX', payDate)
        const insExpense = await tx.expense.create({
          data: {
            expenseNo: insNo, entity: Entity.CN, expenseDate: payDate, categoryId: catIns.id,
            vendorName: emp.nameCn ?? emp.name, currency: Currency.CNY, amount: insuranceCompany,
            fxRate, amountKrw: cnyToKrw(insuranceCompany, fxRate, 'FLOOR'), amountCny: insuranceCompany,
            paymentStatus: paidAt ? PaymentStatus.PAID : PaymentStatus.PLANNED, paidAt,
            memo: `${yearMonth} 사회보험(회사부담) · ${emp.name}`, createdBy: BigInt(user.id),
          },
        })
        insuranceExpenseId = insExpense.id
      }

      if (existing) {
        await tx.payroll.update({
          where: { id: existing.id },
          data: {
            ...data, expenseId: salaryExpense.id, insuranceExpenseId,
            updatedBy: BigInt(user.id),
          },
        })
        await logAction(tx, 'payrolls', existing.id, AuditAction.UPDATE, ctx, {
          field: 'expenses',
          oldValue: `급여 ${existing.expenseId ?? '없음'} / 사회보험 ${existing.insuranceExpenseId ?? '없음'}`,
          newValue: `급여 ${salaryExpense.id} / 사회보험 ${insuranceExpenseId ?? '없음'}`,
        })
      } else {
        const created = await tx.payroll.create({
          data: {
            ...data, expenseId: salaryExpense.id, insuranceExpenseId,
            createdBy: BigInt(user.id),
          },
        })
        await logCreate(tx, 'payrolls', created.id, {
          yearMonth, employee: emp.name, actualPaid: actualPaid.toString(),
          insuranceCompany: insuranceCompany.toString(),
        }, ctx)
      }
    })
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/payroll')
  return { ok: `${yearMonth} 급여를 저장했습니다.` }
}
