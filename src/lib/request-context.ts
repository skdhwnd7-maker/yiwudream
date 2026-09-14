/**
 * 요청 바깥에서 서버 액션을 부를 수 있게 하는 이음매.
 *
 * 검증 스크립트가 화면을 거치지 않고도 진짜 서버 액션(createRemittance 등)을
 * 그대로 호출해 볼 수 있어야 한다. 그래야 「화면에서 실제로 썼을 때」 와 같은 길을 지난다.
 *
 * 운영에서는 절대 켜지지 않는다 — NODE_ENV 가 production 이면 무시하고,
 * 그렇지 않더라도 YD_TEST_CONTEXT=1 을 명시해야만 동작한다.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionUser } from './auth'

export interface TestRequestContext {
  user: SessionUser
  ipAddress?: string
}

const storage = new AsyncLocalStorage<TestRequestContext>()

function enabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.YD_TEST_CONTEXT === '1'
}

/** 지금 검증용 문맥 안인가 */
export function testContext(): TestRequestContext | undefined {
  return enabled() ? storage.getStore() : undefined
}

/** 이 사용자로 로그인한 것처럼 서버 액션을 부른다 */
export function runAsUser<T>(user: SessionUser, fn: () => Promise<T>): Promise<T> {
  if (!enabled()) {
    throw new Error(
      '검증용 문맥은 YD_TEST_CONTEXT=1 이고 운영 빌드가 아닐 때만 쓸 수 있습니다.',
    )
  }
  return storage.run({ user }, fn)
}
