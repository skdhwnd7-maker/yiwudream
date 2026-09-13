/**
 * 변경이력 게이트.
 *
 * 금액성 데이터는 전부 이 파일의 함수만 통과한다.
 * prisma.xxx.update() 를 직접 부르면 이력이 남지 않으므로 금지한다.
 *
 * 설계 문서: docs/08-변경이력과감사.md
 */
import { randomUUID } from 'crypto'
import { Prisma, AuditAction } from '@prisma/client'
import { prisma } from './db'
import type { SessionUser } from './auth'

type Tx = Prisma.TransactionClient | typeof prisma

/**
 * 금액 필드 변경 시 사유를 반드시 받는 필드 목록.
 * 환율이 들어 있는 이유: 엑셀에서는 환율이 수식에 숨어 있어
 * 누가 언제 바꿨는지 알 수 없었다. 환율 변경은 마진을 직접 바꾼다.
 */
const REASON_REQUIRED: Record<string, string[]> = {
  receipts: ['amount', 'fxRate', 'receiptDate', 'partnerId'],
  expenses: ['amount', 'fxRate', 'categoryId', 'paymentStatus'],
  remittances: ['krwAmount', 'cnyArrivalAmount', 'status'],
  invoices: ['targetAmount', 'supplyAmount', 'vatAmount', 'issueStatus'],
  orders: ['partnerId', 'dealTypeId', 'status'],
  receipt_splits: ['amount'],
  expense_allocations: ['allocAmount'],
  internal_transfers: ['krwAmount', 'usdAmount', 'cnyArrivalAmount'],
  accounts: ['openingBalance'],
  deal_types: ['vatMode', 'vatRate', 'invoiceBase', 'revenueBasis'],
}

export class AuditReasonRequiredError extends Error {
  constructor(public readonly fields: string[]) {
    super(`다음 항목을 바꾸려면 사유를 입력해야 합니다: ${fields.join(', ')}`)
    this.name = 'AuditReasonRequiredError'
  }
}

export interface AuditContext {
  user: Pick<SessionUser, 'id' | 'name'>
  reason?: string
  ipAddress?: string
  requestId?: string
}

/** 비교·보관용 문자열. Decimal·Date·BigInt를 안정적으로 직렬화한다. */
function toComparable(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Prisma.Decimal) return v.toString()
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))
  return String(v)
}

function serializeRecord(record: Record<string, unknown>): string {
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(record)) out[k] = toComparable(v)
  return JSON.stringify(out)
}

/** 생성 기록. 전체 값을 newValue에 담는다. */
export async function logCreate(
  tx: Tx,
  tableName: string,
  recordId: bigint,
  record: Record<string, unknown>,
  ctx: AuditContext,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tableName,
      recordId,
      action: AuditAction.CREATE,
      newValue: serializeRecord(record),
      changedBy: BigInt(ctx.user.id),
      reason: ctx.reason ?? null,
      ipAddress: ctx.ipAddress ?? null,
      requestId: ctx.requestId ?? randomUUID(),
    },
  })
}

/**
 * 수정 기록. 변경된 필드마다 1행을 남긴다.
 * 사유 필수 필드가 바뀌었는데 사유가 없으면 예외를 던지고 아무것도 쓰지 않는다.
 */
export async function logUpdate(
  tx: Tx,
  tableName: string,
  recordId: bigint,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ctx: AuditContext,
): Promise<string[]> {
  const changed: { field: string; old: string | null; next: string | null }[] = []

  for (const key of Object.keys(after)) {
    const oldVal = toComparable(before[key])
    const newVal = toComparable(after[key])
    if (oldVal !== newVal) changed.push({ field: key, old: oldVal, next: newVal })
  }

  if (changed.length === 0) return []

  const needsReason = (REASON_REQUIRED[tableName] ?? []).filter((f) => changed.some((c) => c.field === f))
  if (needsReason.length > 0 && !ctx.reason?.trim()) {
    throw new AuditReasonRequiredError(needsReason)
  }

  const requestId = ctx.requestId ?? randomUUID()
  await tx.auditLog.createMany({
    data: changed.map((c) => ({
      tableName,
      recordId,
      action: AuditAction.UPDATE,
      fieldName: c.field,
      oldValue: c.old,
      newValue: c.next,
      changedBy: BigInt(ctx.user.id),
      reason: ctx.reason ?? null,
      ipAddress: ctx.ipAddress ?? null,
      requestId,
    })),
  })

  return changed.map((c) => c.field)
}

/** 취소·정산·잠금해제 등 상태 변화 기록. */
export async function logAction(
  tx: Tx,
  tableName: string,
  recordId: bigint,
  action: AuditAction,
  ctx: AuditContext,
  detail?: { field?: string; oldValue?: string | null; newValue?: string | null },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tableName,
      recordId,
      action,
      fieldName: detail?.field ?? null,
      oldValue: detail?.oldValue ?? null,
      newValue: detail?.newValue ?? null,
      changedBy: BigInt(ctx.user.id),
      reason: ctx.reason ?? null,
      ipAddress: ctx.ipAddress ?? null,
      requestId: ctx.requestId ?? randomUUID(),
    },
  })
}

/** 접속·내보내기 감사. 대상 레코드가 없으므로 recordId는 사용자 본인. */
export async function logSystem(action: AuditAction, ctx: AuditContext): Promise<void> {
  await prisma.auditLog.create({
    data: {
      tableName: 'system',
      recordId: BigInt(ctx.user.id),
      action,
      changedBy: BigInt(ctx.user.id),
      reason: ctx.reason ?? null,
      ipAddress: ctx.ipAddress ?? null,
      requestId: ctx.requestId ?? randomUUID(),
    },
  })
}

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  CREATE: '생성',
  UPDATE: '수정',
  VOID: '취소',
  RESTORE: '복구',
  SETTLE: '정산완료',
  UNLOCK: '잠금해제',
  IMPORT: '가져오기',
  LOGIN: '로그인',
  LOGOUT: '로그아웃',
  EXPORT: '내보내기',
}

export const TABLE_LABEL: Record<string, string> = {
  users: '사용자',
  partners: '거래처',
  partner_aliases: '거래처 별칭',
  accounts: '계좌',
  expense_categories: '비용분류',
  deal_types: '거래유형',
  orders: '주문',
  receipts: '입금',
  receipt_splits: '입금분해',
  deposit_ledger: '예치금원장',
  expenses: '지출',
  expense_allocations: '지출배분',
  remittances: '해외송금',
  remittance_allocations: '송금배분',
  internal_transfers: '내부자금이동',
  invoices: '세금계산서',
  employees: '중국직원',
  payrolls: '급여',
  settings: '설정',
  system: '시스템',
}
