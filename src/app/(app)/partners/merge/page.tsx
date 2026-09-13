import Link from 'next/link'
import { requirePermission } from '@/lib/session-guard'
import { findMergeCandidates } from '../actions'
import MergeForm from './MergeForm'

export const dynamic = 'force-dynamic'

export default async function MergePage() {
  await requirePermission('settings.manage')
  const groups = await findMergeCandidates()

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">거래처 병합 후보</h1>
          <p className="mt-1 text-sm text-ink-muted">
            띄어쓰기나 끝 일련번호만 다른 거래처를 찾았습니다. 자동으로 합치지 않고 확인을 받습니다.
          </p>
        </div>
        <Link href="/partners" className="btn-ghost no-underline">목록으로</Link>
      </header>

      {groups.length === 0 ? (
        <div className="card">
          <div className="card-body text-sm text-ink-muted">
            병합 후보가 없습니다. 이름이 비슷한 거래처가 새로 생기면 여기에 나타납니다.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <MergeForm key={g.key} groupKey={g.key} partners={g.partners} />
          ))}
        </div>
      )}

      <div className="card bg-sunken">
        <div className="card-body hint">
          병합하면 흡수되는 거래처의 주문·입금·지출·세금계산서가 대상 거래처로 옮겨지고,
          원래 이름은 <strong>별칭으로 남습니다</strong>. 데이터를 지우지 않으며 흡수된 거래처는 비활성 처리됩니다.
          모든 과정이 변경이력에 기록됩니다.
        </div>
      </div>
    </div>
  )
}
