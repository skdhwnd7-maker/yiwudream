import fs from 'node:fs'
import path from 'node:path'

/**
 * 테스트가 운영 DB를 건드리지 못하게 막는다.
 *
 * 검증 스크립트는 주문·입금·지출을 실제로 만들었다 지운다.
 * 그게 운영 DB에서 돌면 대표님 장부에 가짜 거래가 섞인다.
 * 그래서 「안전하다고 확인된 DB」 가 아니면 아예 시작하지 않는다.
 */

/**
 * .env 를 직접 읽는다. Prisma 는 알아서 읽지만 tsx 로 띄운 스크립트는 그렇지 않아서
 * TEST_DATABASE_URL 을 못 찾고 「없다」 고 막아 버린다.
 */
export function loadDotEnv(file = '.env'): void {
  let text: string
  try {
    text = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    if (process.env[key] !== undefined) continue // 이미 정해진 값이 우선이다
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[key] = v
  }
}

/** .env 파일에 적힌 값을 그대로 읽는다 (process.env 가 덮어썼을 수 있으므로) */
function declaredInDotEnv(key: string, file = '.env'): string | undefined {
  let text: string
  try {
    text = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line)
    if (!m) continue
    let v = m[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v
  }
  return undefined
}

export interface TestDbCheck {
  url: string
  dbName: string
  reason: string
}

/** 운영 DB로 의심되는 이름 */
const PRODUCTION_HINTS = [/prod/i, /production/i, /live/i, /운영/]

/** 테스트 DB임을 스스로 밝히는 이름 */
const TEST_HINTS = [/test/i, /_dev$/i, /^dev_/i, /sandbox/i, /scratch/i]

function dbNameOf(url: string): string {
  try {
    // postgresql://user:pw@host:5432/이름?schema=public
    const path = new URL(url).pathname
    return decodeURIComponent(path.replace(/^\//, '')) || '(이름 없음)'
  } catch {
    const m = /\/([^/?]+)(\?|$)/.exec(url)
    return m ? m[1] : '(이름 없음)'
  }
}

/**
 * 테스트용 DB 주소를 고르고, 안전한지 확인한다.
 * 안전하지 않으면 무엇을 어떻게 고쳐야 하는지 알려주고 던진다.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): TestDbCheck {
  if (env === process.env) loadDotEnv()
  const testUrl = env.TEST_DATABASE_URL?.trim()
  // 운영 DB 주소는 .env 에 적힌 것을 본다.
  // process.env.DATABASE_URL 은 실행기가 이미 테스트 DB로 바꿔 놓았을 수 있다.
  const mainUrl = (declaredInDotEnv('DATABASE_URL') ?? env.DATABASE_URL)?.trim()

  if (!testUrl) {
    throw new Error(
      '검증은 운영 DB에서 돌릴 수 없습니다.\n'
      + '  TEST_DATABASE_URL 환경변수에 테스트 전용 DB 주소를 넣어 주세요.\n'
      + '  예) createdb yiwudream_test\n'
      + '      TEST_DATABASE_URL="postgresql://사용자@localhost:5432/yiwudream_test"',
    )
  }

  if (mainUrl && testUrl === mainUrl) {
    throw new Error(
      'TEST_DATABASE_URL 이 DATABASE_URL 과 같습니다.\n'
      + '  검증은 자료를 만들었다 지우므로 운영 DB와 같은 곳을 쓰면 안 됩니다.\n'
      + '  테스트 전용 DB를 따로 만들어 주세요.',
    )
  }

  const dbName = dbNameOf(testUrl)

  const looksProduction = PRODUCTION_HINTS.some((re) => re.test(dbName))
  if (looksProduction) {
    throw new Error(
      `TEST_DATABASE_URL 의 DB 이름이 「${dbName}」 입니다. 운영 DB로 보입니다.\n`
      + '  검증을 중단합니다. 이름에 test 가 들어간 전용 DB를 쓰세요.',
    )
  }

  const looksTest = TEST_HINTS.some((re) => re.test(dbName))
  if (!looksTest) {
    // 이름만으로는 판단이 안 된다. 사람이 명시적으로 허용해야 한다
    if (env.ALLOW_TEST_ON_THIS_DB !== dbName) {
      throw new Error(
        `DB 이름 「${dbName}」 만으로는 테스트용인지 알 수 없습니다.\n`
        + '  이름에 test 를 넣거나, 정말 이 DB를 써도 된다면\n'
        + `  ALLOW_TEST_ON_THIS_DB=${dbName} 를 함께 넣어 주세요.`,
      )
    }
    return { url: testUrl, dbName, reason: `ALLOW_TEST_ON_THIS_DB=${dbName} 로 명시 허용됨` }
  }

  return { url: testUrl, dbName, reason: '이름이 테스트용으로 확인됨' }
}

/**
 * 검증 스크립트 맨 위에서 부른다.
 * DATABASE_URL 을 테스트 DB로 바꿔치기하므로, Prisma 를 불러오기 **전에** 실행해야 한다.
 */
export function useTestDatabase(): TestDbCheck {
  const check = resolveTestDatabaseUrl()
  process.env.DATABASE_URL = check.url
  return check
}
