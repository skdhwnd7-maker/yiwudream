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
#    0_init 은 「db push 로 만들어 쓰던 DB 에 이미 있던 표들」 이라는 뜻의 기준선이다.
#    - 새 DB   : 0_init 부터 차례로 전부 실행된다
#    - 기존 DB : 기록이 아예 없을 때 한 번만 「이미 있음」 으로 표시하고,
#                그 뒤 마이그레이션만 실제로 실행된다
#    평소에는 migrate deploy 만 돈다. 기록을 지우는 일은 하지 않는다 —
#    매번 지우면 0_init 파일이 바뀌어도 Prisma 가 알아채지 못한다.
echo "  [2/6] 표 만들기"
PSQL="psql $PG_URL -tAc"
HAS_TABLES="$($PSQL "SELECT count(*) > 0 FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '\_prisma%'" 2>/dev/null || echo f)"
HAS_MIGRATIONS="$($PSQL "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || echo f)"

if [ "$HAS_TABLES" = "t" ] && [ "$HAS_MIGRATIONS" != "t" ]; then
  # 표는 있는데 마이그레이션 기록이 없다 — db push 로 만들어 쓰던 DB 다.
  # 기준선을 한 번만 찍는다. 다음 기동부터는 기록이 있으므로 여기 들어오지 않는다.
  echo "        기존 DB 입니다. 기준선을 한 번 찍고 새 것만 더합니다."
  npx prisma migrate resolve --applied 0_init >/dev/null 2>&1 || true
fi

# 기준선 기록이 예전 파일 기준으로 남아 깨진 경우에만 쓰는 일회용 복구.
# 넣지 않으면 절대 돌지 않는다. 쓰고 나면 값을 지워야 한다.
if [ "$BASELINE_REPAIR" = "0_init" ] && [ "$HAS_MIGRATIONS" = "t" ]; then
  echo "        ⚠ BASELINE_REPAIR — 0_init 기록만 다시 찍습니다 (표·자료는 그대로)."
  $PSQL "DELETE FROM _prisma_migrations WHERE migration_name = '0_init'" >/dev/null 2>&1 || true
  npx prisma migrate resolve --applied 0_init >/dev/null 2>&1 || true
  echo "        복구를 마쳤습니다. Railway 의 BASELINE_REPAIR 값을 지워 주세요."
fi

# 이미 적용된 마이그레이션 파일이 바뀌지 않았는지 직접 대조한다.
# prisma migrate deploy 는 이 검사를 하지 않는다 (개발용 migrate dev 에만 있다).
# 적용이 끝난 파일을 고치면 새 DB 와 기존 DB 의 표 모양이 달라진다 —
# 조용히 넘어가면 나중에 「우리 DB 에만 없는 열」 같은 일이 생긴다.
if [ "$HAS_MIGRATIONS" = "t" ]; then
  DRIFT=""
  for DIR in prisma/migrations/*/; do
    NAME="$(basename "$DIR")"
    [ -f "$DIR/migration.sql" ] || continue
    WANT="$(sha256sum "$DIR/migration.sql" | cut -d' ' -f1)"
    HAVE="$($PSQL "SELECT checksum FROM _prisma_migrations WHERE migration_name = '$NAME' AND finished_at IS NOT NULL" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$HAVE" ] && [ "$HAVE" != "$WANT" ]; then
      DRIFT="$DRIFT $NAME"
    fi
  done
  if [ -n "$DRIFT" ]; then
    echo ""
    echo "  ✗ 이미 적용된 마이그레이션 파일이 바뀌었습니다:$DRIFT"
    echo "    자료는 건드리지 않았습니다. 파일을 되돌리거나,"
    echo "    기준선 기록만 다시 찍으려면 BASELINE_REPAIR=0_init 를 한 번 넣고 배포하세요."
    exit 1
  fi
fi

if ! npx prisma migrate deploy >/dev/null 2>&1; then
  echo ""
  echo "  ✗ 마이그레이션에 실패했습니다. 자료는 건드리지 않았습니다."
  npx prisma migrate deploy 2>&1 | tail -25
  echo ""
  echo "    기준선 기록이 어긋났다는 내용이면 BASELINE_REPAIR=0_init 을 한 번 넣고"
  echo "    다시 배포한 뒤, 그 값을 지우시면 됩니다."
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
