CREATE TABLE IF NOT EXISTS "DeviceSession" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "installId" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeviceSession_userId_idx" ON "DeviceSession"("userId");
CREATE INDEX IF NOT EXISTS "DeviceSession_installId_idx" ON "DeviceSession"("installId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'DeviceSession_userId_fkey'
    ) THEN
        ALTER TABLE "DeviceSession"
            ADD CONSTRAINT "DeviceSession_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

ALTER TABLE "RefreshToken"
    ADD COLUMN IF NOT EXISTS "tokenHash" TEXT,
    ADD COLUMN IF NOT EXISTS "deviceSessionId" TEXT,
    ADD COLUMN IF NOT EXISTS "familyId" TEXT,
    ADD COLUMN IF NOT EXISTS "replacedById" INTEGER,
    ADD COLUMN IF NOT EXISTS "usedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "graceUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX IF NOT EXISTS "RefreshToken_deviceSessionId_idx" ON "RefreshToken"("deviceSessionId");
CREATE INDEX IF NOT EXISTS "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'RefreshToken_deviceSessionId_fkey'
    ) THEN
        ALTER TABLE "RefreshToken"
            ADD CONSTRAINT "RefreshToken_deviceSessionId_fkey"
            FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

ALTER TABLE "RoutePoint"
    ADD COLUMN IF NOT EXISTS "clientPointId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "RoutePoint_userId_clientPointId_key"
    ON "RoutePoint"("userId", "clientPointId");
