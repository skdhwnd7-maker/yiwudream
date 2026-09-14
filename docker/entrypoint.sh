#!/bin/sh
# 첫 실행이면 표를 만들고 시연 자료를 넣은 뒤 서버를 띄운다.
# 이미 준비된 DB면 그대로 띄운다 — 여러 번 눌러도 자료가 덮어써지지 않는다.
set -e

echo ""
echo "  이우드림무역 자금관리를 준비합니다."
echo ""

# 로그인 보안키가 없으면 한 번 만들어 보관한다.
# 매번 새로 만들면 켤 때마다 로그인이 풀린다.
SECRET_FILE=/app/.uploads/.auth-secret
if [ -z "$AUTH_SECRET" ] || [ "$AUTH_SECRET" = "build-time-placeholder-secret-not-used-at-runtime" ]; then
  mkdir -p /app/.uploads
  if [ ! -f "$SECRET_FILE" ]; then
    head -c 48 /dev/urandom | base64 | tr -d '\n' > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  AUTH_SECRET="$(cat "$SECRET_FILE")"
  export AUTH_SECRET
fi

# 1) DB가 받을 준비가 될 때까지 기다린다
#    pg_isready 는 ?schema=public 같은 꼬리표를 못 읽는다. 떼고 넘긴다.
PG_URL="${DATABASE_URL%%\?*}"
printf "  [1/4] 데이터베이스 연결 확인"
for i in $(seq 1 60); do
  if pg_isready -d "$PG_URL" >/dev/null 2>&1; then
    echo "  ... 됐습니다"
    break
  fi
  printf "."
  sleep 1
  if [ "$i" = "60" ]; then
    echo ""
    echo "  ✗ 데이터베이스에 연결하지 못했습니다."
    exit 1
  fi
done

# 2) 표를 만든다 (이미 있으면 그대로 둔다)
echo "  [2/4] 표 만들기"
npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1

# 3) 보호장치(원장 불변·예치금 마이너스 금지 등)
echo "  [3/4] 보호장치 적용"
npx tsx scripts/apply-sql.ts >/dev/null 2>&1

# 4) 기준정보 + 시연 자료 — 이미 있으면 건너뛴다
echo "  [4/4] 시연 자료 준비"
npx tsx scripts/demo-setup.ts

echo ""
echo "  ─────────────────────────────────────────────"
echo "   준비를 마쳤습니다."
echo ""
echo "   브라우저에서 열어 주세요:  http://localhost:3000"
echo "   아이디: admin"
echo "   비밀번호: ${SEED_ADMIN_PASSWORD}"
echo "  ─────────────────────────────────────────────"
echo ""

exec npm run start
