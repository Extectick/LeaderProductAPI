-- A partner's delivery address can belong to several counterparties.
-- Preserve row IDs and all document/profile references.
ALTER TABLE "DeliveryAddress" ADD COLUMN "comment" TEXT, ADD COLUMN "kindName" TEXT;
CREATE UNIQUE INDEX "DeliveryAddress_counterpartyId_guid_key" ON "DeliveryAddress"("counterpartyId", "guid");
CREATE INDEX "DeliveryAddress_guid_idx" ON "DeliveryAddress"("guid");
DROP INDEX "DeliveryAddress_guid_key";
