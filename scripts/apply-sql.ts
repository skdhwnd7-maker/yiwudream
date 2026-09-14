/** prisma/sql/*.sql 을 순서대로 적용한다. psql 이 없어도 돌아간다 */
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const dir = path.join(process.cwd(), 'prisma', 'sql')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    // $executeRawUnsafe 는 한 번에 한 문장만 받는다.
    // 함수 본문의 세미콜론과 진짜 문장 구분자를 헷갈리면 안 되므로
    // $$ ... $$ 로 감싼 구간은 통째로 건너뛰며 자른다.
    for (const stmt of splitStatements(sql)) {
      await prisma.$executeRawUnsafe(stmt)
    }
    console.log(`  적용: ${f}`)
  }
  console.log('SQL 보호장치·채번 적용 완료')
}

/** SQL 을 문장 단위로 자른다. 달러 인용($$, $tag$)과 따옴표 안의 세미콜론은 건너뛴다 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]

    // 줄 주석
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    // 작은따옴표 문자열
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1)
      const stop = end === -1 ? sql.length : end + 1
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    // 달러 인용 — $$ 또는 $tag$
    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      buf += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      i += 1
      continue
    }
    buf += ch
    i += 1
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
