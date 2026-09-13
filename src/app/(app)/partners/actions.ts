'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma, Route } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, requirePermission, auditContext } from '@/lib/session-guard'
import { logCreate, logUpdate, AuditReasonRequiredError } from '@/lib/audit'
import { normalizeName, normalizeNameForMerge, splitTrailingNumber } from '@/lib/normalize'

export type ActionState = { error?: string; ok?: string }

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : null))

const partnerSchema = z.object({
  name: z.string().trim().min(1, '거래처명을 입력하세요.').max(100),
  bizNo: optionalText(20),
  ceoName: optionalText(50),
  contact: optionalText(50),
  phone: optionalText(30),
  email: optionalText(100),
  defaultRoute: z.nativeEnum(Route).nullable().catch(null),
  defaultDealTypeId: z.string().optional(),
  taxInvoiceDefault: z.boolean(),
  defaultFeeRate: z.string().optional(),
  defaultMarkupRate: z.string().optional(),
  memo: optionalText(2000),
})

function parseForm(formData: FormData) {
  const routeRaw = String(formData.get('defaultRoute') ?? '')
  return partnerSchema.safeParse({
    name: formData.get('name') ?? '',
    bizNo: formData.get('bizNo') ?? '',
    ceoName: formData.get('ceoName') ?? '',
    contact: formData.get('contact') ?? '',
    phone: formData.get('phone') ?? '',
    email: formData.get('email') ?? '',
    defaultRoute: routeRaw && routeRaw in Route ? (routeRaw as Route) : null,
    defaultDealTypeId: String(formData.get('defaultDealTypeId') ?? ''),
    taxInvoiceDefault: formData.get('taxInvoiceDefault') === 'on',
    defaultFeeRate: String(formData.get('defaultFeeRate') ?? ''),
    defaultMarkupRate: String(formData.get('defaultMarkupRate') ?? ''),
    memo: formData.get('memo') ?? '',
  })
}

