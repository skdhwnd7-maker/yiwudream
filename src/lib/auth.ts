import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import type { Role } from '@prisma/client'
import { testContext } from './request-context'

const COOKIE = 'yd_session'
const MAX_AGE_SEC = 60 * 60 * 12 // 12시간

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET
  if (!s || s.length < 32) {
    throw new Error('AUTH_SECRET 환경변수가 없거나 너무 짧습니다 (32자 이상).')
  }
  return new TextEncoder().encode(s)
}

export interface SessionUser {
  id: string // BigInt는 JSON에 담기지 않으므로 문자열로 다룬다
  loginId: string
  name: string
  role: Role
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10)
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash)

export async function createSession(user: SessionUser): Promise<void> {
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SEC}s`)
    .sign(secret())

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 사내망에서 http로 운영하는 경우가 많다. NODE_ENV로 자동 결정하면
    // http 배포 시 쿠키가 아예 전송되지 않아 로그인이 불가능해진다.
    // HTTPS로 서비스할 때만 COOKIE_SECURE=true 로 켠다.
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: MAX_AGE_SEC,
  })
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export async function getSession(): Promise<SessionUser | null> {
  // 검증 스크립트가 서버 액션을 그대로 부를 수 있게 하는 이음매.
  // 운영 빌드에서는 절대 켜지지 않는다 (request-context.ts 참고)
  const override = testContext()
  if (override) return override.user

  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret())
    return {
      id: String(payload.id),
      loginId: String(payload.loginId),
      name: String(payload.name),
      role: payload.role as Role,
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.error('[auth] 세션 검증 실패:', e)
    return null
  }
}

// 권한 판정은 src/lib/permissions.ts 로 분리했다.
// 클라이언트 컴포넌트가 next/headers 를 끌고 들어오지 않게 하기 위해서다.
export { can, atLeast, ROLE_LABEL, type Permission } from './permissions'
