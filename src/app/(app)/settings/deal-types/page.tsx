import { prisma } from '@/lib/db'
import { REVENUE_BASIS_LABEL, INVOICE_BASE_LABEL, VAT_MODE_LABEL, ROUTE_LABEL } from '@/lib/labels'
import { saveDealType } from '../actions'
import { InlineEditor, AddPanel } from '../EditableRow'
import DealTypeFields from './DealTypeFields'

export const dynamic = 'force-dynamic'

export default async function DealTypesPage() {
  const dealTypes = await prisma.dealType.findMany({ orderBy: { sortOrder: 'asc' } })

  return (
    <div className="space-y-4">
      <div className="card border-jade bg-jade-soft">
        <div className="card-body text-sm leading-relaxed text-ink-2">
          <p className="font-medium text-jade">세무 규칙은 코드가 아니라 여기서 정합니다.</p>
          <p className="mt-1.5">
            세금계산서 대상금액과 부가세 방식을 프로그램에 박아 넣지 않았습니다.
            처리 방식이 바뀌면 개발 없이 이 화면에서 고치면 됩니다.
            <strong>거래형태와 회계분류는 따로 저장</strong>되므로, 계산서를 안 끊어도 회계상 매출로 잡을 수 있습니다.
          </p>
        </div>
      </div>

      <AddPanel action={saveDealType} title="거래유형 등록">
        <DealTypeFields />
      </AddPanel>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>거래유형</th>
              <th className="w-24">매출인식</th>
              <th className="w-36">계산서 대상금액</th>
              <th className="w-16">기본발행</th>
              <th className="w-28">부가세</th>
              <th className="w-24">회계분류</th>
              <th className="w-24">기본루트</th>
              <th className="w-20"> </th>
            </tr>
          </thead>
          <tbody>
            {dealTypes.map((d) => (
              <InlineEditor
                key={d.id.toString()}
                action={saveDealType}
                summary={
                  <>
                    <td>
                      <p className="text-sm">{d.name}</p>
                      <p className="num text-[11px] text-ink-muted">{d.code}</p>
                      {d.memo && <p className="mt-1 max-w-md text-[11px] leading-relaxed text-ink-muted">{d.memo}</p>}
                    </td>
                    <td className="text-xs">
                      <span className={d.revenueBasis === 'NET' ? 'pill-warn' : 'pill-neutral'}>
                        {REVENUE_BASIS_LABEL[d.revenueBasis]}
                      </span>
                    </td>
                    <td className="text-xs">{INVOICE_BASE_LABEL[d.invoiceBase]}</td>
                    <td className="text-xs">{d.invoiceDefault ? <span className="pill-good">발행</span> : <span className="text-ink-muted">—</span>}</td>
                    <td className="text-xs">
                      <span className={d.vatMode === 'NONE' || d.vatMode === 'EXEMPT' ? 'text-ink-muted' : 'pill-gold'}>
                        {VAT_MODE_LABEL[d.vatMode]}
                      </span>
                    </td>
                    <td className="text-xs">{d.accountingClass}</td>
                    <td className="text-xs">{d.defaultRoute ? ROUTE_LABEL[d.defaultRoute] : '—'}</td>
                  </>
                }
              >
                <input type="hidden" name="id" value={d.id.toString()} />
                <DealTypeFields d={{
                  code: d.code, name: d.name, revenueBasis: d.revenueBasis, invoiceBase: d.invoiceBase,
                  invoiceDefault: d.invoiceDefault, vatMode: d.vatMode, vatRate: d.vatRate.toString(),
                  rounding: d.rounding, accountingClass: d.accountingClass,
                  defaultRoute: d.defaultRoute ?? '', sortOrder: d.sortOrder, memo: d.memo ?? '',
                }} showReason />
              </InlineEditor>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
