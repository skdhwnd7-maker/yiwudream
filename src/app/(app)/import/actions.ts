'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ImportStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requirePermission, auditContext } from '@/lib/session-guard'
import { readWorkbook } from '@/lib/excel/read'
import {
  buildPlan, SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS,
  type PlanOptions,
} from '@/lib/excel/plan'
import { commitPlan, rollbackBatch } from '@/lib/excel/commit'
import { saveUpload, readUpload } from './storage'

export interface ActionState { error?: string; ok?: string }

const MAX_BYTES = 30 * 1024 * 1024

/** STEP 1 — 업로드. 파일을 저장하고 배치를 연다 */
export async function uploadFile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { error: '엑셀 파일을 선택하세요.' }
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return { error: '.xlsx 파일만 읽을 수 있습니다. 엑셀에서 "Excel 통합 문서"로 저장해 주세요.' }
  }
  if (file.size > MAX_BYTES) {
    return { error: `파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB). 30MB 이하만 올릴 수 있습니다.` }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  // 읽을 수 있는 파일인지 먼저 확인한다 — 배치를 만들어 놓고 실패하면 찌꺼기가 남는다
  try {
    await readWorkbook(bytes)
  } catch {
    return { error: '엑셀 파일을 읽지 못했습니다. 파일이 손상되었거나 .xlsx 형식이 아닙니다.' }
  }

  const batch = await prisma.importBatch.create({
    data: { fileName: file.name, status: ImportStatus.UPLOADED, uploadedBy: BigInt(user.id) },
  })
  await saveUpload(batch.id, bytes)

  revalidatePath('/import')
  redirect(`/import/${batch.id}`)
}

/** STEP 6 — 실행 */
export async function runImport(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const batchId = BigInt(String(formData.get('batchId') ?? '0'))
  if (!batchId) return { error: '배치를 찾을 수 없습니다.' }

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } })
  if (!batch) return { error: '배치를 찾을 수 없습니다.' }
  if (batch.status === ImportStatus.COMMITTED) {
    return { error: '이미 가져온 배치입니다. 다시 넣으려면 먼저 되돌리세요.' }
  }

  const opts = readOptions(formData)
  if (!opts.payrollYm && opts.sheets.includes(SHEET_OPS)) {
    return { error: '급여 귀속월을 정해 주세요. 엑셀은 `9月总合` 인데 내용은 12~2월이 섞여 있습니다.' }
  }
  if (!opts.cnyDisplayRate || !(Number(opts.cnyDisplayRate) > 0)) {
    return { error: '해외송금(CNY)을 원화로 보여줄 환산환율을 넣어 주세요. 마진 계산에는 쓰지 않습니다.' }
  }

  try {
    const bytes = await readUpload(batchId)
    const wb = await readWorkbook(bytes)
    const plan = buildPlan(wb, opts)
    const ctx = await auditContext(user, `엑셀 가져오기 — ${batch.fileName}`)
    // 앞서 UPLOADED 로 만들어 둔 빈 배치는 지우고, commitPlan 이 자기 배치를 새로 연다
    await prisma.importBatch.delete({ where: { id: batchId } })
    const result = await commitPlan(wb, plan, opts, batch.fileName, BigInt(user.id), ctx)
    await saveUpload(BigInt(result.batchId), bytes)
    revalidatePath('/import')
    redirect(`/import/${result.batchId}`)
  } catch (e) {
    // redirect 는 예외로 동작하므로 그대로 흘려보낸다
    if (e && typeof e === 'object' && 'digest' in e
      && String((e as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT')) throw e
    return { error: e instanceof Error ? e.message : '가져오는 중 오류가 발생했습니다.' }
  }
  return {}
}

/** 폼 값에서 가져오기 기준을 읽는다 */
function readOptions(fd: FormData): PlanOptions {
  const get = (k: string) => {
    const v = fd.get(k)
    return typeof v === 'string' ? v : null
  }
  const sheets = fd.getAll('sheets').filter((v): v is string => typeof v === 'string')
  const year = Number(get('opsBaseYear'))
  return {
    sheets: sheets.length ? sheets : [SHEET_OVERSEAS, SHEET_GENERAL, SHEET_CORP, SHEET_OPS],
    opsBaseYear: Number.isFinite(year) && year > 2000 && year < 2100 ? year : new Date().getFullYear(),
    payrollYm: /^\d{4}-\d{2}$/.test(get('payrollYm') ?? '') ? get('payrollYm')! : '',
    cnyDisplayRate: get('cnyDisplayRate') ?? '',
  }
}

/** 되돌리기 */
export async function undoImport(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requirePermission('settings.manage')
  const batchId = BigInt(String(formData.get('batchId') ?? '0'))
  const reason = String(formData.get('reason') ?? '').trim()
  if (!batchId) return { error: '배치를 찾을 수 없습니다.' }
  if (reason.length < 2) return { error: '되돌리는 이유를 적어 주세요. 변경이력에 남습니다.' }

  try {
    const ctx = await auditContext(user, reason)
    const r = await rollbackBatch(batchId, ctx)
    revalidatePath('/import')
    return {
      ok: `되돌렸습니다 — 주문 ${r.orders} · 입금 ${r.receipts} · 지출 ${r.expenses} · `
        + `세금계산서 ${r.invoices} · 자금이동 ${r.transfers} · 급여 ${r.payrolls}건.`
        + (r.keptPartners || r.keptEmployees
          ? ` 다른 자료에 쓰이고 있는 거래처 ${r.keptPartners}곳, 직원 ${r.keptEmployees}명은 남겼습니다.`
          : ''),
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '되돌리는 중 오류가 발생했습니다.' }
  }
}
