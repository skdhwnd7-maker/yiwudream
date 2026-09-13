import Link from 'next/link'
import { ImportStatus } from '@prisma/client'
import { requirePermission } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { fmtDate } from '@/lib/serialize'
import UploadForm from './UploadForm'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<ImportStatus, string> = {
  UPLOADED: '올림 — 확인 대기',
  MAPPED: '매핑 완료',
  VALIDATED: '검증 완료',
  COMMITTED: '가져옴',
  ROLLED_BACK: '되돌림',
}

const STATUS_PILL: Record<ImportStatus, string> = {
  UPLOADED: 'pill-neutral',
  MAPPED: 'pill-neutral',
  VALIDATED: 'pill-neutral',
  COMMITTED: 'pill-good',
  ROLLED_BACK: 'pill-warn',
}

export default async function ImportPage() {
  await requirePermission('settings.manage')
  const batches = await prisma.importBatch.findMany({
    orderBy: { id: 'desc' },
    take: 30,
    include: { _count: { select: { rows: true } } },
  })

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="section-title text-xl">엑셀 가져오기</h1>
        <p className="mt-1 text-sm text-ink-muted">
          지금 쓰시는 엑셀을 그대로 읽어 옵니다. 원본 행과 수식을 통째로 보관하므로
          「엑셀 몇 번째 줄이 어느 주문이 됐는지」 나중에도 되짚을 수 있습니다.
        </p>
      </header>

      <div className="card bg-sunken">
        <div className="card-body hint space-y-1">
          <p>1. 파일을 올리면 시트를 훑어 무엇이 들어갈지 보여 드립니다.</p>
          <p>2. 대조표로 엑셀 합계와 시스템 합계를 나란히 확인하십니다.</p>
          <p>3. 확인하신 뒤 실행합니다. 아니다 싶으면 배치째 되돌릴 수 있습니다.</p>
        </div>
      </div>

      <UploadForm />

      <div className="card">
        <div className="card-head">
          <h2 className="text-sm font-semibold">가져오기 이력</h2>
        </div>
        {batches.length === 0 ? (
          <div className="card-body text-sm text-ink-muted">아직 가져온 파일이 없습니다.</div>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th className="w-16">번호</th>
                  <th>파일</th>
                  <th className="w-28">상태</th>
                  <th className="w-20 text-right">원본 행</th>
                  <th className="w-32">올린 날</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id.toString()}>
                    <td className="font-mono text-xs">{b.id.toString()}</td>
                    <td>
                      <Link href={`/import/${b.id}`} className="hover:underline">{b.fileName}</Link>
                    </td>
                    <td><span className={STATUS_PILL[b.status]}>{STATUS_LABEL[b.status]}</span></td>
                    <td className="text-right font-mono text-xs">{b._count.rows.toLocaleString('ko-KR')}</td>
                    <td className="text-xs text-ink-muted">{fmtDate(b.uploadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
