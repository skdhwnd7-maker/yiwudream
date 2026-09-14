import { prisma } from '@/lib/db'
import { fmtKrw, fmtCny } from '@/lib/money'
import { fmtDate } from '@/lib/serialize'
import { ENTITY_LABEL, ROUTE_LABEL, CURRENCY_LABEL } from '@/lib/labels'
import { accountBalances } from '@/lib/funds'
import { saveAccount, toggleAccountActive } from '../actions'
import { InlineEditor, AddPanel, ToggleButton } from '../EditableRow'
import AccountFields from './AccountFields'

export const dynamic = 'force-dynamic'

export default async function AccountsPage() {
  const [accounts, balances] = await Promise.all([
    prisma.account.findMany({ orderBy: [{ entity: 'asc' }, { name: 'asc' }] }),
    accountBalances(),
  ])
  // 실제 통장과 대조하시라고 지금 계산된 잔액을 같이 보여 준다
  const balanceOf = new Map(balances.map((b) => [b.id, b.balance.toDecimalPlaces(2).toString()]))

  return (
    <div className="space-y-4">
      <p className="hint">
        계좌 잔액은 저장하지 않고 <strong>기초잔액 + 입금 − 지출 − 송금</strong>으로 항상 다시 계산합니다.
        기초잔액은 시스템 사용을 시작하는 시점의 통장 잔액입니다.
        <br />
        <strong>실제 통장과 대조해 보시고 다르면 그 차액을 기초잔액에 넣어 맞추십시오.</strong>{' '}
        차이가 난다면 시스템에 적히지 않은 돈이 오갔다는 뜻입니다.
      </p>

      <AddPanel action={saveAccount} title="계좌 등록">
        <AccountFields />
      </AddPanel>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>계좌명</th>
              <th className="w-24">자금주체</th>
              <th className="w-28">루트</th>
              <th className="w-24">통화</th>
              <th className="w-36 n">기초잔액</th>
              <th className="w-36 n">현재 계산 잔액</th>
              <th className="w-28">기준일</th>
              <th className="w-16">상태</th>
              <th className="w-20"> </th>
              <th className="w-20"> </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <InlineEditor
                key={a.id.toString()}
                action={saveAccount}
                summary={
                  <>
                    <td className="text-sm">{a.name}</td>
                    <td className="text-xs">
                      <span className={a.entity === 'CN' ? 'pill-warn' : 'pill-neutral'}>{ENTITY_LABEL[a.entity]}</span>
                    </td>
                    <td className="text-xs">{ROUTE_LABEL[a.route]}</td>
                    <td className="text-xs">{CURRENCY_LABEL[a.currency]}</td>
                    <td className="n text-xs">
                      {a.currency === 'KRW' ? fmtKrw(a.openingBalance.toString()) : fmtCny(a.openingBalance.toString())}
                    </td>
                    <td className="n text-xs font-medium">
                      {(() => {
                        const bal = balanceOf.get(a.id.toString())
                        if (!bal) return <span className="text-ink-muted">—</span>
                        return a.currency === 'KRW' ? fmtKrw(bal) : fmtCny(bal)
                      })()}
                    </td>
                    <td className="num text-xs text-ink-muted">{fmtDate(a.openingDate)}</td>
                    <td className="text-xs">{a.isActive ? <span className="pill-good">사용</span> : <span className="pill-warn">중지</span>}</td>
                    <td>
                      <ToggleButton action={toggleAccountActive} id={a.id.toString()} isActive={a.isActive} />
                    </td>
                  </>
                }
              >
                <input type="hidden" name="id" value={a.id.toString()} />
                <AccountFields account={{
                  name: a.name, entity: a.entity, route: a.route, currency: a.currency,
                  bankName: a.bankName ?? '', accountNo: a.accountNo ?? '',
                  openingBalance: a.openingBalance.toString(),
                  openingDate: a.openingDate ? fmtDate(a.openingDate) : '',
                  memo: a.memo ?? '',
                }} showReason />
              </InlineEditor>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
