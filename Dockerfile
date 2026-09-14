# 이우드림무역 자금관리 — 실행용 이미지
#
# 대표님 PC에서 도커로 바로 띄우기 위한 것입니다.
# 이미지 크기를 줄이는 것보다 「확실히 돌아가는 것」을 택했습니다.

FROM node:22-slim

WORKDIR /app

# prisma 는 openssl, 기동 대기는 pg_isready 가 필요하다
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl postgresql-client \
    && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1

# 의존성 먼저 — 소스가 바뀌어도 이 층은 다시 받지 않는다
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# 윈도우에서 받은 소스는 실행 권한이 없을 수 있다
RUN chmod +x /app/docker/entrypoint.sh

# 빌드할 때는 DB에 붙지 않는다. 자리만 채워 둔다.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    AUTH_SECRET="build-time-placeholder-secret-not-used-at-runtime" \
    npx prisma generate && npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
