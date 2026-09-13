-- 전표번호 채번
--
-- 여러 직원이 동시에 등록해도 번호가 겹치거나 건너뛰지 않아야 한다.
-- 접두사+연도 조합마다 한 행을 두고, 그 행을 잠그고 올린다.

CREATE TABLE IF NOT EXISTS number_counters (
  prefix     VARCHAR(10) NOT NULL,
  year       INT         NOT NULL,
  last_value INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

CREATE OR REPLACE FUNCTION next_doc_no(p_prefix TEXT, p_year INT, p_width INT DEFAULT 6)
RETURNS TEXT AS $$
DECLARE
  v_next INT;
BEGIN
  INSERT INTO number_counters (prefix, year, last_value)
       VALUES (p_prefix, p_year, 1)
  ON CONFLICT (prefix, year)
  DO UPDATE SET last_value = number_counters.last_value + 1
    RETURNING last_value INTO v_next;

  RETURN p_prefix || '-' || p_year::TEXT || '-' || lpad(v_next::TEXT, p_width, '0');
END;
$$ LANGUAGE plpgsql;
