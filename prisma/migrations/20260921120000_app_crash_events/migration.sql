CREATE TABLE "AppCrashEvent" (
  "id" TEXT NOT NULL,
  "project" VARCHAR(100) NOT NULL,
  "eventId" VARCHAR(32) NOT NULL,
  "issueId" VARCHAR(32),
  "environment" VARCHAR(32) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "title" VARCHAR(300) NOT NULL,
  "level" VARCHAR(20) NOT NULL,
  "platform" VARCHAR(40),
  "release" VARCHAR(200),
  "dist" VARCHAR(100),
  "reportedUserId" VARCHAR(64),
  "appVersion" VARCHAR(40),
  "buildNumber" VARCHAR(40),
  "otaUpdateId" VARCHAR(64),
  "runtimeVersion" VARCHAR(40),
  "screen" VARCHAR(160),
  "deviceModel" VARCHAR(100),
  "osVersion" VARCHAR(40),
  CONSTRAINT "AppCrashEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AppCrashEvent_project_eventId_key" ON "AppCrashEvent"("project", "eventId");
CREATE INDEX "AppCrashEvent_occurredAt_id_idx" ON "AppCrashEvent"("occurredAt", "id");
CREATE INDEX "AppCrashEvent_reportedUserId_occurredAt_idx" ON "AppCrashEvent"("reportedUserId", "occurredAt");
