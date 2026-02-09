-- Add telegram auth support and harden phone uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "phone" IS NOT NULL
    GROUP BY "phone"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate phone values found in "User"."phone". Resolve duplicates before applying migration.';
  END IF;
END
$$;

DO $$
BEGIN
  CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'TELEGRAM', 'HYBRID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "User"
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "telegramId" BIGINT,
  ADD COLUMN IF NOT EXISTS "telegramUsername" TEXT,
  ADD COLUMN IF NOT EXISTS "telegramLinkedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "authProvider" "AuthProvider" NOT NULL DEFAULT 'LOCAL';

CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramId_key" ON "User"("telegramId");
