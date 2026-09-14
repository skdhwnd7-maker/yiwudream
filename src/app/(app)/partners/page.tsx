import Link from 'next/link'
import { requireUser } from '@/lib/session-guard'
import { prisma } from '@/lib/db'
import { EmptyRow } from '@/components/ui'
import { ROUTE_LABEL } from '@/lib/labels'

export const dynamic = 'force-dynamic'

export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; inactive?: string }>
}) {
  await requireUser()
  const sp = await searchParams
  const q = (sp.q ?? '').trim()
  const showInactive = sp.inactive === '1'

  const partners = await prisma.partner.findMany({
    where: {
      isInternal: false,
      ...(showInactive ? {} : { isActive: true }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { code: { contains: q, mode: 'insensitive' as const } },
              { aliases: { some: { alias: { contains: q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    },
    include: {
      defaultDealType: { select: { name: true } },
      _count: { select: { aliases: true, orders: true } },
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    take: 300,
  })

  const internal = await prisma.partner.findMany({ where: { isInternal: true }, select: { id: true, name: true, code: true } })

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title text-xl">거래처 관리</h1>
          <p className="mt-1 text-sm text-ink-muted">
            표기가 다른 이름은 별칭으로 묶습니다. 삭제 대신 비활성 처리합니다.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/partners/merge" className="btn-ghost no-underline">병합 후보 검토</Link>
          <Link href="/partners/new" className="btn-primary no-underline">+ 거래처 등록</Link>
        </div>
      </header>

      <form className="card" method="get">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <label htmlFor="q">검색</label>
            <input id="q" name="q" defaultValue={q} placeholder="거래처명 · 코드 · 별칭" />
          </div>
          <label className="mb-2 flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} className="w-4" />
            비활성 포함
          </label>
          <button type="submit" className="btn-ghost mb-0.5 whitespace-nowrap">검색</button>
        </div>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-20">코드</th>
              <th>거래처명</th>
              <th className="w-28">주 결제루트</th>
              <th className="w-40">기본 거래유형</th>
              <th className="w-20 n">별칭</th>
              <th className="w-20 n">거래</th>
              <th className="w-24">세금계산서</th>
              <th className="w-20">상태</th>
            </tr>
          </thead>
          <tbody>
            {partners.length === 0 && <EmptyRow colSpan={8} label={q ? '검색 결과가 없습니다.' : '등록된 거래처가 없습니다.'} />}
            {partners.map((p) => (
              <tr key={p.id.toString()} className={p.isActive ? '' : 'bg-sunken/60 text-ink-muted'}>
                <td className="num text-xs">{p.code}</td>
                <td>
                  <Link href={`/partners/${p.id}`} className="no-underline hover:underline">{p.name}</Link>
                </td>
                <td className="text-xs">{p.defaultRoute ? ROUTE_LABEL[p.defaultRoute] : '—'}</td>
                <td className="text-xs">{p.defaultDealType?.name ?? '—'}</td>
                <td className="n text-xs">{p._count.aliases || '—'}</td>
                <td className="n text-xs">{p._count.orders || '—'}</td>
                <td className="text-xs">{p.taxInvoiceDefault ? <span className="pill-good">발행</span> : <span className="text-ink-muted">—</span>}</td>
                <td className="text-xs">{p.isActive ? <span className="pill-neutral">활성</span> : <span className="pill-warn">비활성</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}
