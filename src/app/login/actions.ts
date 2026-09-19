'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { AuditAction } from '@prisma/client'
import { prisma } from '@/lib/db'
import { createSession, destroySession, verifyPassword, getSession } from '@/lib/auth'
import { logSystem } from '@/lib/audit'
import { testContext } from '@/lib/request-context'
import { checkThrottle, recordFailure, clearFailures } from '@/lib/login-throttle'

export type LoginState = { error?: string }

/** 같은 답만 돌려준다 — 아이디가 있는지 없는지, 잠겼는지 알려주지 않는다 */
const WRONG = { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }

/** 요청 밖(검증)에서는 헤더가 없다. 그때는 IP 를 비운다 */
async function clientIp(): Promise<string | undefined> {
  if (testContext()) return undefined
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? h.get('x-real-ip')
    ?? undefined
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const loginId = String(formData.get('loginId') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!loginId || !password) return { error: '아이디와 비밀번호를 입력하세요.' }

  const ip = await clientIp()

  // 너무 여러 번 틀린 곳이면 비밀번호를 보지도 않는다.
  // 답은 틀렸을 때와 똑같다 — 계정이 있는지 없는지 단서를 주지 않는다.
  const gate = await checkThrottle(loginId, ip)
  if (gate.blocked) {
    // 누가 시도했는지 모르는 상태라 변경이력(사용자 연결)에는 남기지 않는다.
    // 차단 기록 자체는 login_attempts 에 남는다.
    return {
      error: '로그인 시도가 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.',
    }
  }

  const user = await prisma.user.findUnique({ where: { loginId } })
  const ok = !!user && user.isActive && await verifyPassword(password, user.passwordHash)

  if (!ok) {
    await recordFailure(loginId, ip)
    // 아이디가 틀렸든 비밀번호가 틀렸든 잠겼든 문구가 같아야 한다.
    // "N번 더 틀리면 잠깁니다" 같은 안내는 그 아이디가 있다는 뜻이 된다.
    return WRONG
  }

  await clearFailures(loginId, ip)

  const session = { id: user.id.toString(), loginId: user.loginId, name: user.name, role: user.role }
  await createSession(session)
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  })

  await logSystem(AuditAction.LOGIN, {
    user: { id: session.id, name: session.name },
    ipAddress: ip,
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
