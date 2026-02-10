DO $$
BEGIN
  CREATE TYPE "PhoneVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "PhoneVerificationSession" (
  "id" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "requestedPhone" BIGINT NOT NULL,
  "status" "PhoneVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "tokenHash" TEXT NOT NULL,
  "telegramUserId" BIGINT,
  "chatId" BIGINT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "PhoneVerificationSession_tokenHash_key" ON "PhoneVerificationSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "PhoneVerificationSession_userId_status_idx" ON "PhoneVerificationSession"("userId", "status");
CREATE INDEX IF NOT EXISTS "PhoneVerificationSession_expiresAt_idx" ON "PhoneVerificationSession"("expiresAt");
CREATE INDEX IF NOT EXISTS "PhoneVerificationSession_telegramUserId_idx" ON "PhoneVerificationSession"("telegramUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PhoneVerificationSession_userId_fkey'
  ) THEN
    ALTER TABLE "PhoneVerificationSession"
      ADD CONSTRAINT "PhoneVerificationSession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "UserPhoneMigrationReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "sourceField" TEXT NOT NULL,
  "rawValue" TEXT,
  "normalizedValue" TEXT,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "UserPhoneMigrationReport_userId_idx" ON "UserPhoneMigrationReport"("userId");
CREATE INDEX IF NOT EXISTS "UserPhoneMigrationReport_reason_idx" ON "UserPhoneMigrationReport"("reason");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserPhoneMigrationReport_userId_fkey'
  ) THEN
    ALTER TABLE "UserPhoneMigrationReport"
      ADD CONSTRAINT "UserPhoneMigrationReport_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "phone_new" BIGINT;

CREATE OR REPLACE FUNCTION normalize_ru_phone(raw_value TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  digits TEXT;
BEGIN
  digits := regexp_replace(COALESCE(raw_value, ''), '\\D', '', 'g');
  IF digits = '' THEN
    RETURN NULL;
  END IF;

  IF length(digits) = 10 THEN
    digits := '7' || digits;
  ELSIF length(digits) = 11 AND left(digits, 1) = '8' THEN
    digits := '7' || substring(digits from 2);
  END IF;

  IF length(digits) = 11 AND left(digits, 1) = '7' THEN
    RETURN digits::BIGINT;
  END IF;

  RETURN NULL;
END;
$$;

WITH source_phone AS (
  SELECT
    u.id AS user_id,
    CASE
      WHEN u.phone IS NOT NULL THEN 'User.phone'
      WHEN ep.phone IS NOT NULL THEN 'EmployeeProfile.phone'
      WHEN cp.phone IS NOT NULL THEN 'ClientProfile.phone'
      WHEN sp.phone IS NOT NULL THEN 'SupplierProfile.phone'
      ELSE 'none'
    END AS source_field,
    COALESCE(u.phone, ep.phone, cp.phone, sp.phone) AS raw_phone,
    normalize_ru_phone(COALESCE(u.phone, ep.phone, cp.phone, sp.phone)) AS normalized_phone
  FROM "User" u
  LEFT JOIN "EmployeeProfile" ep ON ep."userId" = u.id
  LEFT JOIN "ClientProfile" cp ON cp."userId" = u.id
  LEFT JOIN "SupplierProfile" sp ON sp."userId" = u.id
)
UPDATE "User" u
SET "phone_new" = sp.normalized_phone
FROM source_phone sp
WHERE u.id = sp.user_id;

WITH source_phone AS (
  SELECT
    u.id AS user_id,
    CASE
      WHEN u.phone IS NOT NULL THEN 'User.phone'
      WHEN ep.phone IS NOT NULL THEN 'EmployeeProfile.phone'
      WHEN cp.phone IS NOT NULL THEN 'ClientProfile.phone'
      WHEN sp.phone IS NOT NULL THEN 'SupplierProfile.phone'
      ELSE 'none'
    END AS source_field,
    COALESCE(u.phone, ep.phone, cp.phone, sp.phone) AS raw_phone,
    normalize_ru_phone(COALESCE(u.phone, ep.phone, cp.phone, sp.phone)) AS normalized_phone
  FROM "User" u
  LEFT JOIN "EmployeeProfile" ep ON ep."userId" = u.id
  LEFT JOIN "ClientProfile" cp ON cp."userId" = u.id
  LEFT JOIN "SupplierProfile" sp ON sp."userId" = u.id
)
INSERT INTO "UserPhoneMigrationReport" ("userId", "sourceField", "rawValue", "normalizedValue", "reason")
SELECT
  user_id,
  source_field,
  raw_phone,
  NULL,
  'INVALID_PHONE_FORMAT'
FROM source_phone
WHERE raw_phone IS NOT NULL
  AND normalized_phone IS NULL;

WITH dupes AS (
  SELECT
    id AS user_id,
    "phone_new" AS phone_value,
    ROW_NUMBER() OVER (PARTITION BY "phone_new" ORDER BY id ASC) AS rn
  FROM "User"
  WHERE "phone_new" IS NOT NULL
)
INSERT INTO "UserPhoneMigrationReport" ("userId", "sourceField", "rawValue", "normalizedValue", "reason")
SELECT
  user_id,
  'User.phone_new',
  phone_value::TEXT,
  phone_value::TEXT,
  'DUPLICATE_NORMALIZED_PHONE_DROPPED'
FROM dupes
WHERE rn > 1;

WITH dupes AS (
  SELECT
    id AS user_id,
    ROW_NUMBER() OVER (PARTITION BY "phone_new" ORDER BY id ASC) AS rn
  FROM "User"
  WHERE "phone_new" IS NOT NULL
)
UPDATE "User" u
SET "phone_new" = NULL
FROM dupes d
WHERE u.id = d.user_id
  AND d.rn > 1;

DROP INDEX IF EXISTS "User_phone_key";

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "phone";

ALTER TABLE "User"
  RENAME COLUMN "phone_new" TO "phone";

CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone");

ALTER TABLE "EmployeeProfile" DROP COLUMN IF EXISTS "phone";
ALTER TABLE "ClientProfile" DROP COLUMN IF EXISTS "phone";
ALTER TABLE "SupplierProfile" DROP COLUMN IF EXISTS "phone";

DROP FUNCTION IF EXISTS normalize_ru_phone(TEXT);