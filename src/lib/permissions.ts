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
  | 'profit.view' // 회사 손익·자금 조회 — 마진, 사용가능 자금, 거래처별 순위
  | 'dashboard.view'
  | 'settings.manage' // 설정·사용자관리
  | 'audit.view' // 변경이력 조회

const MIN_ROLE: Record<Permission, Role> = {
  'transaction.write': 'STAFF',
  'transaction.void': 'MANAGER',
  'remittance.execute': 'MANAGER',
  'invoice.confirm': 'MANAGER',
  'payroll.view': 'MANAGER',
  // 입력만 하는 직원에게 회사 마진과 통장 잔액까지 보일 필요는 없다.
  // 대표님 지시: 「직원들은 입력할 수 있게만」
  'profit.view': 'MANAGER',
  'dashboard.view': 'VIEWER',
  'settings.manage': 'OWNER',
  'audit.view': 'MANAGER',
}

export const can = (role: Role, permission: Permission) => atLeast(role, MIN_ROLE[permission])

/** 아이디를 만들 때 대표님이 무엇을 주는지 알 수 있어야 한다 */
export const ROLE_SUMMARY: Record<Role, { can: string[]; cannot: string[] }> = {
  OWNER: {
    can: ['모든 화면과 모든 기능', '설정·사용자 관리', '엑셀 가져오기'],
    cannot: [],
  },
  MANAGER: {
    can: ['거래 등록·수정·취소', '해외송금 실행', '세금계산서 확정',
      '급여 입력', '회사 손익·자금현황', '변경이력 조회'],
    cannot: ['설정·사용자 관리', '엑셀 가져오기'],
  },
  STAFF: {
    can: ['거래 등록·수정', '거래처 등록', '지출·입금 입력'],
    cannot: ['회사 손익·자금현황', '거래 취소', '해외송금 실행',
      '세금계산서 확정', '급여', '변경이력', '설정'],
  },
  VIEWER: {
    can: ['거래 목록·상세 조회'],
    cannot: ['모든 입력과 수정', '회사 손익·자금현황', '급여', '설정'],
  },
}

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: '대표',
  MANAGER: '매니저',
  STAFF: '직원',
  VIEWER: '조회',
}

export const PERMISSION_MIN_ROLE = MIN_ROLE
