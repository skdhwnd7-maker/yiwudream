'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { AuditAction } from '@prisma/client'
import { prisma } from '@/lib/db'
import { createSession, destroySession, verifyPassword, getSession } from '@/lib/auth'
import { logSystem } from '@/lib/audit'
import { testContext } from '@/lib/request-context'

export type LoginState = { error?: string }

/** 연속으로 이만큼 틀리면 잠근다 */
const MAX_ATTEMPTS = 5
/** 잠기는 시간(분) */
const LOCK_MINUTES = 15

/** 요청 밖(검증)에서는 헤더가 없다. 그때는 IP 를 비운다 */
async function clientIp(): Promise<string | undefined> {
  if (testContext()) return undefined
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? h.get('x-real-ip')
    ?? undefined
}

/** 같은 답만 돌려준다 — 아이디가 있는지 없는지 알려주지 않는다 */
const WRONG = { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const loginId = String(formData.get('loginId') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!loginId || !password) return { error: '아이디와 비밀번호를 입력하세요.' }

  const user = await prisma.user.findUnique({ where: { loginId } })

  // 계정이 잠겨 있으면 비밀번호가 맞아도 받지 않는다
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const left = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
    await logSystem(AuditAction.LOGIN, {
      user: { id: user.id.toString(), name: user.name },
      reason: `잠긴 계정에 로그인 시도 (${left}분 남음)`,
    })
    return {
      error: `비밀번호를 여러 번 틀려 계정이 잠겼습니다. ${left}분 뒤에 다시 시도하거나`
        + ' 대표님께 비밀번호 재설정을 요청하세요.',
    }
  }

  const ok = !!user && user.isActive && await verifyPassword(password, user.passwordHash)

  if (!ok) {
    // 아이디가 없으면 셀 것도 없다. 있으면 실패 횟수를 올리고 한도를 넘으면 잠근다
    if (user) {
      const count = user.failedLoginCount + 1
      const lock = count >= MAX_ATTEMPTS
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : count,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
        },
      })
      if (lock) {
        await logSystem(AuditAction.LOGIN, {
          user: { id: user.id.toString(), name: user.name },
          reason: `연속 ${MAX_ATTEMPTS}회 실패로 ${LOCK_MINUTES}분 잠금`,
        })
        return {
          error: `비밀번호를 ${MAX_ATTEMPTS}번 틀려 계정을 ${LOCK_MINUTES}분간 잠갔습니다.`,
        }
      }
      const left = MAX_ATTEMPTS - count
      return { error: `${WRONG.error} (${left}번 더 틀리면 계정이 잠깁니다)` }
    }
    return WRONG
  }

  const session = { id: user.id.toString(), loginId: user.loginId, name: user.name, role: user.role }
  await createSession(session)
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  })

  await logSystem(AuditAction.LOGIN, {
    user: { id: session.id, name: session.name },
    ipAddress: await clientIp(),
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
