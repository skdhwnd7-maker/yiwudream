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

/** 토큰에만 들어 있는 값 — 화면에서는 쓰지 않는다 */
interface TokenPayload extends SessionUser {
  /** 발급 시각(초). 계정을 정지하거나 비밀번호를 바꾸면 이 값으로 잘라낸다 */
  iat?: number
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10)
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash)

export async function createSession(user: SessionUser): Promise<void> {
  // 검증 문맥에서는 쿠키를 심을 곳이 없다. 토큰만 만들 이유도 없으므로 넘어간다
  if (testContext()) return

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
  if (testContext()) return
  const jar = await cookies()
  jar.delete(COOKIE)
}

/** 토큰만 푼다. 계정 상태는 보지 않는다 — 그건 getSession 이 한다 */
async function readToken(): Promise<TokenPayload | null> {
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
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.error('[auth] 세션 검증 실패:', e)
    return null
  }
}

/**
 * 지금 로그인한 사람.
 *
 * 토큰만 믿으면 안 된다. 토큰은 12시간짜리라, 계정을 정지하거나 권한을 낮춰도
 * 그 사이에는 예전 권한으로 계속 쓸 수 있다. 요청마다 DB에서 다시 확인한다.
 *   · 아직 활성 계정인가
 *   · 지금 권한이 무엇인가 (토큰의 권한이 아니라 DB의 권한을 쓴다)
 *   · 비밀번호 변경·정지 이후에 발급된 토큰인가
 */
export async function getSession(): Promise<SessionUser | null> {
  // 검증 스크립트가 서버 액션을 그대로 부를 수 있게 하는 이음매.
  // 운영 빌드에서는 절대 켜지지 않는다 (request-context.ts 참고)
  const override = testContext()
  if (override) return override.user

  const token = await readToken()
  if (!token) return null

  const { prisma } = await import('./db')
  let row
  try {
    row = await prisma.user.findUnique({
      where: { id: BigInt(token.id) },
      select: { id: true, loginId: true, name: true, role: true, isActive: true, sessionsValidFrom: true },
    })
  } catch {
    return null
  }
  if (!row || !row.isActive) return null

  // 비밀번호를 바꾸거나 계정을 정지했다 되살리면 그 이전 토큰은 무효다.
  // JWT 의 iat 는 초 단위라 1초 여유를 둔다.
  if (token.iat !== undefined) {
    const cutoff = Math.floor(row.sessionsValidFrom.getTime() / 1000)
    if (token.iat + 1 < cutoff) return null
  }

  return {
    id: row.id.toString(),
    loginId: row.loginId,
    name: row.name,
    // 권한은 DB 가 진실이다. 토큰에 박힌 값은 낡았을 수 있다
    role: row.role,
  }
}

// 권한 판정은 src/lib/permissions.ts 로 분리했다.
// 클라이언트 컴포넌트가 next/headers 를 끌고 들어오지 않게 하기 위해서다.
export { can, atLeast, ROLE_LABEL, type Permission } from './permissions'
