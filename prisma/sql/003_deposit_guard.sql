-- 예치금이 마이너스가 되지 않게 막는다
--
-- 고객이 맡긴 돈보다 더 많이 중국에 보내거나, 반환하거나, 조정할 수 없다.
-- 애플리케이션에서도 검사하지만, 두 사람이 동시에 넣으면 둘 다 「잔액 충분」 으로
-- 통과할 수 있다. 마지막 방어선은 DB에 있어야 한다.
--
-- 커밋 시점에 검사하는 지연 제약이다. 한 트랜잭션 안에서
-- 「입금 +100만 → 송금 −60만」 처럼 순서가 섞여도 최종 합계만 본다.

CREATE OR REPLACE FUNCTION deposit_balance_not_negative() RETURNS TRIGGER AS $$
DECLARE
  v_partner_balance NUMERIC(18,2);
  v_order_balance   NUMERIC(18,2);
  v_partner_name    TEXT;
BEGIN
  -- ① 거래처·예치금종류 단위 잔액
  SELECT COALESCE(SUM(amount_krw), 0) INTO v_partner_balance
    FROM deposit_ledger
   WHERE partner_id = NEW.partner_id
     AND deposit_kind = NEW.deposit_kind;

  IF v_partner_balance < 0 THEN
    SELECT name INTO v_partner_name FROM partners WHERE id = NEW.partner_id;
    RAISE EXCEPTION
      '예치금이 모자랍니다. % 의 % 잔액이 %원이 됩니다. 고객이 맡긴 돈보다 많이 쓸 수 없습니다.',
      COALESCE(v_partner_name, NEW.partner_id::TEXT),
      CASE NEW.deposit_kind WHEN 'GOODS_FUND' THEN '상품구매 예치금' ELSE '일반 예치금' END,
      to_char(v_partner_balance, 'FM999,999,999,990.00')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ② 상품구매 예치금은 주문 단위로도 마이너스가 될 수 없다.
  --    (일반 예치금은 주문 없이 쌓았다가 주문에서 쓰므로 주문 단위 검사가 성립하지 않는다)
  IF NEW.deposit_kind = 'GOODS_FUND' AND NEW.order_id IS NOT NULL THEN
    SELECT COALESCE(SUM(amount_krw), 0) INTO v_order_balance
      FROM deposit_ledger
     WHERE partner_id = NEW.partner_id
       AND deposit_kind = NEW.deposit_kind
       AND order_id = NEW.order_id;

    IF v_order_balance < 0 THEN
      RAISE EXCEPTION
        '주문 예치금이 모자랍니다. 주문 ID=% 의 상품구매 예치금 잔액이 %원이 됩니다.',
        NEW.order_id, to_char(v_order_balance, 'FM999,999,999,990.00')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposit_not_negative ON deposit_ledger;
CREATE CONSTRAINT TRIGGER trg_deposit_not_negative
  AFTER INSERT ON deposit_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION deposit_balance_not_negative();
