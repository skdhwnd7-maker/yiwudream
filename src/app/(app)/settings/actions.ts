'use server'

import { revalidate } from '@/lib/revalidate'
import { Prisma, Entity, Route, Currency, CostType, RevenueBasis, InvoiceBase, VatMode, Rounding, Role } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, AuditReasonRequiredError } from '@/lib/audit'
import { hashPassword } from '@/lib/auth'

export type ActionState = { error?: string; ok?: string }

const enumOr = <T extends Record<string, string>>(e: T, v: FormDataEntryValue | null, fallback: T[keyof T]): T[keyof T] => {
  const s = String(v ?? '')
  return (s in e ? s : fallback) as T[keyof T]
}

// ── 계좌 ─────────────────────────────────────────────────────

/** 이 계좌에 붙어 있는 거래 건수 */
async function accountUsageCount(id: bigint): Promise<number> {
  const [receipts, expenses, remitFrom, remitTo, transferFrom, transferTo] = await Promise.all([
    prisma.receipt.count({ where: { accountId: id } }),
    prisma.expense.count({ where: { accountId: id } }),
    prisma.remittance.count({ where: { fromAccountId: id } }),
    prisma.remittance.count({ where: { toAccountId: id } }),
    prisma.internalTransfer.count({ where: { fromAccountId: id } }),
    prisma.internalTransfer.count({ where: { toAccountId: id } }),
  ])
  return receipts + expenses + remitFrom + remitTo + transferFrom + transferTo
}

export async function saveAccount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const idRaw = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim() || undefined
  if (!name) return { error: '계좌명을 입력하세요.' }

  const openingRaw = String(formData.get('openingBalance') ?? '0').replace(/,/g, '').trim()
  if (openingRaw && !Number.isFinite(Number(openingRaw))) return { error: '기초잔액이 숫자가 아닙니다.' }
  const openingDateRaw = String(formData.get('openingDate') ?? '')

  const data = {
    name,
    entity: enumOr(Entity, formData.get('entity'), Entity.KR),
    route: enumOr(Route, formData.get('route'), Route.BANK_CORP),
    currency: enumOr(Currency, formData.get('currency'), Currency.KRW),
    bankName: String(formData.get('bankName') ?? '').trim() || null,
    accountNo: String(formData.get('accountNo') ?? '').trim() || null,
    openingBalance: new Prisma.Decimal(openingRaw || '0'),
    openingDate: openingDateRaw ? new Date(openingDateRaw) : null,
    memo: String(formData.get('memo') ?? '').trim() || null,
  }

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.account.findUnique({ where: { id } })
      if (!before) return { error: '계좌를 찾을 수 없습니다.' }

      // 거래가 붙은 계좌의 성격을 바꾸면 과거 기록의 뜻이 달라진다.
      // 원화 계좌를 위안 계좌로 바꾸면 지난 입금들이 갑자기 위안이 된다.
      const used = await accountUsageCount(id)
      if (used > 0) {
        const locked: string[] = []
        if (before.entity !== data.entity) locked.push('소속(한국/중국)')
        if (before.route !== data.route) locked.push('루트')
        if (before.currency !== data.currency) locked.push('통화')
        if (locked.length > 0) {
          return {
            error: `이 계좌에는 이미 거래가 ${used.toLocaleString('ko-KR')}건 붙어 있어`
              + ` ${locked.join('·')}를 바꿀 수 없습니다. 과거 기록의 뜻이 달라집니다.\n`
              + '이 계좌를 비활성으로 돌리고 새 계좌를 만들어 쓰세요.'
              + ' (이름·은행·계좌번호·기초잔액·메모는 바꿀 수 있습니다)',
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        await logUpdate(tx, 'accounts', id,
          { name: before.name, entity: before.entity, route: before.route, currency: before.currency,
            bankName: before.bankName, accountNo: before.accountNo, openingBalance: before.openingBalance,
            openingDate: before.openingDate, memo: before.memo },
          data, await auditContext(user, reason))
        await tx.account.update({ where: { id }, data: { ...data, updatedBy: BigInt(user.id) } })
      })
    } else {
      await prisma.$transaction(async (tx) => {
        const created = await tx.account.create({ data: { ...data, createdBy: BigInt(user.id) } })
        await logCreate(tx, 'accounts', created.id, data, await auditContext(user))
      })
    }
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/settings/accounts')
  return { ok: '저장했습니다.' }
}

export async function toggleAccountActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const id = BigInt(String(formData.get('id')))
  const acc = await prisma.account.findUnique({ where: { id } })
  if (!acc) return { error: '계좌를 찾을 수 없습니다.' }

  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'accounts', id, { isActive: acc.isActive }, { isActive: !acc.isActive }, await auditContext(user, '계좌 사용 여부 변경'))
    await tx.account.update({ where: { id }, data: { isActive: !acc.isActive, updatedBy: BigInt(user.id) } })
  })
  revalidate('/settings/accounts')
  return { ok: acc.isActive ? '사용 중지했습니다.' : '다시 사용합니다.' }
}

// ── 비용분류 ─────────────────────────────────────────────────

