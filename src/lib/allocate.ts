/**
 * 비율 배분 — 나눈 값의 합이 원래 금액과 정확히 같아야 한다.
 *
 * 100,000 을 셋으로 나누면 33,333.33 씩 세 개라 99,999.99 가 된다.
 * 1전이 사라지면 「분해 합계 = 입금액」 같은 검사가 막히고, 무엇보다
 * 통장 금액과 장부 금액이 안 맞는다. 마지막 한 건에 잔여를 몰아 합을 맞춘다.
 */
import { Prisma } from '@prisma/client'

const zero = () => new Prisma.Decimal(0)

export interface Weighted<T> {
  item: T
  weight: Prisma.Decimal
}

export interface Allocated<T> {
  item: T
  amount: Prisma.Decimal
}

/**
 * `total` 을 각 항목의 `weight` 비율대로 나눈다.
 *
 * - 소수 자릿수는 `decimals` (기본 2자리)
 * - 반올림으로 생긴 잔여액은 **가중치가 가장 큰 항목**에 더한다.
 *   마지막 항목에 몰면 목록 순서만 바뀌어도 배분이 달라져 재현이 안 된다.
 * - 가중치 합이 0이면 균등 배분한다.
 */
export function allocateProportional<T>(
  total: Prisma.Decimal,
  items: Weighted<T>[],
  decimals = 2,
): Allocated<T>[] {
  if (items.length === 0) return []
  if (items.length === 1) return [{ item: items[0].item, amount: total }]

  const weightSum = items.reduce((s, x) => s.plus(x.weight), zero())

  const out: Allocated<T>[] = items.map((x) => ({
    item: x.item,
    amount: weightSum.isZero()
      ? total.div(items.length).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_DOWN)
      : total.mul(x.weight).div(weightSum).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_DOWN),
  }))

  const allocated = out.reduce((s, x) => s.plus(x.amount), zero())
  const remainder = total.minus(allocated)
  if (!remainder.isZero()) {
    // 가중치가 가장 큰 항목에 잔여를 얹는다. 같으면 앞선 것에 얹는다
    let best = 0
    for (let i = 1; i < items.length; i++) {
      if (items[i].weight.gt(items[best].weight)) best = i
    }
    out[best].amount = out[best].amount.plus(remainder)
  }
  return out
}
