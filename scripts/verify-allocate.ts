/** 배분 계산 단위 검증 — DB 를 쓰지 않는다 */
import { Prisma } from '@prisma/client'
import { allocateProportional } from '../src/lib/allocate'

const D = (v: string) => new Prisma.Decimal(v)
let pass = 0, fail = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label} = ${a}`) }
  else { fail++; console.log(`  ✗ ${label} — 기대 ${e}, 실제 ${a}`) }
}
const sum = (xs: { amount: Prisma.Decimal }[]) =>
  xs.reduce((s, x) => s.plus(x.amount), D('0')).toString()

console.log('\n━━ 비율 배분 ━━')
const w = (...ws: string[]) => ws.map((x, i) => ({ item: i, weight: D(x) }))

let r = allocateProportional(D('100000'), w('1', '1', '1'))
check('셋으로 나눈 합이 원금과 같다', sum(r), '100000')
check('잔여는 첫 항목에', r[0].amount.toString(), '33333.34')

r = allocateProportional(D('1000000'), w('600000', '400000'))
check('6:4 배분 — 첫째', r[0].amount.toString(), '600000')
check('6:4 배분 — 둘째', r[1].amount.toString(), '400000')

r = allocateProportional(D('14416.02'), w('3142691.27', '1000000'))
check('CNY 2자리 배분 합', sum(r), '14416.02')

r = allocateProportional(D('100'), w('0', '0'))
check('가중치가 0이면 균등 배분', sum(r), '100')

r = allocateProportional(D('7'), w('1', '1', '1'))
check('나누어떨어지지 않아도 합이 맞는다', sum(r), '7')

r = allocateProportional(D('100000'), w('1'))
check('한 건이면 전액', r[0].amount.toString(), '100000')

check('빈 목록', allocateProportional(D('100'), []).length, 0)

// 가중치가 큰 쪽에 잔여가 가야 목록 순서가 바뀌어도 결과가 같다
const a1 = allocateProportional(D('10'), [
  { item: 'a', weight: D('1') }, { item: 'b', weight: D('2') }, { item: 'c', weight: D('1') },
])
const a2 = allocateProportional(D('10'), [
  { item: 'c', weight: D('1') }, { item: 'b', weight: D('2') }, { item: 'a', weight: D('1') },
])
const pick = (xs: typeof a1, k: string) => xs.find((x) => x.item === k)!.amount.toString()
check('순서를 바꿔도 같은 배분 (a)', pick(a1, 'a'), pick(a2, 'a'))
check('순서를 바꿔도 같은 배분 (b)', pick(a1, 'b'), pick(a2, 'b'))
check('순서를 바꿔도 같은 배분 (c)', pick(a1, 'c'), pick(a2, 'c'))

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`통과 ${pass} / 실패 ${fail}`)
if (fail > 0) process.exitCode = 1
