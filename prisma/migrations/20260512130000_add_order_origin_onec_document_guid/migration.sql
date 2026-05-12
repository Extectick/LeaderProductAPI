-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "originOnecDocumentGuid" TEXT;

-- CreateIndex
CREATE INDEX "Order_originOnecDocumentGuid_idx" ON "Order"("originOnecDocumentGuid");
