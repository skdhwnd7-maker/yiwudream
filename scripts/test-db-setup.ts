/**
 * 검증용 DB 준비 — 스키마·보호장치·기준정보를 넣는다.
 * 운영 DB를 건드리지 않도록 test-guard 를 먼저 통과해야 한다.
 */
import { spawnSync } from 'node:child_process'
import { resolveTestDatabaseUrl } from '../src/lib/test-guard'

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: false })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

let check
try {
  check = resolveTestDatabaseUrl()
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}\n`)
  process.exit(1)
}
console.log(`검증 DB 준비: ${check.dbName}`)
const env = { ...process.env, DATABASE_URL: check.url }

run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], env)
run('npx', ['tsx', 'scripts/apply-sql.ts'], env)
run('npx', ['tsx', 'prisma/seed.ts'], env)
console.log('검증 DB 준비 완료')
