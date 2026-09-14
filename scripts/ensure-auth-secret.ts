/**
 * 로그인 보안키(AUTH_SECRET)를 정한다.
 *
 * 이 키로 로그인 쿠키에 서명한다. 켤 때마다 키가 바뀌면 접속이 매번 끊긴다.
 * 그래서 한 번 만든 키는 데이터베이스에 넣어 두고 계속 같은 것을 쓴다.
 *
 * 파일에 두지 않는 이유:
 * Railway 같은 곳은 새로 배포할 때마다 디스크가 새것으로 바뀐다.
 * 자료가 남는 곳은 데이터베이스뿐이라 거기에 둔다.
 *
 * 정한 키만 표준출력으로 한 줄 내보낸다. 실행 기록에는 남기지 않는다.
 */
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const KEY = 'auth_secret'
const PLACEHOLDER = 'build-time-placeholder-secret-not-used-at-runtime'

async function main(): Promise<void> {
  // 사람이 직접 정해 넣었으면 그것을 그대로 쓴다.
  const given = process.env.AUTH_SECRET
  if (given && given.length >= 32 && given !== PLACEHOLDER) {
    process.stdout.write(given)
    return
  }

  const prisma = new PrismaClient()
  try {
    const found = await prisma.setting.findUnique({ where: { key: KEY } })
    if (found && found.value.length >= 32) {
      process.stdout.write(found.value)
      return
    }

    const made = randomBytes(48).toString('base64url')
    await prisma.setting.upsert({
      where: { key: KEY },
      update: { value: made },
      create: {
        key: KEY,
        value: made,
        valueType: 'string',
        description: '로그인 쿠키 서명키 — 자동 생성. 바꾸면 모든 접속이 끊긴다.',
      },
    })
    process.stdout.write(made)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
