'use server'

import { Prisma, VatPeriodStatus, AuditAction, Entity, Currency, PaymentStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { revalidate } from '@/lib/revalidate'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, logAction } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'

export type ActionState = { error?: string; ok?: string }

const dec = (v: FormDataEntryValue | null): Prisma.Decimal => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  if (!s || !Number.isFinite(Number(s))) return new Prisma.Decimal(0)
  return new Prisma.Decimal(s)
}
const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 신고기간을 저장한다.
 *
 * 금액은 세무사님이 주신 신고서 값을 그대로 받는다.
 * 프로그램이 신고할 금액을 계산해 주지 않는다 — 그건 세무 판단이다.
 * 대신 시스템이 받은 부가세와 얼마나 다른지는 화면에서 보여 준다.
 */
export async function saveVatPeriod(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const idRaw = String(formData.get('id') ?? '')
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  const label = String(formData.get('label') ?? '').trim()
  const periodFrom = dateOrNull(formData.get('periodFrom'))
  const periodTo = dateOrNull(formData.get('periodTo'))
  const salesVat = dec(formData.get('salesVat'))
  const purchaseVat = dec(formData.get('purchaseVat'))
  const memo = String(formData.get('memo') ?? '').trim() || null
  const reason = String(formData.get('reason') ?? '').trim() || undefined

  if (!code || !label) return { error: '기간 코드와 이름을 입력하세요.' }
  if (!periodFrom || !periodTo) return { error: '기간 시작일과 종료일을 입력하세요.' }
  if (periodFrom > periodTo) return { error: '시작일이 종료일보다 뒤입니다.' }

  // 기간이 겹치면 어느 쪽에 속하는지 알 수 없다
  const overlap = await prisma.vatPeriod.findFirst({
    where: {
      ...(idRaw ? { id: { not: BigInt(idRaw) } } : {}),
      periodFrom: { lte: periodTo },
      periodTo: { gte: periodFrom },
    },
  })
  if (overlap) {
    return {
      error: `${overlap.label} (${overlap.periodFrom.toISOString().slice(0, 10)}`
        + ` ~ ${overlap.periodTo.toISOString().slice(0, 10)}) 와 기간이 겹칩니다.`,
    }
  }

  const data = { code, label, periodFrom, periodTo, salesVat, purchaseVat, memo }

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.vatPeriod.findUnique({ where: { id } })
      if (!before) return { error: '신고기간을 찾을 수 없습니다.' }
      if (before.status === VatPeriodStatus.PAID) {
        return { error: '이미 납부 처리한 기간입니다. 고치려면 납부를 먼저 취소하세요.' }
      }
      await prisma.$transaction(async (tx) => {
        const ctx = await auditContext(user, reason)
        await logUpdate(tx, 'vat_periods', id,
          {
            label: before.label, periodFrom: before.periodFrom, periodTo: before.periodTo,
            salesVat: before.salesVat, purchaseVat: before.purchaseVat, memo: before.memo,
          },
          data, ctx)
        await tx.vatPeriod.update({ where: { id }, data: { ...data, updatedBy: BigInt(user.id) } })
      })
    } else {
      await prisma.$transaction(async (tx) => {
        const created = await tx.vatPeriod.create({ data: { ...data, createdBy: BigInt(user.id) } })
        await logCreate(tx, 'vat_periods', created.id, {
          code, label,
          기간: `${periodFrom.toISOString().slice(0, 10)} ~ ${periodTo.toISOString().slice(0, 10)}`,
          매출세액: salesVat.toString(), 매입세액: purchaseVat.toString(),
        }, await auditContext(user))
      })
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/invoices/vat', '/funds', '/')
  return { ok: '신고기간을 저장했습니다.' }
}

/** 신고 확정 — 이 순간부터 그 기간 부가세는 예수금에서 빠진다 */
export async function fileVatPeriod(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const id = BigInt(String(formData.get('id') ?? '0'))
  const p = await prisma.vatPeriod.findUnique({ where: { id } })
  if (!p) return { error: '신고기간을 찾을 수 없습니다.' }
  if (p.status !== VatPeriodStatus.OPEN) return { error: '이미 신고 처리한 기간입니다.' }
  if (p.salesVat.lte(0) && p.purchaseVat.lte(0)) {
    return { error: '신고서 금액을 먼저 넣어 주세요. 매출세액과 매입세액이 모두 0입니다.' }
  }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, '부가세 신고 확정')
    await tx.vatPeriod.update({
      where: { id }, data: { status: VatPeriodStatus.FILED, updatedBy: BigInt(user.id) },
    })
    await logAction(tx, 'vat_periods', id, AuditAction.UPDATE, ctx, {
      field: 'status', oldValue: 'OPEN',
      newValue: `FILED (매출세액 ${p.salesVat}, 매입세액 ${p.purchaseVat})`,
    })
  })

  revalidate('/invoices/vat', '/funds', '/')
  return {
    ok: '신고 확정했습니다. 이 기간까지 받은 부가세는 예수금에서 빠지고,'
      + ' 신고한 납부예정액만 남습니다.',
  }
}

