/**
 * 권한 판정. 서버·클라이언트 양쪽에서 쓰므로 서버 전용 모듈을 import 하지 않는다.
 * 설계 문서: docs/03-데이터베이스설계.md 2-1 권한표
 */
import type { Role } from '@prisma/client'

const RANK: Record<Role, number> = { VIEWER: 0, STAFF: 1, MANAGER: 2, OWNER: 3 }

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min]

export type Permission =
  | 'transaction.write' // 거래 등록·수정
  | 'transaction.void' // 거래 취소
  | 'remittance.execute' // 해외송금 실행
  | 'invoice.confirm' // 세금계산서 확정
  | 'payroll.view' // 급여 조회·입력
  | 'dashboard.view'
  | 'settings.manage' // 설정·사용자관리
  | 'audit.view' // 변경이력 조회

const MIN_ROLE: Record<Permission, Role> = {
  'transaction.write': 'STAFF',
  'transaction.void': 'MANAGER',
  'remittance.execute': 'MANAGER',
  'invoice.confirm': 'MANAGER',
  'payroll.view': 'MANAGER',
  'dashboard.view': 'VIEWER',
  'settings.manage': 'OWNER',
  'audit.view': 'MANAGER',
}

export const can = (role: Role, permission: Permission) => atLeast(role, MIN_ROLE[permission])

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: '대표',
  MANAGER: '매니저',
  STAFF: '직원',
  VIEWER: '조회',
}

export const PERMISSION_MIN_ROLE = MIN_ROLE
