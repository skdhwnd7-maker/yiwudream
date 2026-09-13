/**
 * 업로드한 엑셀 파일 보관.
 *
 * 미리보기와 실행이 서로 다른 요청이라 파일을 한 번 더 읽어야 한다.
 * 원본을 그대로 두는 편이 안전하다 — 나중에 "그때 뭘 올렸더라" 를 확인할 수 있다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export function uploadDir(): string {
  return process.env.UPLOAD_DIR ?? path.join(process.cwd(), '.uploads')
}

export function filePath(batchId: string | bigint): string {
  return path.join(uploadDir(), `${batchId}.xlsx`)
}

export async function saveUpload(batchId: bigint, bytes: Buffer): Promise<void> {
  await fs.mkdir(uploadDir(), { recursive: true })
  await fs.writeFile(filePath(batchId), bytes)
}

export async function readUpload(batchId: bigint): Promise<Buffer> {
  return fs.readFile(filePath(batchId))
}

export async function hasUpload(batchId: bigint): Promise<boolean> {
  try {
    await fs.access(filePath(batchId))
    return true
  } catch {
    return false
  }
}
