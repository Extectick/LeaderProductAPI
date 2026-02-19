DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessengerQrAuthProvider') THEN
    CREATE TYPE "MessengerQrAuthProvider" AS ENUM ('TELEGRAM', 'MAX');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessengerQrAuthStatus') THEN
    CREATE TYPE "MessengerQrAuthStatus" AS ENUM (
      'PENDING',
      'AWAITING_CONTACT',
      'VERIFIED',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
      'CONSUMED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "MessengerQrAuthSession" (
  "id" TEXT PRIMARY KEY,
  "provider" "MessengerQrAuthProvider" NOT NULL,
  "startTokenHash" TEXT NOT NULL,
  "clientTokenHash" TEXT NOT NULL,
  "status" "MessengerQrAuthStatus" NOT NULL DEFAULT 'PENDING',
  "messengerUserId" BIGINT,
  "messengerChatId" BIGINT,
  "messengerUsername" TEXT,
  "resolvedUserId" INTEGER,
  "failureReason" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessengerQrAuthSession_startTokenHash_key"
  ON "MessengerQrAuthSession"("startTokenHash");

CREATE UNIQUE INDEX IF NOT EXISTS "MessengerQrAuthSession_clientTokenHash_key"
  ON "MessengerQrAuthSession"("clientTokenHash");

CREATE INDEX IF NOT EXISTS "MessengerQrAuthSession_provider_status_expiresAt_idx"
  ON "MessengerQrAuthSession"("provider", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "MessengerQrAuthSession_provider_messengerUserId_status_idx"
  ON "MessengerQrAuthSession"("provider", "messengerUserId", "status");
