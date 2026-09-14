/**
 * 시연 자료를 전부 지우고 빈 장부로 되돌린다.
 *
 * 대표님이 Railway 화면에서 직접 돌리실 수 있게 만든 것이다.
 * 데이터베이스를 만질 필요 없이 RESET_DATA 값을 넣고 다시 배포하면 된다.
 *
 * ── 한 번만 돈다 ───────────────────────────────────────────
 * RESET_DATA 에 넣은 값을 다 지운 뒤 settings 에 적어 둔다.
 * 다음에 켤 때 같은 값이 보이면 건너뛴다.
 * 값을 지우는 걸 깜빡해도 배포할 때마다 장부가 날아가지 않는다.
 * 다시 비우시려면 값을 다른 것으로 바꾸시면 된다 (1 → 2).
 *
 * 지우는 범위: 표 전체. 계좌·거래유형·비용분류·사용자까지 지우고
 * 곧바로 기준정보를 다시 넣는다 (prisma/seed.ts).
 * 어중간하게 남겨 두면 안 맞는 자료가 섞이기 때문이다.
 */
import { spawnSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'

const MARK = 'data_reset_token'
const prisma = new PrismaClient()

async function main(): Promise<void> {
  const token = (process.env.RESET_DATA ?? '').trim()
  if (!token) return

  const done = await prisma.setting.findUnique({ where: { key: MARK } })
  if (done?.value === token) {
    console.log(`        이미 초기화한 값입니다 (RESET_DATA=${token}). 자료를 건드리지 않습니다.`)
    return
  }

  // 표 목록은 DB 에서 직접 읽는다. 표가 늘어나도 여기를 고칠 일이 없다.
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
    ORDER BY tablename
  `
  const tables = rows.map((r) => `"${r.tablename}"`)
  if (tables.length === 0) throw new Error('표를 찾지 못했습니다.')

  const before = await prisma.order.count()
  console.log(`        거래 ${before}건을 포함해 표 ${tables.length}개를 비웁니다.`)

  // TRUNCATE 는 행 단위 트리거를 거치지 않는다 — 원장 불변 보호장치에 걸리지 않는다.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
  )

  // 기준정보(계좌·거래유형·비용분류·관리자)를 다시 넣는다
  const r = spawnSync('npx', ['tsx', 'prisma/seed.ts'], { stdio: 'inherit', env: process.env })
  if (r.status !== 0) throw new Error('기준정보를 다시 넣지 못했습니다.')

  await prisma.setting.upsert({
    where: { key: MARK },
    update: { value: token },
    create: {
      key: MARK,
      value: token,
      valueType: 'string',
      description: '마지막으로 자료를 비운 RESET_DATA 값. 같은 값으로는 다시 비우지 않는다.',
    },
  })

  console.log('        비웠습니다. 이제 빈 장부입니다.')
  console.log('        ⚠ Railway 의 RESET_DATA 값을 지워 주세요.')
}

main()
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
