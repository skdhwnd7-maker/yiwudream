-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'STAFF', 'VIEWER');

-- CreateEnum
CREATE TYPE "Entity" AS ENUM ('KR', 'CN');

-- CreateEnum
CREATE TYPE "Route" AS ENUM ('OVERSEAS', 'BANK_GEN', 'BANK_CORP', 'SITE', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('KRW', 'CNY', 'USD');

-- CreateEnum
CREATE TYPE "CostType" AS ENUM ('ORDER_COST', 'OPERATING', 'BOTH');

-- CreateEnum
CREATE TYPE "RevenueBasis" AS ENUM ('GROSS', 'NET');

-- CreateEnum
CREATE TYPE "InvoiceBase" AS ENUM ('NONE', 'TOTAL_RECEIPT', 'FEE_ONLY', 'CUSTOMS_ONLY', 'MARGIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "VatMode" AS ENUM ('INCLUDED', 'EXCLUDED', 'EXEMPT', 'ZERO', 'NONE');

-- CreateEnum
CREATE TYPE "Rounding" AS ENUM ('ROUND', 'FLOOR', 'CEIL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('NONE', 'PENDING', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('DIRECT', 'FROM_DEPOSIT');

-- CreateEnum
CREATE TYPE "SplitKind" AS ENUM ('SALES', 'FEE', 'VAT', 'DEPOSIT_GOODS', 'DEPOSIT_GENERAL');

-- CreateEnum
CREATE TYPE "DepositKind" AS ENUM ('GOODS_FUND', 'GENERAL');

-- CreateEnum
CREATE TYPE "DepositMovement" AS ENUM ('IN_RECEIPT', 'USE_ORDER', 'USE_REMIT', 'REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PLANNED', 'PAID');

-- CreateEnum
CREATE TYPE "RemitStatus" AS ENUM ('DRAFT', 'SENT', 'ARRIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VatPeriodStatus" AS ENUM ('OPEN', 'FILED', 'PAID');

-- CreateEnum
CREATE TYPE "FxSource" AS ENUM ('MANUAL', 'PARSED', 'REF');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'VOID', 'RESTORE', 'SETTLE', 'UNLOCK', 'IMPORT', 'LOGIN', 'LOGOUT', 'EXPORT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'MAPPED', 'VALIDATED', 'COMMITTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('OK', 'WARN', 'ERROR', 'SKIP', 'HOLD');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "login_id" VARCHAR(50) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "sessions_valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_normalized" VARCHAR(100) NOT NULL,
    "biz_no" VARCHAR(20),
    "ceo_name" VARCHAR(50),
    "contact" VARCHAR(50),
    "phone" VARCHAR(30),
    "email" VARCHAR(100),
    "default_route" "Route",
    "default_deal_type_id" BIGINT,
    "tax_invoice_default" BOOLEAN NOT NULL DEFAULT false,
    "default_fee_rate" DECIMAL(7,4),
    "default_markup_rate" DECIMAL(7,4),
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_aliases" (
    "id" BIGSERIAL NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "alias" VARCHAR(100) NOT NULL,
    "alias_normalized" VARCHAR(100) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "entity" "Entity" NOT NULL,
    "route" "Route" NOT NULL,
    "currency" "Currency" NOT NULL,
    "bank_name" VARCHAR(50),
    "account_no" VARCHAR(50),
    "opening_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "opening_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "cost_type" "CostType" NOT NULL,
    "default_entity" "Entity" NOT NULL DEFAULT 'CN',
    "default_currency" "Currency" NOT NULL DEFAULT 'CNY',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_types" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "revenue_basis" "RevenueBasis" NOT NULL,
    "invoice_base" "InvoiceBase" NOT NULL,
    "invoice_default" BOOLEAN NOT NULL DEFAULT false,
    "vat_mode" "VatMode" NOT NULL,
    "vat_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    "rounding" "Rounding" NOT NULL DEFAULT 'FLOOR',
    "accounting_class" VARCHAR(30) NOT NULL,
    "default_route" "Route",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,

    CONSTRAINT "deal_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "key" VARCHAR(160) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_until" TIMESTAMPTZ(6),

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(50) NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" VARCHAR(20) NOT NULL DEFAULT 'string',
    "description" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" BIGSERIAL NOT NULL,
    "order_no" VARCHAR(20) NOT NULL,
    "external_ref" VARCHAR(50),
    "partner_id" BIGINT NOT NULL,
    "route" "Route" NOT NULL,
    "deal_type_id" BIGINT NOT NULL,
    "accounting_class" VARCHAR(30) NOT NULL,
    "entity" "Entity" NOT NULL,
    "settlement_currency" "Currency" NOT NULL,
    "title" VARCHAR(200),
    "order_date" DATE NOT NULL,
    "order_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "settled_at" TIMESTAMPTZ(6),
    "settled_by" BIGINT,
    "settled_margin" DECIMAL(18,2),
    "invoice_status" "InvoiceStatus" NOT NULL DEFAULT 'NONE',
    "usd_invoice_amount" DECIMAL(18,2),
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "voided_by" BIGINT,
    "voided_at" TIMESTAMPTZ(6),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" BIGSERIAL NOT NULL,
    "receipt_no" VARCHAR(20) NOT NULL,
    "order_id" BIGINT,
    "partner_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "route" "Route" NOT NULL,
    "entity" "Entity" NOT NULL,
    "receipt_date" DATE NOT NULL,
    "receipt_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "source" "ReceiptSource" NOT NULL DEFAULT 'DIRECT',
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fx_rate" DECIMAL(18,6),
    "fx_rate_source" "FxSource" NOT NULL DEFAULT 'MANUAL',
    "amount_krw" DECIMAL(18,2) NOT NULL,
    "amount_cny" DECIMAL(18,2),
    "usd_amount" DECIMAL(18,2),
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "voided_by" BIGINT,
    "voided_at" TIMESTAMPTZ(6),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_splits" (
    "id" BIGSERIAL NOT NULL,
    "receipt_id" BIGINT NOT NULL,
    "split_kind" "SplitKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "amount_krw" DECIMAL(18,2) NOT NULL,
    "amount_cny" DECIMAL(18,2),

    CONSTRAINT "receipt_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_ledger" (
    "id" BIGSERIAL NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "deposit_kind" "DepositKind" NOT NULL,
    "movement" "DepositMovement" NOT NULL,
    "amount_krw" DECIMAL(18,2) NOT NULL,
    "movement_date" DATE NOT NULL,
    "ref_table" VARCHAR(50),
    "ref_id" BIGINT,
    "order_id" BIGINT,
    "reason" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" BIGSERIAL NOT NULL,
    "expense_no" VARCHAR(20) NOT NULL,
    "entity" "Entity" NOT NULL,
    "expense_date" DATE NOT NULL,
    "expense_date_estimated" BOOLEAN NOT NULL DEFAULT false,
    "category_id" BIGINT NOT NULL,
    "partner_id" BIGINT,
    "vendor_name" VARCHAR(100),
    "account_id" BIGINT,
    "payment_method" VARCHAR(20),
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fx_rate" DECIMAL(18,6),
    "fx_rate_source" "FxSource" NOT NULL DEFAULT 'MANUAL',
    "amount_krw" DECIMAL(18,2) NOT NULL,
    "amount_cny" DECIMAL(18,2),
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "paid_at" DATE,
    "work_period_from" DATE,
    "work_period_to" DATE,
    "work_desc" VARCHAR(200),
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "voided_by" BIGINT,
    "voided_at" TIMESTAMPTZ(6),
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_allocations" (
    "id" BIGSERIAL NOT NULL,
    "expense_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "alloc_amount" DECIMAL(18,2) NOT NULL,
    "alloc_krw" DECIMAL(18,2) NOT NULL,
    "alloc_cny" DECIMAL(18,2),
    "alloc_basis" VARCHAR(20) NOT NULL DEFAULT 'AMOUNT',
    "memo" TEXT,

    CONSTRAINT "expense_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remittances" (
    "id" BIGSERIAL NOT NULL,
    "remit_no" VARCHAR(20) NOT NULL,
    "remit_date" DATE NOT NULL,
    "from_account_id" BIGINT NOT NULL,
    "to_account_id" BIGINT NOT NULL,
    "krw_amount" DECIMAL(18,2) NOT NULL,
    "usd_amount" DECIMAL(18,2),
    "cny_arrival_amount" DECIMAL(18,2),
    "fx_rate_krw_usd" DECIMAL(18,6),
    "fx_rate_usd_cny" DECIMAL(18,6),
    "fx_rate_krw_cny" DECIMAL(18,6),
    "bank_fee_krw" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "RemitStatus" NOT NULL DEFAULT 'DRAFT',
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "remittances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remittance_allocations" (
    "id" BIGSERIAL NOT NULL,
    "remittance_id" BIGINT NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "order_id" BIGINT,
    "alloc_krw" DECIMAL(18,2) NOT NULL,
    "alloc_cny" DECIMAL(18,2),
    "memo" TEXT,

    CONSTRAINT "remittance_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_transfers" (
    "id" BIGSERIAL NOT NULL,
    "transfer_no" VARCHAR(20) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "from_entity" "Entity" NOT NULL,
    "to_entity" "Entity" NOT NULL,
    "from_account_id" BIGINT,
    "to_account_id" BIGINT,
    "krw_amount" DECIMAL(18,2),
    "usd_amount" DECIMAL(18,2),
    "cny_arrival_amount" DECIMAL(18,2),
    "fx_rate_usd_cny" DECIMAL(18,6),
    "bank_fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purpose" VARCHAR(30),
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "internal_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" BIGSERIAL NOT NULL,
    "invoice_no" VARCHAR(20) NOT NULL,
    "partner_id" BIGINT NOT NULL,
    "deal_type_id" BIGINT NOT NULL,
    "accounting_class" VARCHAR(30) NOT NULL,
    "total_receipt_amount" DECIMAL(18,2),
    "target_amount" DECIMAL(18,2) NOT NULL,
    "target_amount_source" VARCHAR(10) NOT NULL DEFAULT 'AUTO',
    "target_amount_reason" TEXT,
    "vat_mode" "VatMode" NOT NULL,
    "supply_amount" DECIMAL(18,2) NOT NULL,
    "vat_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "issue_status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "issue_date" DATE,
    "nts_approval_no" VARCHAR(50),
    "memo" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_orders" (
    "id" BIGSERIAL NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "invoice_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" BIGSERIAL NOT NULL,
    "emp_code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "name_cn" VARCHAR(50),
    "position" VARCHAR(50),
    "hire_date" DATE,
    "resign_date" DATE,
    "base_salary" DECIMAL(18,2),
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "id" BIGSERIAL NOT NULL,
    "year_month" CHAR(7) NOT NULL,
    "employee_id" BIGINT NOT NULL,
    "base_salary" DECIMAL(18,2) NOT NULL,
    "allowance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deduction" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "insurance_company" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "insurance_employee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "actual_paid" DECIMAL(18,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "paid_at" DATE,
    "expense_id" BIGINT,
    "insurance_expense_id" BIGINT,
    "memo" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" BIGSERIAL NOT NULL,
    "table_name" VARCHAR(50) NOT NULL,
    "record_id" BIGINT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "field_name" VARCHAR(50),
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by" BIGINT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "ip_address" VARCHAR(64),
    "request_id" UUID,

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_counters" (
    "prefix" VARCHAR(10) NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "number_counters_pkey" PRIMARY KEY ("prefix","year")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" BIGSERIAL NOT NULL,
    "ref_table" VARCHAR(50) NOT NULL,
    "ref_id" BIGINT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_path" VARCHAR(500) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "uploaded_by" BIGINT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_periods" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "status" "VatPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "sales_vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchase_vat" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(18,2),
    "paid_at" DATE,
    "expense_id" BIGINT,
    "memo" TEXT,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vat_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate_refs" (
    "id" BIGSERIAL NOT NULL,
    "rate_date" DATE NOT NULL,
    "base_currency" "Currency" NOT NULL,
    "quote_currency" "Currency" NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "source" VARCHAR(30),

    CONSTRAINT "fx_rate_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" BIGSERIAL NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploaded_by" BIGINT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ(6),
    "summary" JSONB,
    "file_bytes" BYTEA,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" BIGSERIAL NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "sheet_name" VARCHAR(50) NOT NULL,
    "row_index" INTEGER NOT NULL,
    "raw_json" JSONB NOT NULL,
    "raw_formula" JSONB,
    "map_status" "ImportRowStatus" NOT NULL DEFAULT 'OK',
    "target_table" VARCHAR(50),
    "target_id" BIGINT,
    "error_msg" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_login_id_key" ON "users"("login_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_code_key" ON "partners"("code");

-- CreateIndex
CREATE INDEX "partners_name_normalized_idx" ON "partners"("name_normalized");

-- CreateIndex
CREATE INDEX "partners_is_active_name_idx" ON "partners"("is_active", "name");

-- CreateIndex
CREATE INDEX "partner_aliases_alias_normalized_idx" ON "partner_aliases"("alias_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "partner_aliases_alias_key" ON "partner_aliases"("alias");

-- CreateIndex
CREATE INDEX "accounts_entity_is_active_idx" ON "accounts"("entity", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_code_key" ON "expense_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "deal_types_code_key" ON "deal_types"("code");

-- CreateIndex
CREATE INDEX "login_attempts_blocked_until_idx" ON "login_attempts"("blocked_until");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE INDEX "orders_partner_id_order_date_idx" ON "orders"("partner_id", "order_date" DESC);

-- CreateIndex
CREATE INDEX "orders_route_status_idx" ON "orders"("route", "status");

-- CreateIndex
CREATE INDEX "orders_external_ref_idx" ON "orders"("external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_receipt_no_key" ON "receipts"("receipt_no");

-- CreateIndex
CREATE INDEX "receipts_partner_id_receipt_date_idx" ON "receipts"("partner_id", "receipt_date" DESC);

-- CreateIndex
CREATE INDEX "receipts_order_id_idx" ON "receipts"("order_id");

-- CreateIndex
CREATE INDEX "receipts_account_id_receipt_date_idx" ON "receipts"("account_id", "receipt_date");

-- CreateIndex
CREATE INDEX "receipt_splits_split_kind_idx" ON "receipt_splits"("split_kind");

-- CreateIndex
CREATE INDEX "receipt_splits_receipt_id_idx" ON "receipt_splits"("receipt_id");

-- CreateIndex
CREATE INDEX "deposit_ledger_partner_id_deposit_kind_idx" ON "deposit_ledger"("partner_id", "deposit_kind");

-- CreateIndex
CREATE INDEX "deposit_ledger_movement_date_idx" ON "deposit_ledger"("movement_date");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_expense_no_key" ON "expenses"("expense_no");

-- CreateIndex
CREATE INDEX "expenses_category_id_expense_date_idx" ON "expenses"("category_id", "expense_date" DESC);

-- CreateIndex
CREATE INDEX "expenses_entity_expense_date_idx" ON "expenses"("entity", "expense_date");

-- CreateIndex
CREATE INDEX "expenses_payment_status_idx" ON "expenses"("payment_status");

-- CreateIndex
CREATE INDEX "expense_allocations_order_id_idx" ON "expense_allocations"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_allocations_expense_id_order_id_key" ON "expense_allocations"("expense_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "remittances_remit_no_key" ON "remittances"("remit_no");

-- CreateIndex
CREATE INDEX "remittances_remit_date_idx" ON "remittances"("remit_date" DESC);

-- CreateIndex
CREATE INDEX "remittance_allocations_order_id_idx" ON "remittance_allocations"("order_id");

-- CreateIndex
CREATE INDEX "remittance_allocations_partner_id_idx" ON "remittance_allocations"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "internal_transfers_transfer_no_key" ON "internal_transfers"("transfer_no");

-- CreateIndex
CREATE INDEX "internal_transfers_transfer_date_idx" ON "internal_transfers"("transfer_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "invoices_partner_id_issue_date_idx" ON "invoices"("partner_id", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "invoices_issue_status_idx" ON "invoices"("issue_status");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_orders_invoice_id_order_id_key" ON "invoice_orders"("invoice_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_emp_code_key" ON "employees"("emp_code");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_expense_id_key" ON "payrolls"("expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_insurance_expense_id_key" ON "payrolls"("insurance_expense_id");

-- CreateIndex
CREATE INDEX "payrolls_year_month_idx" ON "payrolls"("year_month");

-- CreateIndex
CREATE UNIQUE INDEX "payrolls_year_month_employee_id_key" ON "payrolls"("year_month", "employee_id");

-- CreateIndex
CREATE INDEX "change_logs_table_name_record_id_changed_at_idx" ON "change_logs"("table_name", "record_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "change_logs_changed_at_idx" ON "change_logs"("changed_at" DESC);

-- CreateIndex
CREATE INDEX "change_logs_changed_by_idx" ON "change_logs"("changed_by");

-- CreateIndex
CREATE INDEX "attachments_ref_table_ref_id_idx" ON "attachments"("ref_table", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "vat_periods_code_key" ON "vat_periods"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vat_periods_expense_id_key" ON "vat_periods"("expense_id");

-- CreateIndex
CREATE INDEX "vat_periods_period_from_period_to_idx" ON "vat_periods"("period_from", "period_to");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_refs_rate_date_base_currency_quote_currency_key" ON "fx_rate_refs"("rate_date", "base_currency", "quote_currency");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_sheet_name_idx" ON "import_rows"("batch_id", "sheet_name");

-- CreateIndex
CREATE INDEX "import_rows_map_status_idx" ON "import_rows"("map_status");

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_default_deal_type_id_fkey" FOREIGN KEY ("default_deal_type_id") REFERENCES "deal_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_aliases" ADD CONSTRAINT "partner_aliases_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deal_type_id_fkey" FOREIGN KEY ("deal_type_id") REFERENCES "deal_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_splits" ADD CONSTRAINT "receipt_splits_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_remittance_id_fkey" FOREIGN KEY ("remittance_id") REFERENCES "remittances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deal_type_id_fkey" FOREIGN KEY ("deal_type_id") REFERENCES "deal_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

