'use server'

import { revalidate } from '@/lib/revalidate'
import { redirect } from 'next/navigation'
import { Prisma, InvoiceStatus, AuditAction, type VatMode } from '@prisma/client'
import { prisma } from '@/lib/db'
import { lockOrders } from '@/lib/deposit'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, logAction, AuditReasonRequiredError } from '@/lib/audit'
import { nextDocNo } from '@/lib/numbering'
import { draftInvoice, recompute } from '@/lib/invoice-calc'
import { allocateProportional } from '@/lib/allocate'
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
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 세금계산서 한 장에 묶으려면 세무 규칙이 같아야 하는 항목들 */
type BillableOrder = {
  orderNo: string
  partnerId: bigint
  accountingClass: string
  partner: { name: string }
  dealType: {
    name: string
    invoiceBase: string
    vatMode: string
    vatRate: Prisma.Decimal
    rounding: string
  }
}

/**
 * 서로 다른 세무 규칙을 한 장에 묶으면 부가세 계산이 섞여 금액이 틀린다.
 * 어느 주문이 어떻게 다른지 그대로 알려 준다 — 「묶을 수 없습니다」 만으로는 고칠 수가 없다.
 */
function findRuleMismatch(orders: BillableOrder[]): string | null {
  if (orders.length <= 1) return null
  const head = orders[0]

  const rules: { label: string; of: (o: BillableOrder) => string }[] = [
    { label: '거래처', of: (o) => o.partner.name },
    { label: '발행 기준', of: (o) => o.dealType.invoiceBase },
    { label: '부가세 방식', of: (o) => o.dealType.vatMode },
    { label: '부가세율', of: (o) => o.dealType.vatRate.toString() },
    { label: '끝자리 처리', of: (o) => o.dealType.rounding },
    { label: '회계분류', of: (o) => o.accountingClass },
  ]

  for (const rule of rules) {
    const base = rule.of(head)
    const odd = orders.find((o) => rule.of(o) !== base)
    if (odd) {
      return `${rule.label}가 달라 한 장으로 묶을 수 없습니다 —`
        + ` ${head.orderNo}는 「${base}」, ${odd.orderNo}는 「${rule.of(odd)}」 입니다.`
        + ' 따로 발행하세요.'
    }
  }
  return null
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
  if (orders.length !== orderIds.length) {
    return { error: '선택한 주문 중 찾을 수 없는 것이 있습니다.' }
  }

  const mismatch = findRuleMismatch(orders)
  if (mismatch) return { error: mismatch }

  // 이미 유효한 세금계산서에 들어간 주문은 다시 묶을 수 없다
  const alreadyBilled = await prisma.invoiceOrder.findMany({
    where: { orderId: { in: orderIds }, invoice: { isVoid: false, issueStatus: { not: InvoiceStatus.CANCELLED } } },
    include: { invoice: { select: { invoiceNo: true, issueStatus: true } }, order: { select: { orderNo: true } } },
  })
  if (alreadyBilled.length > 0) {
    const list = alreadyBilled
      .map((x) => `${x.order.orderNo} → ${x.invoice.invoiceNo}`)
      .join(', ')
    return {
      error: `이미 세금계산서에 들어간 주문입니다: ${list}.`
        + ' 기존 계산서를 취소한 뒤 다시 묶으세요.',
    }
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

      // 발행 버튼을 두 번 누르면 두 요청이 모두 「아직 계산서 없음」 을 읽고
      // 각각 한 장씩 만들 수 있다. 주문을 잠그고 트랜잭션 안에서 다시 확인한다.
      await lockOrders(tx, orderIds)
      const dup = await tx.invoiceOrder.findFirst({
        where: {
          orderId: { in: orderIds },
          invoice: { isVoid: false, issueStatus: { not: InvoiceStatus.CANCELLED } },
        },
        include: { invoice: { select: { invoiceNo: true } }, order: { select: { orderNo: true } } },
      })
      if (dup) {
        throw new Error(
          `${dup.order.orderNo} 은 이미 ${dup.invoice.invoiceNo} 에 들어가 있습니다.`
          + ' 화면을 새로 고쳐 확인해 주세요.',
        )
      }

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

      // 주문별 금액은 N등분이 아니라 각 주문의 실제 발행 대상금액 비율대로 나눈다.
      // 균등분할하면 큰 주문과 작은 주문이 같은 금액으로 잡혀 주문별 매출이 틀어진다.
      const weights = await Promise.all(orders.map(async (o) => {
        const d = await draftInvoice([o.id])
        return { item: o, weight: d?.targetAmount ?? new Prisma.Decimal(0) }
      }))
      const shares = allocateProportional(target, weights, 0)

      for (const { item: o, amount } of shares) {
        await tx.invoiceOrder.create({
          data: { invoiceId: inv.id, orderId: o.id, amount },
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

  revalidate('/invoices')
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

  revalidate('/invoices')
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
    // 주문에 다른 살아있는 계산서가 있으면 그 상태를 따라간다.
    // 무조건 NONE 으로 되돌리면 아직 발행된 계산서가 있는데도 미발행으로 보인다.
    for (const io of inv.orders) {
      const other = await tx.invoiceOrder.findFirst({
        where: {
          orderId: io.orderId,
          invoiceId: { not: id },
          invoice: { isVoid: false, issueStatus: { not: InvoiceStatus.CANCELLED } },
        },
        include: { invoice: { select: { issueStatus: true, invoiceNo: true } } },
        orderBy: { invoiceId: 'desc' },
      })
      const next = other ? other.invoice.issueStatus : InvoiceStatus.NONE
      await tx.order.update({ where: { id: io.orderId }, data: { invoiceStatus: next } })
      if (other) {
        await logAction(tx, 'orders', io.orderId, AuditAction.UPDATE, ctx, {
          field: 'invoiceStatus',
          oldValue: inv.issueStatus,
          newValue: `${next} — 다른 세금계산서 ${other.invoice.invoiceNo} 가 살아 있어 그 상태를 따릅니다`,
        })
      }
    }
    await logAction(tx, 'invoices', id, AuditAction.VOID, ctx, {
      field: 'issueStatus', oldValue: inv.issueStatus, newValue: 'CANCELLED',
    })
  })

  revalidate('/invoices')
  return { ok: '세금계산서를 취소했습니다.' }
}
