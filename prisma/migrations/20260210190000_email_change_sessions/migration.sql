DO $$
BEGIN
  CREATE TYPE "EmailChangeSessionStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'CANCELLED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "EmailChangeSession" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "currentEmail" TEXT,
  "requestedEmail" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" "EmailChangeSessionStatus" NOT NULL DEFAULT 'PENDING',
  "attemptsCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "lastSentAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailChangeSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmailChangeSession_userId_status_idx" ON "EmailChangeSession"("userId", "status");
CREATE INDEX IF NOT EXISTS "EmailChangeSession_requestedEmail_idx" ON "EmailChangeSession"("requestedEmail");
CREATE INDEX IF NOT EXISTS "EmailChangeSession_expiresAt_idx" ON "EmailChangeSession"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EmailChangeSession_userId_fkey'
  ) THEN
    ALTER TABLE "EmailChangeSession"
      ADD CONSTRAINT "EmailChangeSession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