const decOrNull = (v?: string) => {
  if (!v || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? new Prisma.Decimal(v) : null
}

/** 거래처 코드 자동 채번 — P0001 형식 */
async function nextPartnerCode(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.partner.findFirst({
    where: { code: { startsWith: 'P' } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const n = last ? Number(last.code.slice(1)) + 1 : 1
  return `P${String(n).padStart(4, '0')}`
}

export async function createPartner(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser()
  const parsed = parseForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const d = parsed.data

  // 거래처명에 붙은 꼬리 일련번호를 떼어낸다 (아르미르샵133 → 아르미르샵)
  const { baseName } = splitTrailingNumber(d.name)
  const normalized = normalizeName(baseName)

  const dup = await prisma.partner.findFirst({ where: { nameNormalized: normalized } })
  if (dup) return { error: `이미 등록된 거래처입니다: ${dup.name} (${dup.code})` }

  try {
    await prisma.$transaction(async (tx) => {
      const code = await nextPartnerCode(tx)
      const created = await tx.partner.create({
        data: {
          code,
          name: baseName,
          nameNormalized: normalized,
          bizNo: d.bizNo,
          ceoName: d.ceoName,
          contact: d.contact,
          phone: d.phone,
          email: d.email,
          defaultRoute: d.defaultRoute,
          defaultDealTypeId: d.defaultDealTypeId ? BigInt(d.defaultDealTypeId) : null,
          taxInvoiceDefault: d.taxInvoiceDefault,
          defaultFeeRate: decOrNull(d.defaultFeeRate),
          defaultMarkupRate: decOrNull(d.defaultMarkupRate),
          memo: d.memo,
          createdBy: BigInt(user.id),
        },
      })
      await logCreate(tx, 'partners', created.id, { code, name: baseName, defaultRoute: d.defaultRoute }, await auditContext(user))
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/partners')
  return { ok: `${baseName} 거래처를 등록했습니다.` }
}

export async function updatePartner(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser()
  const id = BigInt(String(formData.get('id')))
  const reason = String(formData.get('reason') ?? '').trim() || undefined

  const parsed = parseForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const d = parsed.data

  const before = await prisma.partner.findUnique({ where: { id } })
  if (!before) return { error: '거래처를 찾을 수 없습니다.' }

  const normalized = normalizeName(d.name)
  const dup = await prisma.partner.findFirst({ where: { nameNormalized: normalized, id: { not: id } } })
  if (dup) return { error: `같은 이름의 거래처가 있습니다: ${dup.name} (${dup.code})` }

  const next = {
    name: d.name,
    nameNormalized: normalized,
    bizNo: d.bizNo,
    ceoName: d.ceoName,
    contact: d.contact,
    phone: d.phone,
    email: d.email,
    defaultRoute: d.defaultRoute,
    defaultDealTypeId: d.defaultDealTypeId ? BigInt(d.defaultDealTypeId) : null,
    taxInvoiceDefault: d.taxInvoiceDefault,
    defaultFeeRate: decOrNull(d.defaultFeeRate),
    defaultMarkupRate: decOrNull(d.defaultMarkupRate),
    memo: d.memo,
  }

  try {
    await prisma.$transaction(async (tx) => {
      await logUpdate(
        tx,
        'partners',
        id,
        {
          name: before.name, bizNo: before.bizNo, ceoName: before.ceoName, contact: before.contact,
          phone: before.phone, email: before.email, defaultRoute: before.defaultRoute,
          defaultDealTypeId: before.defaultDealTypeId, taxInvoiceDefault: before.taxInvoiceDefault,
          defaultFeeRate: before.defaultFeeRate, defaultMarkupRate: before.defaultMarkupRate, memo: before.memo,
        },
        { ...next, nameNormalized: undefined },
        await auditContext(user, reason),
      )
      await tx.partner.update({ where: { id }, data: { ...next, updatedBy: BigInt(user.id) } })
    })
  } catch (e) {
    if (e instanceof AuditReasonRequiredError) return { error: e.message }
    return { error: e instanceof Error ? e.message : '저장 중 오류가 발생했습니다.' }
  }

  revalidatePath('/partners')
  revalidatePath(`/partners/${id}`)
  return { ok: '저장했습니다.' }
}

export async function togglePartnerActive(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const id = BigInt(String(formData.get('id')))
  const partner = await prisma.partner.findUnique({ where: { id } })
  if (!partner) return { error: '거래처를 찾을 수 없습니다.' }

  // 이미 거래가 있으면 비활성화만 가능하다. 삭제는 어떤 경우에도 하지 않는다.
  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'partners', id, { isActive: partner.isActive }, { isActive: !partner.isActive }, await auditContext(user, '거래처 활성 상태 변경'))
    await tx.partner.update({ where: { id }, data: { isActive: !partner.isActive, updatedBy: BigInt(user.id) } })
  })

  revalidatePath('/partners')
  return { ok: partner.isActive ? '비활성 처리했습니다.' : '다시 활성화했습니다.' }
}

/** 별칭 추가 — 엑셀 표기 흔들림(코러스 코리아 / 코러스코리아)을 한 거래처로 묶는다. */
export async function addAlias(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser()
  const partnerId = BigInt(String(formData.get('partnerId')))
  const alias = String(formData.get('alias') ?? '').trim()
  if (!alias) return { error: '별칭을 입력하세요.' }

  const exists = await prisma.partnerAlias.findUnique({ where: { alias }, include: { partner: true } })
  if (exists) {
    return exists.partnerId === partnerId
      ? { error: '이미 등록된 별칭입니다.' }
      : { error: `이 별칭은 이미 ${exists.partner.name}에 등록돼 있습니다.` }
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.partnerAlias.create({
      data: { partnerId, alias, aliasNormalized: normalizeName(alias) },
    })
    await logCreate(tx, 'partner_aliases', created.id, { partnerId: partnerId.toString(), alias }, await auditContext(user))
  })

  revalidatePath(`/partners/${partnerId}`)
  return { ok: `별칭 "${alias}"을 추가했습니다.` }
}

export async function removeAlias(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser()
  const id = BigInt(String(formData.get('aliasId')))
  const alias = await prisma.partnerAlias.findUnique({ where: { id } })
  if (!alias) return { error: '별칭을 찾을 수 없습니다.' }

  await prisma.$transaction(async (tx) => {
    await logUpdate(tx, 'partner_aliases', id, { alias: alias.alias }, { alias: null }, await auditContext(user, '별칭 삭제'))
    await tx.partnerAlias.delete({ where: { id } })
  })

  revalidatePath(`/partners/${alias.partnerId}`)
  return { ok: '별칭을 삭제했습니다.' }
}

/**
 * 병합 후보 조회.
 * 정규화하면 같아지는 거래처를 찾는다 — 끝 일련번호까지 제거한 키로 비교한다.
 */
export async function findMergeCandidates(): Promise<
  { key: string; partners: { id: string; code: string; name: string }[] }[]
> {
  await requireUser()
  const all = await prisma.partner.findMany({
    where: { isActive: true, isInternal: false },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  })

  const buckets = new Map<string, { id: string; code: string; name: string }[]>()
  for (const p of all) {
    const key = normalizeNameForMerge(p.name)
    if (!key) continue
    const list = buckets.get(key) ?? []
    list.push({ id: p.id.toString(), code: p.code, name: p.name })
    buckets.set(key, list)
  }

  return [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, partners]) => ({ key, partners }))
}

/**
 * 거래처 병합 — 흡수되는 쪽의 전표를 전부 옮기고, 이름은 별칭으로 남긴다.
 * 데이터를 지우지 않는다. 옮긴 뒤 흡수된 거래처는 비활성 처리한다.
 */
export async function mergePartners(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const targetId = BigInt(String(formData.get('targetId')))
  const sourceIds = formData.getAll('sourceIds').map((v) => BigInt(String(v)))
  const reason = String(formData.get('reason') ?? '').trim()

  if (sourceIds.length === 0) return { error: '병합할 거래처를 선택하세요.' }
  if (sourceIds.some((s) => s === targetId)) return { error: '대상 거래처는 병합 목록에 넣을 수 없습니다.' }
  if (!reason) return { error: '병합 사유를 입력하세요.' }

  const [target, sources] = await Promise.all([
    prisma.partner.findUnique({ where: { id: targetId } }),
    prisma.partner.findMany({ where: { id: { in: sourceIds } } }),
  ])
  if (!target) return { error: '대상 거래처를 찾을 수 없습니다.' }

  const ctx = await auditContext(user, reason)

  try {
    await prisma.$transaction(async (tx) => {
      for (const src of sources) {
        // 전표를 대상 거래처로 옮긴다
        await tx.order.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })
        await tx.receipt.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })
        await tx.expense.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })
        await tx.invoice.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })
        await tx.remittanceAllocation.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })
        // 예치금 원장은 append-only라 UPDATE가 막혀 있다. 상쇄 후 재기입은 Phase 2에서 다룬다.

        // 원래 이름을 별칭으로 남긴다 — 나중에 역추적할 수 있게
        const already = await tx.partnerAlias.findUnique({ where: { alias: src.name } })
        if (!already) {
          await tx.partnerAlias.create({
            data: { partnerId: targetId, alias: src.name, aliasNormalized: normalizeName(src.name), source: 'MANUAL' },
          })
        }
        await tx.partnerAlias.updateMany({ where: { partnerId: src.id }, data: { partnerId: targetId } })

        await logUpdate(tx, 'partners', src.id, { isActive: src.isActive, mergedInto: null }, { isActive: false, mergedInto: target.code }, ctx)
        await tx.partner.update({
          where: { id: src.id },
          data: { isActive: false, memo: `${src.memo ? src.memo + '\n' : ''}[병합] ${target.name}(${target.code})로 병합됨`, updatedBy: BigInt(user.id) },
        })
      }
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : '병합 중 오류가 발생했습니다.' }
  }

  revalidatePath('/partners')
  return { ok: `${sources.length}개 거래처를 ${target.name}(으)로 병합했습니다.` }
}