export async function saveCategory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const idRaw = String(formData.get('id') ?? '')
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  const name = String(formData.get('name') ?? '').trim()
  if (!code || !name) return { error: '코드와 분류명을 입력하세요.' }

  const data = {
    code,
    name,
    costType: enumOr(CostType, formData.get('costType'), CostType.ORDER_COST),
    defaultEntity: enumOr(Entity, formData.get('defaultEntity'), Entity.CN),
    defaultCurrency: enumOr(Currency, formData.get('defaultCurrency'), Currency.CNY),
    sortOrder: Number(formData.get('sortOrder') ?? 0) || 0,
  }

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.expenseCategory.findUnique({ where: { id } })
      if (!before) return { error: '비용분류를 찾을 수 없습니다.' }
      await prisma.$transaction(async (tx) => {
        await logUpdate(tx, 'expense_categories', id,
          { code: before.code, name: before.name, costType: before.costType,
            defaultEntity: before.defaultEntity, defaultCurrency: before.defaultCurrency, sortOrder: before.sortOrder },
          data, await auditContext(user))
        await tx.expenseCategory.update({ where: { id }, data })
      })
    } else {
      const dup = await prisma.expenseCategory.findUnique({ where: { code } })
      if (dup) return { error: `이미 있는 코드입니다: ${code}` }
      await prisma.$transaction(async (tx) => {
        const created = await tx.expenseCategory.create({ data })
        await logCreate(tx, 'expense_categories', created.id, data, await auditContext(user))
      })
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/settings/categories')
  return { ok: '저장했습니다.' }
}

// ── 거래유형 ─────────────────────────────────────────────────

export async function saveDealType(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const idRaw = String(formData.get('id') ?? '')
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  const name = String(formData.get('name') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim() || undefined
  if (!code || !name) return { error: '코드와 이름을 입력하세요.' }

  const vatRateRaw = String(formData.get('vatRate') ?? '0.10').trim()
  if (!Number.isFinite(Number(vatRateRaw))) return { error: '부가세율이 숫자가 아닙니다.' }

  const routeRaw = String(formData.get('defaultRoute') ?? '')

  const data = {
    code,
    name,
    revenueBasis: enumOr(RevenueBasis, formData.get('revenueBasis'), RevenueBasis.GROSS),
    invoiceBase: enumOr(InvoiceBase, formData.get('invoiceBase'), InvoiceBase.NONE),
    invoiceDefault: formData.get('invoiceDefault') === 'on',
    vatMode: enumOr(VatMode, formData.get('vatMode'), VatMode.NONE),
    vatRate: new Prisma.Decimal(vatRateRaw),
    rounding: enumOr(Rounding, formData.get('rounding'), Rounding.FLOOR),
    accountingClass: String(formData.get('accountingClass') ?? '상품매출').trim(),
    defaultRoute: routeRaw && routeRaw in Route ? (routeRaw as Route) : null,
    sortOrder: Number(formData.get('sortOrder') ?? 0) || 0,
    memo: String(formData.get('memo') ?? '').trim() || null,
  }

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.dealType.findUnique({ where: { id } })
      if (!before) return { error: '거래유형을 찾을 수 없습니다.' }

      // 세무 규칙을 바꾸면 과거 주문의 부가세·발행대상금액이 소급해서 달라진다.
      // 이미 신고한 달의 숫자가 조용히 바뀌면 안 된다.
      const used = await prisma.order.count({ where: { dealTypeId: id, isVoid: false } })
      if (used > 0) {
        const locked: string[] = []
        if (before.revenueBasis !== data.revenueBasis) locked.push('매출인식 기준')
        if (before.invoiceBase !== data.invoiceBase) locked.push('세금계산서 발행 기준')
        if (before.vatMode !== data.vatMode) locked.push('부가세 방식')
        if (!before.vatRate.equals(data.vatRate)) locked.push('부가세율')
        if (before.rounding !== data.rounding) locked.push('끝자리 처리')
        if (before.accountingClass !== data.accountingClass) locked.push('회계분류')
        if (locked.length > 0) {
          return {
            error: `이 거래유형으로 만든 주문이 ${used.toLocaleString('ko-KR')}건 있어`
              + ` ${locked.join('·')}를 바꿀 수 없습니다.\n`
              + '과거 주문의 부가세와 발행대상금액이 소급해서 달라집니다.\n'
              + '규칙이 바뀌었다면 이 유형을 비활성으로 돌리고 새 유형을 만들어 쓰세요.'
              + ' 과거 거래는 그때의 규칙으로 계속 계산됩니다.'
              + ' (이름·기본 루트·정렬순서·메모·기본 발행여부는 바꿀 수 있습니다)',
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        await logUpdate(tx, 'deal_types', id,
          { code: before.code, name: before.name, revenueBasis: before.revenueBasis, invoiceBase: before.invoiceBase,
            invoiceDefault: before.invoiceDefault, vatMode: before.vatMode, vatRate: before.vatRate,
            rounding: before.rounding, accountingClass: before.accountingClass, defaultRoute: before.defaultRoute,
            sortOrder: before.sortOrder, memo: before.memo },
          data, await auditContext(user, reason))
        await tx.dealType.update({ where: { id }, data })
      })
    } else {
      const dup = await prisma.dealType.findUnique({ where: { code } })
      if (dup) return { error: `이미 있는 코드입니다: ${code}` }
      await prisma.$transaction(async (tx) => {
        const created = await tx.dealType.create({ data })
        await logCreate(tx, 'deal_types', created.id, data, await auditContext(user))
      })
    }
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/settings/deal-types')
  return { ok: '저장했습니다.' }
}

// ── 사용자 ───────────────────────────────────────────────────

export async function saveUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requirePermission('settings.manage')
  const idRaw = String(formData.get('id') ?? '')
  const loginId = String(formData.get('loginId') ?? '').trim()
  const name = String(formData.get('name') ?? '').trim()
  const role = enumOr(Role, formData.get('role'), Role.STAFF)
  const password = String(formData.get('password') ?? '')

  if (!loginId || !name) return { error: '아이디와 이름을 입력하세요.' }
  if (!idRaw && password.length < 8) return { error: '비밀번호는 8자 이상이어야 합니다.' }
  if (idRaw && password && password.length < 8) return { error: '비밀번호는 8자 이상이어야 합니다.' }

  try {
    if (idRaw) {
      const id = BigInt(idRaw)
      const before = await prisma.user.findUnique({ where: { id } })
      if (!before) return { error: '사용자를 찾을 수 없습니다.' }

      // 마지막 대표 계정의 권한을 낮추면 아무도 설정을 못 바꾸게 된다.
      if (before.role === Role.OWNER && role !== Role.OWNER) {
        const owners = await prisma.user.count({ where: { role: Role.OWNER, isActive: true } })
        if (owners <= 1) return { error: '마지막 대표 계정의 권한은 바꿀 수 없습니다.' }
      }

      await prisma.$transaction(async (tx) => {
        await logUpdate(tx, 'users', id,
          { loginId: before.loginId, name: before.name, role: before.role },
          { loginId, name, role },
          await auditContext(admin, '사용자 정보 변경'))
        await tx.user.update({
          where: { id },
          data: {
            loginId, name, role,
            ...(password
              ? {
                  passwordHash: await hashPassword(password),
                  // 비밀번호를 바꾸면 기존 로그인은 즉시 끊는다.
                  // 안 그러면 바꾼 뒤에도 예전 세션으로 12시간 더 쓸 수 있다.
                  sessionsValidFrom: new Date(),
                  failedLoginCount: 0,
                  lockedUntil: null,
                }
              : {}),
          },
        })
        if (password) {
          await logUpdate(tx, 'users', id, { passwordHash: '(이전)' }, { passwordHash: '(변경됨)' }, await auditContext(admin, '비밀번호 재설정'))
        }
      })
    } else {
      const dup = await prisma.user.findUnique({ where: { loginId } })
      if (dup) return { error: `이미 있는 아이디입니다: ${loginId}` }
      await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { loginId, name, role, passwordHash: await hashPassword(password) },
        })
        await logCreate(tx, 'users', created.id, { loginId, name, role }, await auditContext(admin))
      })
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidate('/settings/users')
  return { ok: '저장했습니다.' }
}

