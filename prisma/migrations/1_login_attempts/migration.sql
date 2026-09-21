-- CreateTable
CREATE TABLE "login_attempts" (
    "key" VARCHAR(160) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_until" TIMESTAMPTZ(6),

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "login_attempts_blocked_until_idx" ON "login_attempts"("blocked_until");

