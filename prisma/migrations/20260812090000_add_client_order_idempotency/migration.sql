ALTER TABLE "Order"
  ADD COLUMN "clientOrderId" TEXT,
  ADD COLUMN "clientRevision" INTEGER,
  ADD COLUMN "clientPayloadHash" TEXT,
  ADD COLUMN "submitRequestedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Order_createdByUserId_clientOrderId_key"
  ON "Order"("createdByUserId", "clientOrderId");
