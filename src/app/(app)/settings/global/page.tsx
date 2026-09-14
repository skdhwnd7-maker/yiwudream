import { prisma } from '@/lib/db'
import { saveSetting } from '../actions'
import SettingRow from './SettingRow'

export const dynamic = 'force-dynamic'

const OPTIONS: Record<string, { value: string; label: string }[]> = {
  krw_rounding: [
    { value: 'FLOOR', label: '절사 (FLOOR)' },
    { value: 'ROUND', label: '반올림 (ROUND)' },
    { value: 'CEIL', label: '올림 (CEIL)' },
  ],
  margin_rate_basis: [
    { value: 'REVENUE', label: '매출 대비 (권장)' },
    { value: 'COST', label: '원가 대비' },
  ],
  margin_vat_basis: [
    { value: 'SUPPLY', label: '공급가액 기준 (권장)' },
    { value: 'GROSS', label: '부가세 포함 총액 기준' },
  ],
  base_currency: [
    { value: 'KRW', label: '원 (KRW)' },
    { value: 'CNY', label: '위안 (CNY)' },
  ],
}

export default async function GlobalSettingsPage() {
  const settings = await prisma.setting.findMany({ orderBy: { key: 'asc' } })

  return (
    <div className="space-y-4">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-56">설정 항목</th>
              <th className="w-64">값</th>
              <th>설명</th>
              <th className="w-20"> </th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <SettingRow
                key={s.key}
                action={saveSetting}
                settingKey={s.key}
                value={s.value}
                description={s.description ?? ''}
                options={OPTIONS[s.key]}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
