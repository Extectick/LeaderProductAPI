CREATE TABLE IF NOT EXISTS "TrackingDeviceToken" (
  "id" SERIAL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "installId" TEXT,
  "deviceSessionId" TEXT,
  "platform" TEXT,
  "appVersion" TEXT,
  "deviceName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "TrackingDeviceToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TrackingDeviceToken_tokenHash_key"
  ON "TrackingDeviceToken"("tokenHash");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_userId_idx"
  ON "TrackingDeviceToken"("userId");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_installId_idx"
  ON "TrackingDeviceToken"("installId");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_deviceSessionId_idx"
  ON "TrackingDeviceToken"("deviceSessionId");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_revokedAt_idx"
  ON "TrackingDeviceToken"("revokedAt");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_expiresAt_idx"
  ON "TrackingDeviceToken"("expiresAt");
