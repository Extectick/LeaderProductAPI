ALTER TABLE "User" ADD COLUMN "clientContacts" JSONB;
CREATE TABLE "OrderShareLink" (
  "id" TEXT NOT NULL PRIMARY KEY,
    "orderGuid" TEXT NOT NULL,
    "localOrderId" TEXT,
  "ownerId" INTEGER NOT NULL,
  "counterpartyGuid" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenEncrypted" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "version" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "OrderShareLink_tokenHash_key" ON "OrderShareLink"("tokenHash");
CREATE UNIQUE INDEX "OrderShareLink_ownerId_orderGuid_key" ON "OrderShareLink"("ownerId", "orderGuid");
CREATE INDEX "OrderShareLink_expiresAt_idx" ON "OrderShareLink"("expiresAt");
