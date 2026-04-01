DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'SyncEntityType'
      AND e.enumlabel = 'ORGANIZATIONS'
  ) THEN
    ALTER TYPE "SyncEntityType" ADD VALUE 'ORGANIZATIONS';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "Organization" (
  "id" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sourceUpdatedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Organization_guid_key" ON "Organization"("guid");
CREATE INDEX IF NOT EXISTS "Organization_isActive_idx" ON "Organization"("isActive");
CREATE INDEX IF NOT EXISTS "Organization_sourceUpdatedAt_idx" ON "Organization"("sourceUpdatedAt");

ALTER TABLE "StockBalance"
  ADD COLUMN IF NOT EXISTS "syncKey" TEXT,
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesProductionDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "seriesExpiresAt" TIMESTAMP(3);

UPDATE "StockBalance"
SET "syncKey" = CONCAT_WS(
  '|',
  "productId",
  "warehouseId",
  COALESCE("organizationId", 'legacy-organization'),
  COALESCE("seriesGuid", 'legacy-series'),
  "id"
)
WHERE "syncKey" IS NULL;

ALTER TABLE "StockBalance"
  ALTER COLUMN "syncKey" SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'StockBalance_productId_warehouseId_key'
  ) THEN
    ALTER TABLE "StockBalance" DROP CONSTRAINT "StockBalance_productId_warehouseId_key";
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "StockBalance_syncKey_key" ON "StockBalance"("syncKey");
CREATE INDEX IF NOT EXISTS "StockBalance_organizationId_idx" ON "StockBalance"("organizationId");
CREATE INDEX IF NOT EXISTS "StockBalance_seriesGuid_idx" ON "StockBalance"("seriesGuid");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'StockBalance_organizationId_fkey'
  ) THEN
    ALTER TABLE "StockBalance"
      ADD CONSTRAINT "StockBalance_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "OnecStageOrganization" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3),
  "lastImportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolveStatus" "OnecStageResolveStatus" NOT NULL DEFAULT 'PENDING',
  "lastResolveError" TEXT,
  "resolvedAt" TIMESTAMP(3),

  CONSTRAINT "OnecStageOrganization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OnecStageOrganization_sessionId_sourceKey_key"
  ON "OnecStageOrganization"("sessionId", "sourceKey");
CREATE INDEX IF NOT EXISTS "OnecStageOrganization_sessionId_resolveStatus_idx"
  ON "OnecStageOrganization"("sessionId", "resolveStatus");
CREATE INDEX IF NOT EXISTS "OnecStageOrganization_guid_idx"
  ON "OnecStageOrganization"("guid");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'OnecStageOrganization_sessionId_fkey'
  ) THEN
    ALTER TABLE "OnecStageOrganization"
      ADD CONSTRAINT "OnecStageOrganization_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "OnecSyncSession"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "OnecStageStock"
  ADD COLUMN IF NOT EXISTS "organizationGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "seriesProductionDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "seriesExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OnecStageStock_organizationGuid_idx" ON "OnecStageStock"("organizationGuid");
CREATE INDEX IF NOT EXISTS "OnecStageStock_seriesGuid_idx" ON "OnecStageStock"("seriesGuid");
