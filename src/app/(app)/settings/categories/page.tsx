import { Entity, Currency, CostType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { Field } from '@/components/Field'
import { COST_TYPE_LABEL, ENTITY_LABEL, CURRENCY_LABEL } from '@/lib/labels'
import { saveCategory } from '../actions'
import { InlineEditor, AddPanel } from '../EditableRow'

export const dynamic = 'force-dynamic'

function Fields({ c }: { c?: { code: string; name: string; costType: CostType; defaultEntity: Entity; defaultCurrency: Currency; sortOrder: number } }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="코드" name="code" required hint="영문 대문자·밑줄">
        <input name="code" defaultValue={c?.code ?? ''} required className="num uppercase" placeholder="INSPECT" />
      </Field>
      <Field label="분류명" name="name" required className="md:col-span-2">
        <input name="name" defaultValue={c?.name ?? ''} required placeholder="검품비" />
      </Field>
      <Field label="원가성" name="costType" hint="주문 원가 / 운영비 / 둘 다">
        <select name="costType" defaultValue={c?.costType ?? CostType.ORDER_COST}>
          {Object.values(CostType).map((t) => <option key={t} value={t}>{COST_TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      <Field label="기본 자금주체" name="defaultEntity">
        <select name="defaultEntity" defaultValue={c?.defaultEntity ?? Entity.CN}>
          {Object.values(Entity).map((e) => <option key={e} value={e}>{ENTITY_LABEL[e]}</option>)}
        </select>
      </Field>
      <Field label="기본 통화" name="defaultCurrency">
        <select name="defaultCurrency" defaultValue={c?.defaultCurrency ?? Currency.CNY}>
          {Object.values(Currency).map((cu) => <option key={cu} value={cu}>{CURRENCY_LABEL[cu]}</option>)}
        </select>
      </Field>
      <Field label="정렬 순서" name="sortOrder">
        <input name="sortOrder" type="number" defaultValue={c?.sortOrder ?? 0} className="num" />
      </Field>
    </div>
  )
}

export default async function CategoriesPage() {
  const categories = await prisma.expenseCategory.findMany({ orderBy: { sortOrder: 'asc' } })

  return (
    <div className="space-y-4">
      <p className="hint">
        <strong>원가성</strong>이 「주문 원가」면 주문에 귀속되고, 「운영비」면 중국 운영비로 집계됩니다.
        「둘 다」인 분류는 지출 입력 시 <strong>귀속 주문을 채우면 원가, 비우면 운영비</strong>가 됩니다.
        임시공이 대표적입니다.
      </p>

      <AddPanel action={saveCategory} title="비용분류 등록">
        <Fields />
      </AddPanel>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-32">코드</th>
              <th>분류명</th>
              <th className="w-28">원가성</th>
              <th className="w-24">자금주체</th>
              <th className="w-28">기본통화</th>
              <th className="w-16 n">순서</th>
              <th className="w-20"> </th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <InlineEditor
                key={c.id.toString()}
                action={saveCategory}
                summary={
                  <>
                    <td className="num text-xs">{c.code}</td>
                    <td className="text-sm">{c.name}</td>
                    <td className="text-xs">
                      <span className={c.costType === 'OPERATING' ? 'pill-neutral' : c.costType === 'BOTH' ? 'pill-gold' : 'pill-good'}>
                        {COST_TYPE_LABEL[c.costType]}
                      </span>
                    </td>
                    <td className="text-xs">{ENTITY_LABEL[c.defaultEntity]}</td>
                    <td className="text-xs">{CURRENCY_LABEL[c.defaultCurrency]}</td>
                    <td className="n text-xs text-ink-muted">{c.sortOrder}</td>
                  </>
                }
              >
                <input type="hidden" name="id" value={c.id.toString()} />
                <Fields c={c} />
              </InlineEditor>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
