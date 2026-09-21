-- AlterTable
ALTER TABLE "remittances" ADD COLUMN     "idempotency_key" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "remittances_idempotency_key_key" ON "remittances"("idempotency_key");

