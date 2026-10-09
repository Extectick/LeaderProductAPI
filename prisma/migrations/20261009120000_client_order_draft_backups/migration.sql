ALTER TABLE "Order" ADD COLUMN "draftReview" JSONB;

CREATE TABLE "ClientOrderDraftBackup" (
  "userId" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "clientRevision" INTEGER NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "orderSnapshot" JSONB,
  "review" JSONB,
  "submittedOrderGuid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "clientOrderId"),
  CONSTRAINT "ClientOrderDraftBackup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ClientOrderDraftBackup_userId_updatedAt_idx" ON "ClientOrderDraftBackup"("userId", "updatedAt");
