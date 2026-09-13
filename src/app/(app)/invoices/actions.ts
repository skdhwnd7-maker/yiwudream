'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { Prisma, InvoiceStatus, AuditAction, type VatMode } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, logAction, AuditReasonRequiredError } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { draftInvoice, recompute } from '@/lib/invoice-calc'
import type { RoundingMode } from '@/lib/money'

export type ActionState = { error?: string; ok?: string }

const dec = (v: FormDataEntryValue | null): Prisma.Decimal | null => {
  const s = String(v ?? '').replace(/,/g, '').trim()
  if (!s || !Number.isFinite(Number(s))) return null
  return new Prisma.Decimal(s)
}
const dateOrNull = (v: FormDataEntryValue | null): Date | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function createInvoice(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')

  const orderIds = formData.getAll('orderId').map((v) => BigInt(String(v)))
  if (orderIds.length === 0) return { error: '주문을 최소 한 건 선택하세요.' }

  const manualTarget = dec(formData.get('targetAmount'))
  const targetReason = String(formData.get('targetReason') ?? '').trim()
  const issueDate = dateOrNull(formData.get('issueDate'))
  const ntsNo = String(formData.get('ntsApprovalNo') ?? '').trim() || null
  const memo = String(formData.get('memo') ?? '').trim() || null
  const issueNow = formData.get('issueNow') === 'on'

  const draft = await draftInvoice(orderIds)
  if (!draft) return { error: '세금계산서 초안을 만들 수 없습니다.' }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: { dealType: true, partner: true },
  })
  const partnerIds = new Set(orders.map((o) => o.partnerId.toString()))
  if (partnerIds.size > 1) {
    return { error: '서로 다른 거래처의 주문은 한 장으로 묶을 수 없습니다.' }
  }
  const dealType = orders[0].dealType

  // 담당자가 금액을 고쳤으면 사유를 받는다
  const isManual = !!manualTarget && !manualTarget.equals(draft.targetAmount)
  if (isManual && !targetReason) {
    return { error: '자동 산출값과 다른 금액을 넣으려면 사유가 필요합니다.' }
  }

  const target = manualTarget ?? draft.targetAmount
  if (target.lte(0)) return { error: '발행대상금액이 0입니다. 거래유형 설정을 확인하세요.' }

  // 금액을 고치지 않았고 부가세를 실제로 받은 건이면, 받은 금액을 그대로 쓴다.
  // 다시 계산하면 절사 방향 때문에 통장 금액과 1원씩 어긋난다.
  let supply: Prisma.Decimal, vat: Prisma.Decimal, total: Prisma.Decimal
  if (!isManual && draft.vatFromCollected) {
    supply = draft.supplyAmount
    vat = draft.vatAmount
    total = draft.totalAmount
  } else {
    const r = recompute(target, dealType.vatMode, dealType.vatRate, dealType.rounding as RoundingMode)
    supply = r.supply; vat = r.vat; total = r.total
  }

  let newId = ''
  try {
    await prisma.$transaction(async (tx) => {
      const ctx = await auditContext(user, isManual ? targetReason : undefined)
      const invoiceNo = await nextDocNo(tx, 'TX', issueDate ?? new Date())

      const inv = await tx.invoice.create({
        data: {
          invoiceNo,
          partnerId: orders[0].partnerId,
          dealTypeId: dealType.id,
          accountingClass: orders[0].accountingClass,
          totalReceiptAmount: draft.totalReceiptAmount,
          targetAmount: target,
          targetAmountSource: isManual ? 'MANUAL' : 'AUTO',
          targetAmountReason: isManual ? targetReason : null,
          vatMode: dealType.vatMode,
          supplyAmount: supply, vatAmount: vat, totalAmount: total,
          issueStatus: issueNow ? InvoiceStatus.ISSUED : InvoiceStatus.PENDING,
          issueDate: issueNow ? (issueDate ?? new Date()) : null,
          ntsApprovalNo: ntsNo, memo, createdBy: BigInt(user.id),
        },
      })
      newId = inv.id.toString()

      for (const o of orders) {
        await tx.invoiceOrder.create({
          data: { invoiceId: inv.id, orderId: o.id, amount: target.div(orders.length).toDecimalPlaces(0) },
        })
        await tx.order.update({
          where: { id: o.id },
          data: { invoiceStatus: issueNow ? InvoiceStatus.ISSUED : InvoiceStatus.PENDING },
        })
      }

      await logCreate(tx, 'invoices', inv.id, {
        invoiceNo, partner: orders[0].partner.name,
        basis: draft.basisLabel, target: target.toString(),
        supply: supply.toString(), vat: vat.toString(), total: total.toString(),
        orders: orders.map((o) => o.orderNo).join(', '),
      }, ctx)
    })
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/invoices')
  redirect(`/invoices?created=${newId}`)
}

export async function issueInvoice(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const id = BigInt(String(formData.get('invoiceId') ?? '0'))
  const issueDate = dateOrNull(formData.get('issueDate')) ?? new Date()
  const ntsNo = String(formData.get('ntsApprovalNo') ?? '').trim() || null

  const inv = await prisma.invoice.findUnique({ where: { id }, include: { orders: true } })
  if (!inv) return { error: '세금계산서를 찾을 수 없습니다.' }
  if (inv.issueStatus === InvoiceStatus.ISSUED) return { error: '이미 발행 처리된 건입니다.' }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, '세금계산서 발행 처리')
    await tx.invoice.update({
      where: { id },
      data: {
        issueStatus: InvoiceStatus.ISSUED, issueDate, ntsApprovalNo: ntsNo,
        updatedBy: BigInt(user.id),
      },
    })
    for (const io of inv.orders) {
      await tx.order.update({ where: { id: io.orderId }, data: { invoiceStatus: InvoiceStatus.ISSUED } })
    }
    await logAction(tx, 'invoices', id, AuditAction.UPDATE, ctx, {
      field: 'issueStatus', oldValue: inv.issueStatus, newValue: 'ISSUED',
    })
  })

  revalidatePath('/invoices')
  return { ok: '발행 처리했습니다.' }
}

export async function cancelInvoice(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('invoice.confirm')
  const id = BigInt(String(formData.get('invoiceId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) return { error: '취소 사유를 입력하세요.' }

  const inv = await prisma.invoice.findUnique({ where: { id }, include: { orders: true } })
  if (!inv) return { error: '세금계산서를 찾을 수 없습니다.' }

  await prisma.$transaction(async (tx) => {
    const ctx = await auditContext(user, reason)
    await tx.invoice.update({
      where: { id },
      data: { issueStatus: InvoiceStatus.CANCELLED, isVoid: true, updatedBy: BigInt(user.id) },
    })
    for (const io of inv.orders) {
      await tx.order.update({ where: { id: io.orderId }, data: { invoiceStatus: InvoiceStatus.NONE } })
    }
    await logAction(tx, 'invoices', id, AuditAction.VOID, ctx, {
      field: 'issueStatus', oldValue: inv.issueStatus, newValue: 'CANCELLED',
    })
  })

  revalidatePath('/invoices')
  return { ok: '세금계산서를 취소했습니다.' }
}
