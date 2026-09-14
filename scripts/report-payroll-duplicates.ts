/**
 * 사회보험 전표 중복 탐지 보고서.
 *
 * 급여를 다시 입력하면 급여 전표는 취소되는데 사회보험 전표는 연결이 없어
 * 옛것이 살아남았다. 같은 달·같은 직원의 사회보험이 두 번 잡혔을 수 있다.
 *
 * ⚠ 이 스크립트는 아무것도 지우지 않는다. 무엇이 의심스러운지 보여 주기만 한다.
 *   지울지 말지는 대표님이 보고 정하실 일이다.
 */
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const won = (v: Prisma.Decimal) => v.toDecimalPlaces(2).toNumber().toLocaleString('ko-KR')

async function main() {
  const cat = await prisma.expenseCategory.findFirst({ where: { code: 'INSURANCE' } })
  if (!cat) {
    console.log('사회보험 비용분류가 없습니다. 확인할 것이 없습니다.')
    return
  }

  const payrolls = await prisma.payroll.findMany({
    include: { employee: { select: { name: true, nameCn: true } } },
    orderBy: [{ yearMonth: 'asc' }, { employeeId: 'asc' }],
  })

  // 사회보험 전표는 메모에 「YYYY-MM 사회보험(회사부담) · 이름」 으로 적혀 있다
  const expenses = await prisma.expense.findMany({
    where: { categoryId: cat.id },
    select: {
      id: true, expenseNo: true, amount: true, expenseDate: true,
      memo: true, isVoid: true, voidReason: true, createdAt: true,
    },
    orderBy: { id: 'asc' },
  })

  console.log('━'.repeat(72))
  console.log('사회보험 전표 중복 탐지 보고서')
  console.log('━'.repeat(72))
  console.log(`급여 ${payrolls.length}건 · 사회보험 전표 ${expenses.length}건`)

  let suspects = 0
  let extraTotal = D(0)
  const rows: string[] = []

  for (const p of payrolls) {
    if (p.insuranceCompany.lte(0)) continue
    const name = p.employee.name
    const tag = `${p.yearMonth} 사회보험(회사부담) · ${name}`
    const live = expenses.filter((e) => !e.isVoid && (e.memo ?? '').includes(tag))

    if (live.length <= 1) continue

    suspects += 1
    const total = live.reduce((s, e) => s.plus(e.amount), D(0))
    const extra = total.minus(p.insuranceCompany)
    extraTotal = extraTotal.plus(extra)

    rows.push(
      `\n  ${p.yearMonth}  ${name}\n`
      + `    급여에 적힌 사회보험   ${won(p.insuranceCompany)}\n`
      + `    살아있는 전표 ${live.length}건 합계  ${won(total)}   ← ${won(extra)} 더 잡힘\n`
      + live.map((e) => {
        const linked = e.id === p.insuranceExpenseId ? '  (급여에 연결됨)' : '  (연결 없음 — 옛 전표로 보임)'
        return `      ${e.expenseNo}  ${won(e.amount)}  ${e.createdAt.toISOString().slice(0, 19).replace('T', ' ')}${linked}`
      }).join('\n'),
    )
  }

  // 급여와 짝이 맞지 않는 떠돌이 전표
  const orphans = expenses.filter((e) => {
    if (e.isVoid) return false
    const m = /^(\d{4}-\d{2}) 사회보험\(회사부담\) · (.+)$/.exec(e.memo ?? '')
    if (!m) return false
    return !payrolls.some((p) => p.yearMonth === m[1] && p.employee.name === m[2])
  })

  if (suspects === 0 && orphans.length === 0) {
    console.log('\n✓ 중복으로 의심되는 사회보험 전표가 없습니다.')
  } else {
    if (suspects > 0) {
      console.log(`\n[중복 의심] ${suspects}건 — 합계 ${won(extraTotal)} 이 더 잡혀 있습니다`)
      console.log(rows.join('\n'))
    }
    if (orphans.length > 0) {
      console.log(`\n[짝 없는 전표] ${orphans.length}건 — 대응하는 급여 기록이 없습니다`)
      for (const e of orphans) {
        console.log(`    ${e.expenseNo}  ${won(e.amount)}  ${e.memo ?? ''}`)
      }
    }
    console.log('\n' + '─'.repeat(72))
    console.log('이 스크립트는 아무것도 지우지 않았습니다.')
    console.log('어느 전표를 취소할지 정하신 뒤 급여 화면에서 해당 달을 다시 저장하시면')
    console.log('옛 전표가 자동으로 취소되고 새로 만들어집니다.')
  }
  console.log('━'.repeat(72))
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
