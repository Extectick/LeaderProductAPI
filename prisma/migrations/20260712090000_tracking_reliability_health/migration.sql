-- Persist why a device tracking token was rotated. The raw token is never stored.
ALTER TABLE "TrackingDeviceToken"
  ADD COLUMN IF NOT EXISTS "issueReason" TEXT;

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_userId_lastUsedAt_idx"
  ON "TrackingDeviceToken"("userId", "lastUsedAt");

CREATE INDEX IF NOT EXISTS "TrackingDeviceToken_userId_createdAt_idx"
  ON "TrackingDeviceToken"("userId", "createdAt");
