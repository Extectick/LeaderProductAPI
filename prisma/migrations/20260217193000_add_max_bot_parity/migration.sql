-- Add MAX auth/notification/phone-verification support.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'AuthProvider' AND e.enumlabel = 'MAX'
  ) THEN
    ALTER TYPE "AuthProvider" ADD VALUE 'MAX';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PhoneVerificationProvider') THEN
    CREATE TYPE "PhoneVerificationProvider" AS ENUM ('TELEGRAM', 'MAX');
  END IF;
END$$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "maxId" BIGINT,
  ADD COLUMN IF NOT EXISTS "maxUsername" TEXT,
  ADD COLUMN IF NOT EXISTS "maxLinkedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_maxId_key" ON "User"("maxId");

ALTER TABLE "UserNotificationSettings"
  ADD COLUMN IF NOT EXISTS "maxNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxNewAppeal" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxStatusChanged" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxDeadlineChanged" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxUnreadReminder" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxClosureReminder" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "maxNewMessage" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "PhoneVerificationSession"
  ADD COLUMN IF NOT EXISTS "provider" "PhoneVerificationProvider" NOT NULL DEFAULT 'TELEGRAM',
  ADD COLUMN IF NOT EXISTS "maxUserId" BIGINT,
  ADD COLUMN IF NOT EXISTS "maxChatId" BIGINT;

CREATE INDEX IF NOT EXISTS "PhoneVerificationSession_maxUserId_idx"
  ON "PhoneVerificationSession"("maxUserId");

CREATE INDEX IF NOT EXISTS "PhoneVerificationSession_maxChatId_idx"
  ON "PhoneVerificationSession"("maxChatId");
