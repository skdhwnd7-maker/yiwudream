/**
 * 예치금 잔액 — 고객 돈이라 절대 마이너스가 되면 안 된다.
 *
 * 설계 문서: docs/04-계산공식.md 3장
 *
 * DB에도 마지막 방어선(003_deposit_guard.sql)이 있지만, 사용자에게는
 * 「얼마가 모자란다」 고 알려 줘야 하므로 애플리케이션에서 먼저 확인한다.
 * 동시에 두 사람이 넣어도 안전하도록 거래처 단위 자문 잠금을 먼저 건다.
 */
import { Prisma, DepositKind } from '@prisma/client'
import { prisma } from './db'
import { D } from './money'

type Tx = Prisma.TransactionClient | typeof prisma

const zero = () => new Prisma.Decimal(0)

/**
 * 이 거래처의 예치금을 건드리는 동안 다른 트랜잭션이 끼어들지 못하게 한다.
 *
 * 잠그지 않으면 두 사람이 동시에 잔액 400,000 을 읽고 각각 300,000 을 빼서
 * 둘 다 통과해 버린다. 트랜잭션이 끝나면 자동으로 풀린다.
 */
/** 예치금 잠금에 쓰는 고정 키. 다른 용도의 자문 잠금과 겹치지 않게 한다 */
const DEPOSIT_LOCK_NS = 4837

