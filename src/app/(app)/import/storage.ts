/**
 * 올린 엑셀 파일 보관.
 *
 * 미리보기와 실행이 서로 다른 요청이라 파일을 한 번 더 읽어야 한다.
 * 원본을 그대로 두는 편이 안전하다 — 나중에 "그때 뭘 올렸더라" 를 확인할 수 있다.
 *
 * 디스크가 아니라 데이터베이스에 둔다.
 * Railway 같은 곳은 새로 배포할 때마다 디스크가 새것으로 바뀌어서,
 * 파일에 두면 올린 원본이 소리 없이 사라진다. 자료가 남는 곳은 DB 뿐이다.
 */
import { prisma } from '@/lib/db'

export async function saveUpload(batchId: bigint, bytes: Buffer): Promise<void> {
  await prisma.importBatch.update({
    where: { id: batchId },
    data: { fileBytes: new Uint8Array(bytes) },
  })
}

export async function readUpload(batchId: bigint): Promise<Buffer> {
  const found = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { fileBytes: true },
  })
  if (!found?.fileBytes) {
    throw new Error(`올린 파일을 찾지 못했습니다 (가져오기 ${batchId}).`)
  }
  return Buffer.from(found.fileBytes)
}

export async function hasUpload(batchId: bigint): Promise<boolean> {
  const found = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { fileBytes: true },
  })
  return Boolean(found?.fileBytes)
}
