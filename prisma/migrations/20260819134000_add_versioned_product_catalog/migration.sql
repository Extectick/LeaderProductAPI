DO $$ BEGIN
  CREATE TYPE "CatalogChangeOperation" AS ENUM ('UPSERT', 'DELETE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "catalogHash" TEXT,
  ADD COLUMN IF NOT EXISTS "catalogRevision" BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Product_catalogRevision_idx" ON "Product"("catalogRevision");

CREATE TABLE IF NOT EXISTS "CatalogState" (
  "id" TEXT NOT NULL,
  "epoch" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "currentRevision" BIGINT NOT NULL DEFAULT 0,
  "minAvailableRevision" BIGINT NOT NULL DEFAULT 0,
  "lastSourceUpdateAt" TIMESTAMP(3),
  "lastFullReconcileAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CatalogState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CatalogChange" (
  "revision" BIGSERIAL NOT NULL,
  "productGuid" TEXT NOT NULL,
  "operation" "CatalogChangeOperation" NOT NULL,
  "payloadHash" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3),
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CatalogChange_pkey" PRIMARY KEY ("revision")
);

CREATE INDEX IF NOT EXISTS "CatalogChange_productGuid_revision_idx"
  ON "CatalogChange"("productGuid", "revision");
CREATE INDEX IF NOT EXISTS "CatalogChange_changedAt_idx"
  ON "CatalogChange"("changedAt");

INSERT INTO "CatalogState" (
  "id", "epoch", "schemaVersion", "currentRevision", "minAvailableRevision", "createdAt", "updatedAt"
)
VALUES (
  'nomenclature', md5(random()::text || clock_timestamp()::text), 1, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