export async function lockPartnerDeposit(tx: Tx, partnerId: bigint): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEPOSIT_LOCK_NS}::int, ${Number(partnerId)}::int)`
}

export interface DepositBalance {
  partnerId: string
  kind: DepositKind
  /** 거래처 전체 잔액 */
  total: Prisma.Decimal
  /** 주문별 잔액 (GOODS_FUND 만 의미가 있다) */
  byOrder: Map<string, Prisma.Decimal>
}

export async function depositBalance(
  tx: Tx, partnerId: bigint, kind: DepositKind,
): Promise<DepositBalance> {
  const rows = await tx.depositLedger.findMany({
    where: { partnerId, depositKind: kind },
    select: { amountKrw: true, orderId: true },
  })
  let total = zero()
  const byOrder = new Map<string, Prisma.Decimal>()
  for (const r of rows) {
    const v = D(r.amountKrw)
    total = total.plus(v)
    if (r.orderId !== null) {
      const k = r.orderId.toString()
      byOrder.set(k, (byOrder.get(k) ?? zero()).plus(v))
    }
  }
  return { partnerId: partnerId.toString(), kind, total, byOrder }
}

/** 사람이 읽을 금액 */
const won = (v: Prisma.Decimal) => `${v.toDecimalPlaces(0).toNumber().toLocaleString('ko-KR')}원`

export class DepositShortageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DepositShortageError'
  }
}

/**
 * 예치금에서 빼기 전에 모자라지 않은지 본다.
 * 모자라면 얼마가 있고 얼마를 빼려 하는지 그대로 알려 준다 — 「저장 실패」 만 뜨면 고칠 수가 없다.
 */
export async function assertDepositAvailable(
  tx: Tx,
  partnerId: bigint,
  kind: DepositKind,
  /** 빼려는 금액 (양수). 주문별로 나눠 뺄 때는 orderId 별로 넣는다 */
  uses: { orderId: bigint | null; amount: Prisma.Decimal }[],
  partnerName?: string,
): Promise<void> {
  await lockPartnerDeposit(tx, partnerId)
  const bal = await depositBalance(tx, partnerId, kind)
  const label = kind === DepositKind.GOODS_FUND ? '상품구매 예치금' : '일반 예치금'
  const who = partnerName ? `${partnerName} 의 ` : ''

  const totalUse = uses.reduce((s, u) => s.plus(u.amount), zero())
  if (totalUse.gt(bal.total)) {
    throw new DepositShortageError(
      `${who}${label}이 모자랍니다. 남은 금액 ${won(bal.total)}, 쓰려는 금액 ${won(totalUse)}`
      + ` — ${won(totalUse.minus(bal.total))} 부족합니다.`,
    )
  }

  if (kind === DepositKind.GOODS_FUND) {
    for (const u of uses) {
      if (u.orderId === null) continue
      const have = bal.byOrder.get(u.orderId.toString()) ?? zero()
      if (u.amount.gt(have)) {
        const order = await tx.order.findUnique({
          where: { id: u.orderId }, select: { orderNo: true },
        })
        throw new DepositShortageError(
          `주문 ${order?.orderNo ?? u.orderId} 의 ${label}이 모자랍니다.`
          + ` 남은 금액 ${won(have)}, 쓰려는 금액 ${won(u.amount)}`
          + ` — ${won(u.amount.minus(have))} 부족합니다.`,
        )
      }
    }
  }
}

/**
 * 예치금이 마이너스인 곳을 찾는다 — 데이터 이상 탐지용.
 * 잔액을 0으로 잘라 숨기지 않고, 이상이 있으면 있다고 보여 준다.
 */
export interface DepositAnomaly {
  partnerId: string
  partnerName: string
  kind: DepositKind
  orderId: string | null
  orderNo: string | null
  balance: Prisma.Decimal
}

export async function findDepositAnomalies(): Promise<DepositAnomaly[]> {
  const rows = await prisma.depositLedger.findMany({
    select: {
      partnerId: true, depositKind: true, orderId: true, amountKrw: true,
      partner: { select: { name: true } },
      order: { select: { orderNo: true } },
    },
  })

  const byPartner = new Map<string, { name: string; kind: DepositKind; sum: Prisma.Decimal }>()
  const byOrder = new Map<string, {
    name: string; kind: DepositKind; sum: Prisma.Decimal
    partnerId: string; orderId: string; orderNo: string
  }>()

  for (const r of rows) {
    const v = D(r.amountKrw)
    const pk = `${r.partnerId}|${r.depositKind}`
    const p = byPartner.get(pk) ?? { name: r.partner.name, kind: r.depositKind, sum: zero() }
    p.sum = p.sum.plus(v)
    byPartner.set(pk, p)

    if (r.orderId !== null && r.depositKind === DepositKind.GOODS_FUND) {
      const ok = `${r.partnerId}|${r.depositKind}|${r.orderId}`
      const o = byOrder.get(ok) ?? {
        name: r.partner.name, kind: r.depositKind, sum: zero(),
        partnerId: r.partnerId.toString(), orderId: r.orderId.toString(),
        orderNo: r.order?.orderNo ?? '(알 수 없음)',
      }
      o.sum = o.sum.plus(v)
      byOrder.set(ok, o)
    }
  }

  const out: DepositAnomaly[] = []
  for (const [k, v] of byPartner) {
    if (v.sum.gte(0)) continue
    out.push({
      partnerId: k.split('|')[0], partnerName: v.name, kind: v.kind,
      orderId: null, orderNo: null, balance: v.sum,
    })
  }
  for (const v of byOrder.values()) {
    if (v.sum.gte(0)) continue
    out.push({
      partnerId: v.partnerId, partnerName: v.name, kind: v.kind,
      orderId: v.orderId, orderNo: v.orderNo, balance: v.sum,
    })
  }
  return out.sort((a, b) => a.balance.comparedTo(b.balance))
}

/**
 * 주문 잠금 — 같은 주문을 동시에 건드리는 요청을 줄 세운다.
 *
 * 세금계산서 발행 버튼을 두 번 누르면, 두 요청이 모두
 * "아직 계산서가 없다" 를 읽고 각각 한 장씩 만들 수 있다.
 * 트랜잭션 안에서 이 잠금을 먼저 잡고 다시 확인하면 그럴 일이 없다.
 *
 * 4839 는 예치금 잠금(4837)과 겹치지 않게 고른 번호다.
 */
const ORDER_LOCK_NS = 4839

export async function lockOrders(
  tx: Prisma.TransactionClient,
  orderIds: bigint[],
): Promise<void> {
  // 순서를 고정한다. 두 요청이 반대 순서로 잡으면 서로를 기다린다.
  for (const id of [...orderIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_LOCK_NS}::int, ${Number(id)}::int)`
  }
}
