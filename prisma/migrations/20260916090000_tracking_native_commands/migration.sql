ALTER TABLE "TrackingDeviceToken" ADD COLUMN "lastCommandPollAt" TIMESTAMP(3);
CREATE INDEX "TrackingLocationRequest_device_status_expires_idx" ON "TrackingLocationRequest" ("trackingDeviceTokenId", "status", "expiresAt");
