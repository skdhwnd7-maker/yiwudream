#!/bin/sh
# 첫 실행이면 표를 만들고 시연 자료를 넣은 뒤 서버를 띄운다.
# 이미 준비된 DB면 그대로 띄운다 — 여러 번 켜도 자료가 덮어써지지 않는다.
#
# 내 PC 도커에서도, Railway 같은 인터넷 서버에서도 같은 순서로 돈다.
set -e

echo ""
echo "  이우드림무역 자금관리를 준비합니다."
echo ""

# Railway 처럼 HTTPS 로 열리는 곳에서는 로그인 쿠키를 반드시 secure 로 보내야 한다.
# 사람이 깜빡할 수 있으니 여기서 알아서 켠다. 직접 정해 넣었으면 그대로 둔다.
if [ -z "$COOKIE_SECURE" ]; then
  if [ -n "$RAILWAY_ENVIRONMENT" ] || [ -n "$RAILWAY_PUBLIC_DOMAIN" ]; then
    COOKIE_SECURE=true
  else
    COOKIE_SECURE=false
  fi
  export COOKIE_SECURE
fi

# 1) DB가 받을 준비가 될 때까지 기다린다
#    pg_isready 는 ?schema=public 같은 꼬리표를 못 읽는다. 떼고 넘긴다.
PG_URL="${DATABASE_URL%%\?*}"
printf "  [1/6] 데이터베이스 연결 확인"
i=0
while [ "$i" -lt 90 ]; do
  if pg_isready -d "$PG_URL" >/dev/null 2>&1; then
    echo "  ... 됐습니다"
    break
  fi
  printf "."
  i=$((i + 1))
  sleep 1
done
if [ "$i" -ge 90 ]; then
  echo ""
  echo "  ✗ 데이터베이스에 연결하지 못했습니다."
  echo "    DATABASE_URL 이 제대로 들어갔는지 확인해 주세요."
  exit 1
fi

# 2) 표를 만든다 — 운영에서는 마이그레이션만 쓴다.
#    db push --accept-data-loss 는 스키마가 어긋나면 열을 말없이 지운다.
#    장부를 담은 DB 에 그런 명령을 돌릴 수는 없다.
#
#    0_init 은 「이미 돌고 있던 DB 에 있던 표들」 이라는 뜻의 기준선이다.
#    그 뒤에 더한 것(1_login_attempts …)만 실제로 적용된다.
#    - 새 DB      : 0_init 부터 전부 실행된다
#    - 기존 DB    : 0_init 은 「이미 있음」 으로 표시만 하고, 그 뒤 것만 실행된다
#    어느 쪽이든 기존 자료를 지우는 명령은 돌지 않는다.
echo "  [2/6] 표 만들기"
PSQL="psql $PG_URL -tAc"
HAS_TABLES="$($PSQL "SELECT count(*) > 0 FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '\_prisma%'" 2>/dev/null || echo f)"

if [ "$HAS_TABLES" = "t" ]; then
  # 기준선 기록을 현재 파일 기준으로 다시 찍는다.
  # 기록이 없을 수도(db push 로 만든 DB), 예전 파일 기준으로 남아 있을 수도 있다.
  # 지우는 것은 「기록 한 줄」 이지 표나 자료가 아니다.
  HAS_MIGRATIONS="$($PSQL "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || echo f)"
  if [ "$HAS_MIGRATIONS" = "t" ]; then
    $PSQL "DELETE FROM _prisma_migrations WHERE migration_name = '0_init'" >/dev/null 2>&1 || true
  fi
  echo "        기존 DB 입니다. 이미 있는 표는 그대로 두고 새 것만 더합니다."
  npx prisma migrate resolve --applied 0_init >/dev/null 2>&1 || true
fi

if ! npx prisma migrate deploy >/dev/null 2>&1; then
  echo ""
  echo "  ✗ 마이그레이션에 실패했습니다. 자료는 건드리지 않았습니다."
  npx prisma migrate deploy 2>&1 | tail -25
  exit 1
fi
$PSQL "SELECT '        적용된 마이그레이션: ' || string_agg(migration_name, ', ' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || true

# 3) 보호장치(원장 불변·예치금 마이너스 금지 등)
echo "  [3/6] 보호장치 적용"
npx tsx scripts/apply-sql.ts >/dev/null 2>&1

# 4) 자료 비우기 — RESET_DATA 를 넣었을 때만, 그 값으로는 딱 한 번만 돈다
#    보안키보다 먼저 해야 한다. 비우면 보안키도 같이 지워지기 때문이다.
echo "  [4/6] 자료 초기화 확인"
npx tsx scripts/reset-data.ts

# 5) 로그인 보안키 — 한 번 만들어 DB에 보관하고 계속 같은 것을 쓴다
echo "  [5/6] 로그인 보안키 확인"
AUTH_SECRET="$(npx tsx scripts/ensure-auth-secret.ts)"
export AUTH_SECRET
if [ -z "$AUTH_SECRET" ]; then
  echo "  ✗ 로그인 보안키를 준비하지 못했습니다."
  exit 1
fi

# 6) 기준정보 + 시연 자료 — 이미 있으면 건너뛴다
#    실제 자료로 쓰기 시작하면 SEED_DEMO=0 으로 꺼 둔다.
if [ "${SEED_DEMO:-1}" = "0" ]; then
  echo "  [6/6] 기준정보 준비 (시연 자료는 넣지 않습니다)"
  npx tsx prisma/seed.ts
else
  echo "  [6/6] 시연 자료 준비"
  npx tsx scripts/demo-setup.ts
fi

if [ -n "$RAILWAY_PUBLIC_DOMAIN" ]; then
  WHERE="https://${RAILWAY_PUBLIC_DOMAIN}"
else
  WHERE="http://localhost:${PORT:-3000}"
fi

echo ""
echo "  ─────────────────────────────────────────────"
echo "   준비를 마쳤습니다."
echo ""
echo "   주소:   ${WHERE}"
echo "   아이디: admin"
echo "  ─────────────────────────────────────────────"
echo ""

exec npm run start
