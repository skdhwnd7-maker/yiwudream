/**
 * 전표번호 채번.
 *
 * 여러 직원이 동시에 등록해도 겹치지 않도록 DB 함수로 처리한다.
 * 애플리케이션에서 MAX+1 을 읽어 쓰면 동시 등록 시 같은 번호가 나온다.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './db'

export type DocPrefix = 'ORDER' | 'RC' | 'EX' | 'RM' | 'IT' | 'TX'

type Tx = Prisma.TransactionClient | typeof prisma

export async function nextDocNo(tx: Tx, prefix: DocPrefix, date: Date = new Date()): Promise<string> {
  const year = date.getFullYear()
  // Prisma는 JS 숫자를 bigint로 넘기므로 int로 캐스팅해 함수 시그니처를 맞춘다
  const rows = await tx.$queryRaw<{ next_doc_no: string }[]>`
    SELECT next_doc_no(${prefix}::text, ${year}::int) AS next_doc_no
  `
  return rows[0].next_doc_no
}
