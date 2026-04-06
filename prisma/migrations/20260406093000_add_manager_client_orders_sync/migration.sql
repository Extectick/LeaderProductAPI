DO $$
BEGIN
  CREATE TYPE "OrderSyncState" AS ENUM ('DRAFT', 'QUEUED', 'SYNCED', 'CONFLICT', 'ERROR', 'CANCEL_REQUESTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "OrderSource" AS ENUM ('MARKETPLACE_CLIENT', 'MANAGER_APP');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "OrderEventSource" AS ENUM ('APP_MANAGER', 'APP_CANCEL_REQUEST', 'ONEC_ACK', 'ONEC_IMPORT', 'ONEC_EDIT', 'ONEC_POST', 'SYSTEM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "SyncEntityType" ADD VALUE IF NOT EXISTS 'ORDERS_SNAPSHOT';

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "source" "OrderSource" NOT NULL DEFAULT 'MARKETPLACE_CLIENT',
  ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "syncState" "OrderSyncState" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId" INTEGER,
  ADD COLUMN IF NOT EXISTS "generalDiscountPercent" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "generalDiscountAmount" DECIMAL(18,2),
  ADD COLUMN IF NOT EXISTS "isPostedIn1c" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "postedAt1c" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelReason" TEXT,
  ADD COLUMN IF NOT EXISTS "last1cError" TEXT,
  ADD COLUMN IF NOT EXISTS "last1cSnapshot" JSONB;

ALTER TABLE "OrderItem"
  ADD COLUMN IF NOT EXISTS "basePrice" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "isManualPrice" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "manualPrice" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "priceSource" TEXT,
  ADD COLUMN IF NOT EXISTS "appliedDiscountPercent" DECIMAL(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'Order'
      AND constraint_name = 'Order_organizationId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'Order'
      AND constraint_name = 'Order_createdByUserId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "OrderEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "source" "OrderEventSource" NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "actorUserId" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'OrderEvent'
      AND constraint_name = 'OrderEvent_orderId_fkey'
  ) THEN
    ALTER TABLE "OrderEvent"
      ADD CONSTRAINT "OrderEvent_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'OrderEvent'
      AND constraint_name = 'OrderEvent_actorUserId_fkey'
  ) THEN
    ALTER TABLE "OrderEvent"
      ADD CONSTRAINT "OrderEvent_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Order_organizationId_idx" ON "Order"("organizationId");
CREATE INDEX IF NOT EXISTS "Order_createdByUserId_idx" ON "Order"("createdByUserId");
CREATE INDEX IF NOT EXISTS "Order_source_idx" ON "Order"("source");
CREATE INDEX IF NOT EXISTS "Order_syncState_idx" ON "Order"("syncState");
CREATE INDEX IF NOT EXISTS "Order_revision_idx" ON "Order"("revision");
CREATE INDEX IF NOT EXISTS "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");
CREATE INDEX IF NOT EXISTS "OrderEvent_revision_idx" ON "OrderEvent"("revision");
CREATE INDEX IF NOT EXISTS "OrderEvent_source_idx" ON "OrderEvent"("source");
