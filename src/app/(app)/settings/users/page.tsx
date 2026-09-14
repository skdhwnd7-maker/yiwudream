import Link from 'next/link'
import { Role } from '@prisma/client'
import { prisma } from '@/lib/db'
import { Field } from '@/components/Field'
import { ROLE_LABEL } from '@/lib/auth'
import { fmtDateTime } from '@/lib/serialize'
import { saveUser, toggleUserActive } from '../actions'
import { InlineEditor, AddPanel, ToggleButton } from '../EditableRow'
import RolePicker from './RolePicker'

export const dynamic = 'force-dynamic'

const PERMISSION_ROWS: { label: string; min: Role }[] = [
  { label: '거래 목록·상세 조회', min: Role.VIEWER },
  { label: '거래 등록·수정', min: Role.STAFF },
  { label: '거래처 등록·수정', min: Role.STAFF },
  { label: '회사 손익·자금현황', min: Role.MANAGER },
  { label: '거래 취소', min: Role.MANAGER },
  { label: '해외송금 실행', min: Role.MANAGER },
  { label: '세금계산서 확정', min: Role.MANAGER },
  { label: '급여 조회·입력', min: Role.MANAGER },
  { label: '변경이력 조회', min: Role.MANAGER },
  { label: '설정·사용자관리', min: Role.OWNER },
  { label: '엑셀 가져오기', min: Role.OWNER },
]
const RANK: Record<Role, number> = { VIEWER: 0, STAFF: 1, MANAGER: 2, OWNER: 3 }
const ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.STAFF, Role.VIEWER]

function Fields({ u, isNew }: { u?: { loginId: string; name: string; role: Role }; isNew?: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Field label="아이디" name="loginId" required>
        <input name="loginId" defaultValue={u?.loginId ?? ''} required className="num" autoComplete="off" />
      </Field>
      <Field label="이름" name="name" required>
        <input name="name" defaultValue={u?.name ?? ''} required />
      </Field>
      <Field label={isNew ? '비밀번호' : '비밀번호 재설정'} name="password"
        hint={isNew ? '8자 이상' : '비워두면 그대로 둡니다'}>
        <input name="password" type="password" autoComplete="new-password" minLength={isNew ? 8 : 0} required={isNew} />
      </Field>
      <RolePicker defaultRole={u?.role ?? Role.STAFF} />
    </div>
  )
}

export default async function UsersPage() {
  const users = await prisma.user.findMany({ orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { loginId: 'asc' }] })

  return (
    <div className="space-y-4">
      <AddPanel action={saveUser} title="사용자 등록">
        <Fields isNew />
      </AddPanel>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="w-32">아이디</th>
              <th>이름</th>
              <th className="w-24">권한</th>
              <th className="w-44">최근 로그인</th>
              <th className="w-16">상태</th>
              <th className="w-20"> </th>
              <th className="w-20"> </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <InlineEditor
                key={u.id.toString()}
                action={saveUser}
                summary={
                  <>
                    <td className="num text-xs">{u.loginId}</td>
                    <td className="text-sm">{u.name}</td>
                    <td className="text-xs">
                      <span className={u.role === 'OWNER' ? 'pill-good' : 'pill-neutral'}>{ROLE_LABEL[u.role]}</span>
                    </td>
                    <td className="num text-xs text-ink-muted">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '—'}</td>
                    <td className="text-xs">{u.isActive ? <span className="pill-good">활성</span> : <span className="pill-warn">정지</span>}</td>
                    <td><ToggleButton action={toggleUserActive} id={u.id.toString()} isActive={u.isActive} activeLabel="활성" inactiveLabel="정지" /></td>
                  </>
                }
              >
                <input type="hidden" name="id" value={u.id.toString()} />
                <Fields u={u} />
              </InlineEditor>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head"><h2 className="text-sm font-semibold">권한 범위</h2></div>
        <div className="card-body hint">
          입력만 하실 직원은 <strong>직원</strong>으로 두시면 됩니다 — 거래는 넣고 고칠 수 있지만
          회사 마진과 통장 잔액은 보이지 않습니다.
          누가 무엇을 언제 고쳤는지는 권한과 상관없이 전부{' '}
          <Link href="/audit" className="underline">변경이력</Link>에 남습니다.
        </div>
        <div className="table-wrap border-0">
          <table>
            <thead>
              <tr>
                <th>기능</th>
                {ROLES.map((r) => <th key={r} className="w-20 text-center">{ROLE_LABEL[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_ROWS.map((row) => (
                <tr key={row.label}>
                  <td className="text-sm">{row.label}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="text-center text-sm">
                      {RANK[r] >= RANK[row.min] ? <span className="text-jade">●</span> : <span className="text-line-strong">·</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
