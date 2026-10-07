ALTER TABLE "OfflineDatasetState" ADD COLUMN "sourceFingerprint" TEXT;
CREATE TABLE "OfflineDatasetRow" (
  "scopeKey" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "OfflineDatasetRow_pkey" PRIMARY KEY ("scopeKey", "entity", "itemKey")
);
