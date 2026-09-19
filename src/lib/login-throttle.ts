/**
 * 로그인 실패 제한.
 *
 * 전에는 「한 계정을 5번 틀리면 15분 잠금」 이었다.
 * 인터넷에 열어 두면 아무나 admin 을 반복해서 틀려 대표님을 못 들어오게 만들 수 있다.
 * 그래서 계정을 통째로 잠그지 않고 「어디서(IP) 누구를(계정)」 단위로 센다.
 *
 *  - 같은 IP 에서 같은 계정: 5번 틀리면 15분
 *  - 같은 IP 에서 아무 계정이나: 20번 틀리면 15분
 *
 * 한 IP 가 막혀도 대표님은 사무실·휴대폰 등 다른 곳에서 들어오실 수 있다.
 * IP 를 못 읽는 환경(검증 스크립트 등)에서는 계정 단위로만 센다.
 */
import { prisma } from './db'

const WINDOW_MIN = 15
const BLOCK_MIN = 15
const PER_ACCOUNT = 5
const PER_IP = 20

export interface ThrottleCheck {
  blocked: boolean
  /** 남은 시간(분). 화면에 내보내지 않는다 — 계정이 있는지 알려주는 단서가 된다 */
  minutesLeft: number
}

function keysFor(loginId: string, ip?: string): { key: string; limit: number }[] {
  const id = loginId.toLowerCase().slice(0, 60)
  if (!ip) return [{ key: `id:${id}`, limit: PER_ACCOUNT }]
  return [
    { key: `id:${id}@${ip}`.slice(0, 160), limit: PER_ACCOUNT },
    { key: `ip:${ip}`.slice(0, 160), limit: PER_IP },
  ]
}

/** 지금 받아도 되는 요청인가 */
export async function checkThrottle(loginId: string, ip?: string): Promise<ThrottleCheck> {
  const now = new Date()
  const rows = await prisma.loginAttempt.findMany({
    where: { key: { in: keysFor(loginId, ip).map((k) => k.key) } },
  })
  let worst = 0
  for (const r of rows) {
    if (r.blockedUntil && r.blockedUntil > now) {
      worst = Math.max(worst, Math.ceil((r.blockedUntil.getTime() - now.getTime()) / 60_000))
    }
  }
  return { blocked: worst > 0, minutesLeft: worst }
}

/** 틀렸다 — 센다. 한도를 넘으면 그 열쇠만 막는다 */
export async function recordFailure(loginId: string, ip?: string): Promise<void> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - WINDOW_MIN * 60_000)

  for (const { key, limit } of keysFor(loginId, ip)) {
    const row = await prisma.loginAttempt.findUnique({ where: { key } })
    // 한참 전 실패는 잊는다 — 어쩌다 한 번 틀린 것까지 쌓아 두지 않는다
    const stale = !row || row.firstAt < windowStart
    const count = stale ? 1 : row.count + 1
    const blocked = count >= limit
    await prisma.loginAttempt.upsert({
      where: { key },
      update: {
        count: blocked ? 0 : count,
        firstAt: stale ? now : row!.firstAt,
        blockedUntil: blocked ? new Date(now.getTime() + BLOCK_MIN * 60_000) : row?.blockedUntil ?? null,
      },
      create: {
        key, count: blocked ? 0 : count, firstAt: now,
        blockedUntil: blocked ? new Date(now.getTime() + BLOCK_MIN * 60_000) : null,
      },
    })
  }
}

/** 들어왔다 — 그 사람 기록을 지운다 */
export async function clearFailures(loginId: string, ip?: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { key: { in: keysFor(loginId, ip).map((k) => k.key) } },
  })
}
