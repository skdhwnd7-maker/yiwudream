-- 개발/시연용 초기화. 마스터(users, settings, deal_types, expense_categories, accounts)는 유지하지 않고
-- 전체를 비운 뒤 기본 시드를 다시 돌린다. 운영 DB 에서는 절대 실행하지 말 것.
TRUNCATE TABLE
  attachments, change_logs, deposit_ledger, expense_allocations, expenses,
  fx_rate_refs, import_rows, import_batches, internal_transfers,
  invoice_orders, invoices, orders, partner_aliases, partners, payrolls,
  receipt_splits, receipts, remittance_allocations, remittances,
  employees, number_counters, accounts, deal_types, expense_categories, settings, users
RESTART IDENTITY CASCADE;
