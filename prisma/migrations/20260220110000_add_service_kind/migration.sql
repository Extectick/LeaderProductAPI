-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('LOCAL', 'CLOUD');

-- AlterTable
ALTER TABLE "Service"
ADD COLUMN "kind" "ServiceKind" NOT NULL DEFAULT 'CLOUD';

-- Backfill existing rows explicitly
UPDATE "Service"
SET "kind" = 'CLOUD'
WHERE "kind" IS NULL;
