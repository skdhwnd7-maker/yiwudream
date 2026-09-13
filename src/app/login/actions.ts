'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { AuditAction } from '@prisma/client'
import { prisma } from '@/lib/db'
import { createSession, destroySession, verifyPassword, getSession } from '@/lib/auth'
import { logSystem } from '@/lib/audit'

export type LoginState = { error?: string }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const loginId = String(formData.get('loginId') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!loginId || !password) return { error: '아이디와 비밀번호를 입력하세요.' }

  const user = await prisma.user.findUnique({ where: { loginId } })
  // 아이디 유무를 알려주지 않는다. 메시지를 하나로 통일한다.
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    return { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }
  }

  const session = { id: user.id.toString(), loginId: user.loginId, name: user.name, role: user.role }
  await createSession(session)
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  const h = await headers()
  await logSystem(AuditAction.LOGIN, {
    user: { id: session.id, name: session.name },
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  })

  redirect('/')
}

export async function logoutAction(): Promise<void> {
  const user = await getSession()
  if (user) {
    await logSystem(AuditAction.LOGOUT, { user: { id: user.id, name: user.name } })
  }
  await destroySession()
  redirect('/login')
}
