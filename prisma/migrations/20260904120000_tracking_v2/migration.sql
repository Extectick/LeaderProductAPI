DO $$ BEGIN
  CREATE TYPE "TrackingPointSource" AS ENUM ('LEGACY', 'TRACCAR', 'ORDER_CAPTURE', 'LOCATION_REQUEST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TrackingLocationRequestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'TIMED_OUT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "OrderGeoEventType" AS ENUM ('CREATED', 'SUBMITTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "OrderGeoCaptureStatus" AS ENUM ('CAPTURED', 'UNAVAILABLE', 'PERMISSION_DENIED', 'TIMEOUT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "RoutePoint"
  ADD COLUMN IF NOT EXISTS "trackingDeviceTokenId" INTEGER,
  ADD COLUMN IF NOT EXISTS "source" "TrackingPointSource" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS "batteryLevel" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "altitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "isCharging" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "serverPointKey" TEXT;

ALTER TABLE "TrackingDeviceToken"
  ADD COLUMN IF NOT EXISTS "lastBootstrapAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trackingEnabled" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS "RoutePoint_serverPointKey_key" ON "RoutePoint"("serverPointKey");
CREATE INDEX IF NOT EXISTS "RoutePoint_trackingDeviceTokenId_recordedAt_idx" ON "RoutePoint"("trackingDeviceTokenId", "recordedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "TrackingDeviceToken_active_install_key"
  ON "TrackingDeviceToken"("userId", "installId")
  WHERE "revokedAt" IS NULL AND "installId" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "RoutePoint" ADD CONSTRAINT "RoutePoint_trackingDeviceTokenId_fkey"
    FOREIGN KEY ("trackingDeviceTokenId") REFERENCES "TrackingDeviceToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "TrackingLocationRequest" (
  "id" TEXT NOT NULL,
  "targetUserId" INTEGER NOT NULL,
  "requestedByUserId" INTEGER NOT NULL,
  "trackingDeviceTokenId" INTEGER,
  "routePointId" INTEGER,
  "status" "TrackingLocationRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackingLocationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrackingLocationRequest_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrackingLocationRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrackingLocationRequest_trackingDeviceTokenId_fkey" FOREIGN KEY ("trackingDeviceTokenId") REFERENCES "TrackingDeviceToken"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TrackingLocationRequest_routePointId_fkey" FOREIGN KEY ("routePointId") REFERENCES "RoutePoint"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TrackingLocationRequest_targetUserId_status_requestedAt_idx" ON "TrackingLocationRequest"("targetUserId", "status", "requestedAt");
CREATE INDEX IF NOT EXISTS "TrackingLocationRequest_requestedByUserId_requestedAt_idx" ON "TrackingLocationRequest"("requestedByUserId", "requestedAt");
CREATE INDEX IF NOT EXISTS "TrackingLocationRequest_expiresAt_status_idx" ON "TrackingLocationRequest"("expiresAt", "status");

CREATE TABLE IF NOT EXISTS "OrderGeoEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "routePointId" INTEGER,
  "clientEventId" TEXT NOT NULL,
  "eventType" "OrderGeoEventType" NOT NULL,
  "status" "OrderGeoCaptureStatus" NOT NULL DEFAULT 'CAPTURED',
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "accuracy" DOUBLE PRECISION,
  "source" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderGeoEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderGeoEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderGeoEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderGeoEvent_routePointId_fkey" FOREIGN KEY ("routePointId") REFERENCES "RoutePoint"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderGeoEvent_userId_clientEventId_key" ON "OrderGeoEvent"("userId", "clientEventId");
CREATE INDEX IF NOT EXISTS "OrderGeoEvent_orderId_eventType_capturedAt_idx" ON "OrderGeoEvent"("orderId", "eventType", "capturedAt");
CREATE INDEX IF NOT EXISTS "OrderGeoEvent_userId_capturedAt_idx" ON "OrderGeoEvent"("userId", "capturedAt");
CREATE INDEX IF NOT EXISTS "OrderGeoEvent_routePointId_idx" ON "OrderGeoEvent"("routePointId");

WITH tracking_service AS (
  SELECT "id" FROM "Service" WHERE "key" = 'tracking'
)
INSERT INTO "PermissionGroup" ("key", "displayName", "description", "sortOrder", "isSystem", "serviceId", "createdAt", "updatedAt")
SELECT 'service_tracking', 'Сервис: Геомаршруты', 'Права на запись и просмотр геомаршрутов сотрудников.', 150, TRUE, "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM tracking_service
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "Permission" ("name", "displayName", "description", "groupId")
SELECT values."name", values."displayName", values."description", groups."id"
FROM (VALUES
  ('record_own_tracking', 'Запись своего маршрута', 'Разрешает устройству пользователя записывать собственный геомаршрут.'),
  ('view_own_tracking', 'Просмотр своего маршрута', 'Разрешает просматривать собственный геомаршрут.'),
  ('view_department_tracking', 'Маршруты своего отдела', 'Разрешает руководителю просматривать геомаршруты сотрудников своего отдела.'),
  ('view_all_tracking', 'Все геомаршруты', 'Разрешает просматривать геомаршруты всех сотрудников.'),
  ('request_tracking_location', 'Запрос текущей геопозиции', 'Разрешает запросить актуальную геопозицию доступного сотрудника.')
) AS values("name", "displayName", "description")
CROSS JOIN "PermissionGroup" groups
WHERE groups."key" = 'service_tracking'
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT roles."id", permissions."id"
FROM "Role" roles
JOIN "Permission" permissions ON permissions."name" IN ('record_own_tracking', 'view_own_tracking')
WHERE roles."name" = 'employee'
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT roles."id", permissions."id"
FROM "Role" roles
JOIN "Permission" permissions ON permissions."name" IN ('record_own_tracking', 'view_own_tracking', 'view_department_tracking', 'request_tracking_location')
WHERE roles."name" = 'department_manager'
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermissions" ("roleId", "permissionId")
SELECT roles."id", permissions."id"
FROM "Role" roles
JOIN "Permission" permissions ON permissions."name" IN ('record_own_tracking', 'view_own_tracking', 'view_department_tracking', 'view_all_tracking', 'request_tracking_location')
WHERE roles."name" = 'admin'
ON CONFLICT DO NOTHING;
