import type { Route, Entity, Currency, CostType, RevenueBasis, InvoiceBase, VatMode, OrderStatus, SplitKind } from '@prisma/client'

export const ROUTE_LABEL: Record<Route, string> = {
  OVERSEAS: '해외송금',
  BANK_GEN: '일반통장',
  BANK_CORP: '법인통장',
  SITE: '사이트통장',
  CASH: '현금',
  OTHER: '기타',
}

export const ENTITY_LABEL: Record<Entity, string> = {
  KR: '한국법인',
  CN: '중국법인',
}

export const CURRENCY_LABEL: Record<Currency, string> = {
  KRW: '원 (KRW)',
  CNY: '위안 (CNY)',
  USD: '달러 (USD)',
}

export const COST_TYPE_LABEL: Record<CostType, string> = {
  ORDER_COST: '주문 원가',
  OPERATING: '운영비',
  BOTH: '둘 다',
}

export const REVENUE_BASIS_LABEL: Record<RevenueBasis, string> = {
  GROSS: '총액',
  NET: '순액 (수수료만)',
}

export const INVOICE_BASE_LABEL: Record<InvoiceBase, string> = {
  NONE: '발행 대상 아님',
  TOTAL_RECEIPT: '주문 총입금액',
  FEE_ONLY: '구매대행 수수료만',
  CUSTOMS_ONLY: '대행통관비만',
  MARGIN: '최종 마진',
  MANUAL: '직접 입력',
}

export const VAT_MODE_LABEL: Record<VatMode, string> = {
  INCLUDED: '부가세 포함',
  EXCLUDED: '부가세 별도',
  EXEMPT: '면세',
  ZERO: '영세율',
  NONE: '부가세 무관',
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: '진행중',
  SETTLED: '정산완료',
  CANCELLED: '취소',
}

export const SPLIT_KIND_LABEL: Record<SplitKind, string> = {
  SALES: '공급가액 (매출)',
  FEE: '구매대행 수수료',
  VAT: '부가세',
  DEPOSIT_GOODS: '상품구매 예치금',
  DEPOSIT_GENERAL: '용도미지정 예치금',
}

/** 돈의 주인 — 화면에서 색을 가르는 기준 */
export const SPLIT_OWNER: Record<SplitKind, '회사' | '고객' | '국세청'> = {
  SALES: '회사',
  FEE: '회사',
  VAT: '국세청',
  DEPOSIT_GOODS: '고객',
  DEPOSIT_GENERAL: '고객',
}

export const ACCOUNTING_CLASSES = [
  '상품매출',
  '용역매출',
  '중개수수료',
  '해외매출',
  '매출아님',
] as const
