/**
 * 검증 실행기.
 *
 * 검증 스크립트는 실제 주문·입금·지출을 만들었다 지운다.
 * 운영 DB에서 돌면 장부가 더러워지므로, 여기서 한 번 막고 각 스크립트를
 * 테스트 DB를 가리키는 자식 프로세스로 띄운다.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { resolveTestDatabaseUrl } from '../src/lib/test-guard'

const SCRIPTS = [
  'verify-allocate.ts',
  'verify.ts',
  'verify-phase2.ts',
  'verify-phase3.ts',
  'verify-phase4.ts',
  'verify-phase5.ts',
  'verify-phase6.ts',
  'verify-phase7.ts',
  'verify-audit.ts', 'verify-audit2.ts',
]

function main() {
  let check
  try {
    check = resolveTestDatabaseUrl()
  } catch (e) {
    console.error(`\n✗ ${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
  }
  console.log(`검증 DB: ${check.dbName} (${check.reason})`)

  const only = process.argv[2]
  const list = only ? SCRIPTS.filter((s) => s.includes(only)) : SCRIPTS
  if (list.length === 0) {
    console.error(`\n✗ "${only}" 에 맞는 검증 스크립트가 없습니다. ${SCRIPTS.join(' ')}\n`)
    process.exit(1)
  }

  const results: { name: string; code: number }[] = []
  for (const s of list) {
    console.log(`\n${'━'.repeat(60)}\n▶ ${s}`)
    const r = spawnSync('npx', ['tsx', path.join('scripts', s)], {
      stdio: 'inherit',
      // YD_TEST_CONTEXT — 검증 스크립트가 서버 액션을 그대로 부를 수 있게 한다.
      // 운영 빌드에서는 request-context.ts 가 무시한다.
      env: { ...process.env, DATABASE_URL: check.url, YD_TEST_CONTEXT: '1' },
    })
    results.push({ name: s, code: r.status ?? 1 })
  }

  const failed = results.filter((r) => r.code !== 0)
  console.log(`\n${'━'.repeat(60)}`)
  console.log(`검증 ${results.length}개 중 ${results.length - failed.length}개 통과`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.name}`)
    process.exit(1)
  }
}

main()
