/**
 * 캐시 무효화. 요청 바깥(검증 스크립트)에서 불리면 조용히 넘어간다.
 *
 * next/cache 의 revalidatePath 는 요청 밖에서 부르면 던진다.
 * 그것 때문에 서버 액션을 그대로 검증할 수 없게 되면 곤란하다.
 */
import { revalidatePath } from 'next/cache'

export function revalidate(...paths: string[]): void {
  for (const p of paths) {
    try {
      revalidatePath(p)
    } catch {
      // 요청 밖 — 무효화할 캐시가 없다
    }
  }
}
