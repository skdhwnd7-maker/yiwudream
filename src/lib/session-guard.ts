import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getSession, can, type Permission, type SessionUser } from './auth'
import type { AuditContext } from './audit'

/** 로그인 필수 페이지·액션에서 쓴다. 없으면 로그인 화면으로 보낸다. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSession()
  if (!user) redirect('/login')
  return user
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser()
  if (!can(user.role, permission)) redirect('/?error=forbidden')
  return user
}

/** 서버 액션에서 변경이력 컨텍스트를 만든다. */
export async function auditContext(user: SessionUser, reason?: string): Promise<AuditContext> {
  const h = await headers()
  const ip =
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    undefined
  return { user: { id: user.id, name: user.name }, reason, ipAddress: ip }
}
