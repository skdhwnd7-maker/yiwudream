'use client'

import { useState } from 'react'
import { Role } from '@prisma/client'
import { ROLE_LABEL, ROLE_SUMMARY } from '@/lib/permissions'

const ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.STAFF, Role.VIEWER]

/**
 * 권한을 고르면 그 권한이 무엇을 할 수 있고 무엇을 못 하는지 바로 보여 준다.
 * 아이디를 만드는 자리에서 알아야 의미가 있다 — 표를 따로 찾아보게 하면 안 본다.
 */
export default function RolePicker({ defaultRole = Role.STAFF }: { defaultRole?: Role }) {
  const [role, setRole] = useState<Role>(defaultRole)
  const summary = ROLE_SUMMARY[role]

  return (
    <div className="md:col-span-2">
      <label htmlFor="role">권한</label>
      <select id="role" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
      <div className="mt-2 rounded border border-line bg-sunken px-3 py-2 text-xs leading-relaxed">
        <p>
          <span className="text-jade">할 수 있음</span>{' '}
          <span className="text-ink-2">{summary.can.join(' · ')}</span>
        </p>
        {summary.cannot.length > 0 && (
          <p className="mt-1">
            <span className="text-clay">못 함</span>{' '}
            <span className="text-ink-3">{summary.cannot.join(' · ')}</span>
          </p>
        )}
      </div>
    </div>
  )
}