export async function toggleUserActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requirePermission('settings.manage')
  const id = BigInt(String(formData.get('id')))
  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return { error: '사용자를 찾을 수 없습니다.' }
  if (target.id.toString() === admin.id) return { error: '본인 계정은 비활성화할 수 없습니다.' }

  if (target.isActive && target.role === Role.OWNER) {
    const owners = await prisma.user.count({ where: { role: Role.OWNER, isActive: true } })
    if (owners <= 1) return { error: '마지막 대표 계정은 비활성화할 수 없습니다.' }
  }

  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'users', id, { isActive: target.isActive }, { isActive: !target.isActive }, await auditContext(admin, '계정 사용 여부 변경'))
    await tx.user.update({
      where: { id },
      data: {
        isActive: !target.isActive,
        // 정지하든 되살리든 기존 세션은 무효로 만든다.
        // 정지했는데 열어 둔 창으로 계속 쓸 수 있으면 정지한 의미가 없다.
        sessionsValidFrom: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    })
  })
  revalidate('/settings/users')
  return { ok: target.isActive ? '계정을 비활성화했습니다.' : '계정을 활성화했습니다.' }
}

// ── 전역설정 ─────────────────────────────────────────────────

export async function saveSetting(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const key = String(formData.get('key') ?? '')
  const value = String(formData.get('value') ?? '').trim()
  if (!key) return { error: '설정 항목이 지정되지 않았습니다.' }

  const before = await prisma.setting.findUnique({ where: { key } })
  if (!before) return { error: '설정 항목을 찾을 수 없습니다.' }

  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'settings', BigInt(0), { [key]: before.value }, { [key]: value }, await auditContext(user, `전역설정 ${key} 변경`))
    await tx.setting.update({ where: { key }, data: { value } })
  })

  revalidate('/settings/global')
  return { ok: '저장했습니다.' }
}
