-- 이우드림무역 자금관리 — 데이터베이스 수준 보호장치
-- 설계 문서: docs/08-변경이력과감사.md
-- prisma db push 이후 매번 실행해도 안전하도록 전부 멱등하게 작성했다.

-- ─────────────────────────────────────────────────────────────
-- 1~2. 예치금 원장 · 변경이력 불변 보장 (append-only)
--
--   RULE ... DO INSTEAD NOTHING 도 쓸 수 있지만, 그 경우 애플리케이션은
--   "조용히 아무 일도 안 일어난 것"을 성공으로 오해할 수 있다.
--   돈을 다루는 표에서는 조용한 실패가 더 위험하므로 트리거로 막고
--   무엇을 해야 하는지 알려주는 오류를 던진다.
-- ─────────────────────────────────────────────────────────────
DROP RULE IF EXISTS deposit_ledger_no_update ON deposit_ledger;
DROP RULE IF EXISTS deposit_ledger_no_delete ON deposit_ledger;
DROP RULE IF EXISTS change_logs_no_update ON change_logs;
DROP RULE IF EXISTS change_logs_no_delete ON change_logs;

CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '%는 추가만 가능한 원장입니다. 값을 고치지 말고 반대부호 상쇄행을 추가하세요.',
    TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposit_ledger_immutable ON deposit_ledger;
CREATE TRIGGER trg_deposit_ledger_immutable
  BEFORE UPDATE OR DELETE ON deposit_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '변경이력은 수정하거나 지울 수 없습니다.'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_change_logs_immutable ON change_logs;
CREATE TRIGGER trg_change_logs_immutable
  BEFORE UPDATE OR DELETE ON change_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- ─────────────────────────────────────────────────────────────
-- 3. 예치금 원장: ADJUST / REFUND 는 사유 없이 만들 수 없다
-- ─────────────────────────────────────────────────────────────
ALTER TABLE deposit_ledger DROP CONSTRAINT IF EXISTS chk_deposit_reason;
ALTER TABLE deposit_ledger ADD CONSTRAINT chk_deposit_reason
  CHECK (movement NOT IN ('ADJUST', 'REFUND') OR (reason IS NOT NULL AND btrim(reason) <> ''));

-- ─────────────────────────────────────────────────────────────
-- 4. 입금 분해 합계 = 입금액   (SUM(splits) = receipts.amount)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_receipt_split_sum() RETURNS TRIGGER AS $$
DECLARE
  v_receipt_id BIGINT;
  v_amount     NUMERIC(18,2);
  v_sum        NUMERIC(18,2);
BEGIN
  v_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);

  SELECT amount INTO v_amount FROM receipts WHERE id = v_receipt_id;
  IF NOT FOUND THEN
    RETURN NULL; -- 입금 전표가 이미 지워진 경우(cascade) 검사 생략
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM receipt_splits WHERE receipt_id = v_receipt_id;

  -- 분해가 하나도 없는 중간 상태는 허용한다 (트랜잭션 안에서 채워지는 중)
  IF v_sum > 0 AND v_sum <> v_amount THEN
    RAISE EXCEPTION '입금 분해 합계(%)가 입금액(%)과 다릅니다. 입금번호 ID=%',
      v_sum, v_amount, v_receipt_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_receipt_split_sum ON receipt_splits;
CREATE CONSTRAINT TRIGGER trg_receipt_split_sum
  AFTER INSERT OR UPDATE OR DELETE ON receipt_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_receipt_split_sum();

-- ─────────────────────────────────────────────────────────────
-- 5. 지출 배분 합계 ≤ 지출액   (초과 배분 차단)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_expense_alloc_sum() RETURNS TRIGGER AS $$
DECLARE
  v_expense_id BIGINT;
  v_amount     NUMERIC(18,2);
  v_sum        NUMERIC(18,2);
BEGIN
  v_expense_id := COALESCE(NEW.expense_id, OLD.expense_id);

  SELECT amount INTO v_amount FROM expenses WHERE id = v_expense_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(alloc_amount), 0) INTO v_sum
    FROM expense_allocations WHERE expense_id = v_expense_id;

  IF v_sum > v_amount THEN
    RAISE EXCEPTION '지출 배분 합계(%)가 지출액(%)을 초과했습니다. 지출 ID=%',
      v_sum, v_amount, v_expense_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expense_alloc_sum ON expense_allocations;
CREATE CONSTRAINT TRIGGER trg_expense_alloc_sum
  AFTER INSERT OR UPDATE OR DELETE ON expense_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_expense_alloc_sum();

-- ─────────────────────────────────────────────────────────────
-- 6. 송금 배분 합계 = 송금액
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_remit_alloc_sum() RETURNS TRIGGER AS $$
DECLARE
  v_remit_id BIGINT;
  v_amount   NUMERIC(18,2);
  v_sum      NUMERIC(18,2);
  v_status   TEXT;
BEGIN
  v_remit_id := COALESCE(NEW.remittance_id, OLD.remittance_id);

  SELECT krw_amount, status::TEXT INTO v_amount, v_status
    FROM remittances WHERE id = v_remit_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 작성중(DRAFT)에는 배분이 맞지 않아도 둔다. 확정 시점에만 강제한다.
  IF v_status = 'DRAFT' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(alloc_krw), 0) INTO v_sum
    FROM remittance_allocations WHERE remittance_id = v_remit_id;

  IF v_sum <> v_amount THEN
    RAISE EXCEPTION '송금 배분 합계(%)가 송금액(%)과 다릅니다. 송금 ID=%',
      v_sum, v_amount, v_remit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_remit_alloc_sum ON remittance_allocations;
CREATE CONSTRAINT TRIGGER trg_remit_alloc_sum
  AFTER INSERT OR UPDATE OR DELETE ON remittance_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_remit_alloc_sum();

-- ─────────────────────────────────────────────────────────────
-- 7. 정산완료(SETTLED) 주문의 하위 전표는 손댈 수 없다
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_order_locked() RETURNS TRIGGER AS $$
DECLARE
  v_order_id BIGINT;
  v_status   TEXT;
  v_no       TEXT;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  IF v_order_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT status::TEXT, order_no INTO v_status, v_no FROM orders WHERE id = v_order_id;
  IF v_status = 'SETTLED' THEN
    RAISE EXCEPTION '정산완료된 주문(%)의 전표는 수정할 수 없습니다. 잠금해제 후 진행하세요.', v_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_receipt_order_locked ON receipts;
CREATE TRIGGER trg_receipt_order_locked
  BEFORE INSERT OR UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION check_order_locked();

DROP TRIGGER IF EXISTS trg_alloc_order_locked ON expense_allocations;
CREATE TRIGGER trg_alloc_order_locked
  BEFORE INSERT OR UPDATE OR DELETE ON expense_allocations
  FOR EACH ROW EXECUTE FUNCTION check_order_locked();
