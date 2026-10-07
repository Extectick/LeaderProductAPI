ALTER TABLE "Counterparty" ADD COLUMN "managerGuid" TEXT;
CREATE INDEX "Counterparty_managerGuid_idx" ON "Counterparty"("managerGuid");

CREATE TABLE "ManagerStockReservation" (
    "id" TEXT NOT NULL,
    "syncKey" TEXT NOT NULL,
    "managerGuid" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "organizationId" TEXT,
    "reserved" DECIMAL(18,3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ManagerStockReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ManagerStockReservation_syncKey_key" ON "ManagerStockReservation"("syncKey");
CREATE INDEX "ManagerStockReservation_managerGuid_warehouseId_productId_idx" ON "ManagerStockReservation"("managerGuid", "warehouseId", "productId");
CREATE INDEX "ManagerStockReservation_managerGuid_organizationId_idx" ON "ManagerStockReservation"("managerGuid", "organizationId");
CREATE INDEX "ManagerStockReservation_sourceUpdatedAt_idx" ON "ManagerStockReservation"("sourceUpdatedAt");
ALTER TABLE "ManagerStockReservation" ADD CONSTRAINT "ManagerStockReservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerStockReservation" ADD CONSTRAINT "ManagerStockReservation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManagerStockReservation" ADD CONSTRAINT "ManagerStockReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CounterpartyManager" (
    "id" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "managerGuid" TEXT NOT NULL,
    "relationSource" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CounterpartyManager_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CounterpartyManager_counterpartyId_managerGuid_relationSource_key" ON "CounterpartyManager"("counterpartyId", "managerGuid", "relationSource");
CREATE INDEX "CounterpartyManager_managerGuid_isActive_idx" ON "CounterpartyManager"("managerGuid", "isActive");
CREATE INDEX "CounterpartyManager_sourceUpdatedAt_idx" ON "CounterpartyManager"("sourceUpdatedAt");
ALTER TABLE "CounterpartyManager" ADD CONSTRAINT "CounterpartyManager_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SellingPrice" (
    "id" TEXT NOT NULL,
    "syncKey" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priceTypeId" TEXT NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT,
    "packageGuid" TEXT,
    "characteristicGuid" TEXT,
    "sourceRegister" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "minQty" DECIMAL(18,3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SellingPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SellingPrice_syncKey_key" ON "SellingPrice"("syncKey");
CREATE INDEX "SellingPrice_productId_priceTypeId_isActive_priority_idx" ON "SellingPrice"("productId", "priceTypeId", "isActive", "priority");
CREATE INDEX "SellingPrice_priceTypeId_isActive_idx" ON "SellingPrice"("priceTypeId", "isActive");
CREATE INDEX "SellingPrice_sourceUpdatedAt_idx" ON "SellingPrice"("sourceUpdatedAt");
ALTER TABLE "SellingPrice" ADD CONSTRAINT "SellingPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellingPrice" ADD CONSTRAINT "SellingPrice_priceTypeId_fkey" FOREIGN KEY ("priceTypeId") REFERENCES "PriceType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OfflineDatasetState" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "currentRevision" BIGINT NOT NULL DEFAULT 0,
    "minAvailableRevision" BIGINT NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastSourceUpdateAt" TIMESTAMP(3),
    "lastFullReconcileAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OfflineDatasetState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OfflineDatasetState_scopeKey_entity_key" ON "OfflineDatasetState"("scopeKey", "entity");
CREATE INDEX "OfflineDatasetState_entity_updatedAt_idx" ON "OfflineDatasetState"("entity", "updatedAt");

CREATE TABLE "OfflineDatasetChange" (
    "revision" BIGSERIAL NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OfflineDatasetChange_pkey" PRIMARY KEY ("revision")
);
CREATE INDEX "OfflineDatasetChange_scopeKey_entity_revision_idx" ON "OfflineDatasetChange"("scopeKey", "entity", "revision");
CREATE INDEX "OfflineDatasetChange_scopeKey_entity_itemKey_idx" ON "OfflineDatasetChange"("scopeKey", "entity", "itemKey");
CREATE INDEX "OfflineDatasetChange_createdAt_idx" ON "OfflineDatasetChange"("createdAt");