/** 납부 처리 — 지출 전표가 따라 생긴다 */
export async function payVatPeriod(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const id = BigInt(String(formData.get('id') ?? '0'))
  const paidAt = dateOrNull(formData.get('paidAt'))
  const paidAmount = dec(formData.get('paidAmount'))
  const accountIdRaw = String(formData.get('accountId') ?? '')

  const p = await prisma.vatPeriod.findUnique({ where: { id } })
  if (!p) return { error: '신고기간을 찾을 수 없습니다.' }
  if (p.status !== VatPeriodStatus.FILED) {
    return { error: '신고 확정한 기간만 납부 처리할 수 있습니다.' }
  }
  if (!paidAt) return { error: '납부일을 입력하세요.' }
  if (!paidAmount || paidAmount.isZero()) {
    return { error: '납부액을 입력하세요. 환급이면 음수로 넣으세요.' }
  }
  // 납부든 환급이든 돈이 실제로 오간 통장을 알아야 잔액이 맞는다
  if (!accountIdRaw) return { error: '돈이 오간 계좌를 고르세요.' }
  const account = await prisma.account.findUnique({ where: { id: BigInt(accountIdRaw) } })
  if (!account) return { error: '계좌를 찾을 수 없습니다.' }
  if (account.entity !== Entity.KR || account.currency !== Currency.KRW) {
    return { error: '부가세는 한국법인 원화 계좌로만 주고받습니다.' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, '부가세 납부')
      let expenseId: bigint | null = null

      // 납부(양수)는 통장에서 나가고, 환급(음수)은 통장으로 들어온다.
      // 둘 다 같은 전표로 남긴다 — 금액 부호가 방향이다.
      // 환급을 전표 없이 두면 실제로 받은 돈이 통장잔액에 영영 안 잡힌다.
      const cat = await tx.expenseCategory.findFirst({ where: { code: 'VAT_PAYMENT' } })
      if (!cat) throw new Error('부가세 납부 비용분류(VAT_PAYMENT)가 없습니다.')
      const e = await tx.expense.create({
        data: {
          expenseNo: await nextDocNo(tx, 'EX', paidAt),
          entity: Entity.KR, expenseDate: paidAt, categoryId: cat.id,
          accountId: account.id,
          currency: Currency.KRW, amount: paidAmount, amountKrw: paidAmount,
          paymentStatus: PaymentStatus.PAID, paidAt,
          memo: paidAmount.gt(0)
            ? `${p.label} 부가세 납부`
            : `${p.label} 부가세 환급 수령`,
          createdBy: BigInt(user.id),
        },
      })
      expenseId = e.id

      await tx.vatPeriod.update({
        where: { id },
        data: {
          status: VatPeriodStatus.PAID, paidAt, paidAmount, expenseId,
          updatedBy: BigInt(user.id),
        },
      })
      await logAction(tx, 'vat_periods', id, AuditAction.UPDATE, ctx, {
        field: 'status', oldValue: 'FILED',
        newValue: `PAID (${paidAmount} · ${paidAt.toISOString().slice(0, 10)})`,
      })
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/invoices/vat', '/funds', '/')
  return { ok: '납부 처리했습니다.' }
}

/** 되돌리기 — 잘못 확정했을 때 */
export async function reopenVatPeriod(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const id = BigInt(String(formData.get('id') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '되돌리는 이유를 적어 주세요. 변경이력에 남습니다.' }

  const p = await prisma.vatPeriod.findUnique({ where: { id } })
  if (!p) return { error: '신고기간을 찾을 수 없습니다.' }
  if (p.status === VatPeriodStatus.OPEN) return { error: '이미 진행중 상태입니다.' }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    // 납부 전표도 함께 취소한다 — 내지 않은 돈이 나간 것으로 남으면 안 된다
    if (p.expenseId) {
      await tx.expense.update({
        where: { id: p.expenseId },
        data: {
          isVoid: true, voidReason: `${p.label} 부가세 납부 취소 — ${reason}`,
          voidedBy: BigInt(user.id), voidedAt: new Date(),
        },
      })
    }
    await tx.vatPeriod.update({
      where: { id },
      data: {
        status: VatPeriodStatus.OPEN, paidAt: null, paidAmount: null, expenseId: null,
        updatedBy: BigInt(user.id),
      },
    })
    await logAction(tx, 'vat_periods', id, AuditAction.UPDATE, ctx, {
      field: 'status', oldValue: p.status, newValue: 'OPEN',
    })
  })

  revalidate('/invoices/vat', '/funds', '/')
  return { ok: '진행중으로 되돌렸습니다.' }
}
