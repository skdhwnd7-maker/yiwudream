/**
 * 세금계산서 대상금액 산출.
 *
 * 설계 문서: docs/04-계산공식.md 6장
 * 규칙을 코드에 박지 않는다. deal_types 설정만 읽어 계산한다.
 */
import { Prisma, type InvoiceBase, type VatMode, type Rounding } from '@prisma/client'
import { prisma } from './db'
import { summarizeOrder } from './order-calc'
import { splitVat, D, type RoundingMode } from './money'

export interface InvoiceDraft {
  targetAmount: Prisma.Decimal
  supplyAmount: Prisma.Decimal
  vatAmount: Prisma.Decimal
  totalAmount: Prisma.Decimal
  totalReceiptAmount: Prisma.Decimal
  vatMode: VatMode
  basisLabel: string
  /** 자동 산출이 불가능한 경우 (MANUAL 등) */
  manual: boolean
  /** 부가세를 다시 계산하지 않고 실제 수취액에서 가져왔는가 */
  vatFromCollected: boolean
}

const BASIS_LABEL: Record<InvoiceBase, string> = {
  NONE: '발행 대상 아님',
  TOTAL_RECEIPT: '주문 총입금액',
  FEE_ONLY: '구매대행 수수료',
  CUSTOMS_ONLY: '대행통관비',
  MARGIN: '최종 마진',
  MANUAL: '직접 입력',
}

/**
 * 주문들의 세금계산서 초안을 만든다.
 * 여러 주문을 한 장으로 묶을 수 있으므로 배열을 받는다.
 */
export async function draftInvoice(orderIds: bigint[]): Promise<InvoiceDraft | null> {
  if (orderIds.length === 0) return null

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: { dealType: true },
  })
  if (orders.length === 0) return null

  // 거래유형이 섞이면 규칙이 달라진다. 첫 주문의 유형을 기준으로 하되 화면에서 경고한다.
  const dealType = orders[0].dealType
  const rounding = dealType.rounding as Rounding as RoundingMode

  let target = D(0)
  let collectedVat = D(0)
  let totalReceipt = D(0)
  // 입금에서 뽑은 금액인가(이미 부가세가 분리되어 있다) — 아니면 비용·마진에서 뽑은 금액인가
  let fromReceipts = false

  for (const o of orders) {
    const s = await summarizeOrder(o.id)

    const receipts = await prisma.receipt.aggregate({
      where: { orderId: o.id, isVoid: false },
      _sum: { amountKrw: true },
    })
    totalReceipt = totalReceipt.plus(D(receipts._sum.amountKrw ?? 0))

    switch (dealType.invoiceBase) {
      case 'TOTAL_RECEIPT': {
        // 통장에 찍힌 금액에는 이미 부가세가 들어 있다.
        // 대상금액은 공급가액(SALES+FEE)이고, 부가세는 실제로 받은 금액을 그대로 쓴다.
        fromReceipts = true
        const supply = await prisma.receiptSplit.aggregate({
          where: { splitKind: { in: ['SALES', 'FEE'] }, receipt: { orderId: o.id, isVoid: false } },
          _sum: { amountKrw: true },
        })
        const vat = await prisma.receiptSplit.aggregate({
          where: { splitKind: 'VAT', receipt: { orderId: o.id, isVoid: false } },
          _sum: { amountKrw: true },
        })
        target = target.plus(D(supply._sum.amountKrw ?? 0))
        collectedVat = collectedVat.plus(D(vat._sum.amountKrw ?? 0))
        break
      }
      case 'FEE_ONLY': {
        fromReceipts = true
        const fee = await prisma.receiptSplit.aggregate({
          where: { splitKind: 'FEE', receipt: { orderId: o.id, isVoid: false } },
          _sum: { amountKrw: true },
        })
        const vat = await prisma.receiptSplit.aggregate({
          where: { splitKind: 'VAT', receipt: { orderId: o.id, isVoid: false } },
          _sum: { amountKrw: true },
        })
        target = target.plus(D(fee._sum.amountKrw ?? 0))
        collectedVat = collectedVat.plus(D(vat._sum.amountKrw ?? 0))
        break
      }
      case 'CUSTOMS_ONLY': {
        const customs = await prisma.expenseAllocation.aggregate({
          where: { orderId: o.id, expense: { isVoid: false, category: { code: 'CUSTOMS' } } },
          _sum: { allocKrw: true },
        })
        target = target.plus(D(customs._sum.allocKrw ?? 0))
        break
      }
      case 'MARGIN':
        target = target.plus(o.settlementCurrency === 'KRW' ? s.margin : D(0))
        break
      default:
        break
    }
  }

  const manual = dealType.invoiceBase === 'MANUAL' || dealType.invoiceBase === 'NONE'

  let supply: Prisma.Decimal
  let vat: Prisma.Decimal
  let total: Prisma.Decimal

  if (fromReceipts) {
    // 실제로 주고받은 금액을 그대로 쓴다. 다시 계산해 1원씩 어긋나게 하지 않는다.
    supply = target
    vat = collectedVat
    total = supply.plus(vat)
  } else {
    const r = splitVat(target, dealType.vatMode, dealType.vatRate, rounding)
    supply = r.supply
    vat = r.vat
    total = r.total
  }

  return {
    targetAmount: target,
    supplyAmount: supply,
    vatAmount: vat,
    totalAmount: total,
    totalReceiptAmount: totalReceipt,
    vatMode: dealType.vatMode,
    basisLabel: BASIS_LABEL[dealType.invoiceBase],
    manual,
    /** 부가세를 실제 수취액에서 가져왔는가 */
    vatFromCollected: fromReceipts,
  }
}

