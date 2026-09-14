/**
 * 시연용 준비 — 기준정보와 시연 자료를 넣는다.
 *
 * 여러 번 실행해도 안전하다. 이미 자료가 있으면 건너뛴다 —
 * 프로그램을 껐다 켤 때마다 시연 자료가 쌓이면 곤란하다.
 *
 * ⚠ 실제 회사 자료는 넣지 않는다. 전부 가짜 거래처·가짜 금액이다.
 */
import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'node:child_process'

const prisma = new PrismaClient()

function run(script: string) {
  const r = spawnSync('npx', ['tsx', script], { stdio: 'inherit', env: process.env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

async function main() {
  // 기준정보(거래유형·비용분류·계좌·관리자)는 upsert 라 몇 번 돌려도 안전하다
  run('prisma/seed.ts')

  const orders = await prisma.order.count()
  if (orders > 0) {
    console.log(`        이미 자료가 있습니다 (거래 ${orders}건). 그대로 둡니다.`)
    return
  }

  console.log('        시연용 거래를 넣습니다 — 실제 회사 자료가 아닙니다.')
  run('scripts/seed-demo.ts')

  // 직원을 하나 더 만들어 권한 차이를 눌러볼 수 있게 한다
  const bcrypt = (await import('bcryptjs')).default
  const pw = process.env.SEED_ADMIN_PASSWORD ?? 'yiwudream1234'
  await prisma.user.upsert({
    where: { loginId: 'staff' },
    update: {},
    create: {
      loginId: 'staff',
      name: '테스트 직원',
      role: 'STAFF',
      passwordHash: await bcrypt.hash(pw, 10),
    },
  })
  console.log('        직원 계정도 만들었습니다 — 아이디 staff (비밀번호는 admin 과 같습니다)')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
