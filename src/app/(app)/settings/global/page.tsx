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
    { value: 'COST', label: '원가 대비 (기존 엑셀 방식)' },
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
      <div className="card border-gold bg-gold-soft">
        <div className="card-body text-sm leading-relaxed text-ink-2">
          <p className="font-medium text-gold">마진율 분모에 관하여</p>
          <p className="mt-1.5">
            기존 엑셀은 마진율을 <strong>마진 ÷ 지출금액</strong>으로 계산하고 있었습니다(1,047개 셀 전부).
            이는 매출 대비 마진율이 아니라 원가 대비 수익률입니다.
            시스템 기본값은 <strong>매출 대비</strong>이고, 엑셀과 같은 값도 보조 컬럼으로 함께 보여드립니다.
          </p>
        </div>
      </div>

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