/** 이미 정해진 대상금액으로 공급가액·부가세를 다시 계산한다 (담당자가 금액을 고친 경우) */
export function recompute(
  targetAmount: Prisma.Decimal.Value,
  vatMode: VatMode,
  vatRate: Prisma.Decimal.Value,
  rounding: RoundingMode,
) {
  return splitVat(targetAmount, vatMode, vatRate, rounding)
}

/**
 * 부가세는 받았는데 세금계산서를 발행하지 않은 건.
 *
 * 엑셀 분석에서 법인통장 369건 / 92,574,600원이 여기 해당했다.
 * 프로그램은 세무 판단을 하지 않는다. 금액과 목록만 보여준다.
 */
export interface UnbilledVatRow {
  orderId: string
  orderNo: string
  partnerId: string
  partnerName: string
  orderDate: Date
  supplyKrw: Prisma.Decimal
  vatKrw: Prisma.Decimal
  daysOld: number
}

export async function listUnbilledVat(): Promise<UnbilledVatRow[]> {
  const rows = await prisma.receiptSplit.findMany({
    where: {
      splitKind: 'VAT',
      receipt: {
        isVoid: false,
        order: { isVoid: false, invoiceStatus: 'NONE' },
      },
    },
    include: {
      receipt: {
        include: {
          order: { include: { partner: { select: { id: true, name: true } } } },
        },
      },
    },
  })

  const byOrder = new Map<string, UnbilledVatRow>()
  const now = Date.now()

  for (const r of rows) {
    const o = r.receipt.order
    if (!o) continue
    const key = o.id.toString()
    const cur = byOrder.get(key)
    if (cur) {
      cur.vatKrw = cur.vatKrw.plus(r.amountKrw)
    } else {
      byOrder.set(key, {
        orderId: key,
        orderNo: o.orderNo,
        partnerId: o.partner.id.toString(),
        partnerName: o.partner.name,
        orderDate: o.orderDate,
        supplyKrw: D(0),
        vatKrw: D(r.amountKrw),
        daysOld: Math.floor((now - o.orderDate.getTime()) / 86_400_000),
      })
    }
  }

  // 공급가액도 함께 채운다
  for (const [orderId, row] of byOrder) {
    const supply = await prisma.receiptSplit.aggregate({
      where: {
        splitKind: { in: ['SALES', 'FEE'] },
        receipt: { orderId: BigInt(orderId), isVoid: false },
      },
      _sum: { amountKrw: true },
    })
    row.supplyKrw = D(supply._sum.amountKrw ?? 0)
  }

  return [...byOrder.values()].sort((a, b) => b.vatKrw.comparedTo(a.vatKrw))
}
