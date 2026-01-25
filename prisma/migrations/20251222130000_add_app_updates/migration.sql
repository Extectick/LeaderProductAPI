-- CreateEnum
CREATE TYPE "public"."AppPlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "public"."AppUpdateEventType" AS ENUM ('CHECK', 'PROMPT_SHOWN', 'UPDATE_CLICK', 'DISMISS');

-- CreateTable
CREATE TABLE "public"."AppUpdate" (
    "id" SERIAL NOT NULL,
    "platform" "public"."AppPlatform" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'prod',
    "versionCode" INTEGER NOT NULL,
    "versionName" TEXT NOT NULL,
    "minSupportedVersionCode" INTEGER NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "releaseNotes" TEXT,
    "storeUrl" TEXT,
    "apkKey" TEXT,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "checksumMd5" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AppUpdateEvent" (
    "id" SERIAL NOT NULL,
    "updateId" INTEGER,
    "platform" "public"."AppPlatform" NOT NULL,
    "channel" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL,
    "versionName" TEXT,
    "deviceId" TEXT,
    "eventType" "public"."AppUpdateEventType" NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUpdateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUpdate_platform_channel_versionCode_key" ON "public"."AppUpdate"("platform", "channel", "versionCode");

-- CreateIndex
CREATE INDEX "AppUpdate_platform_channel_versionCode_idx" ON "public"."AppUpdate"("platform", "channel", "versionCode");

-- CreateIndex
CREATE INDEX "AppUpdate_platform_channel_minSupportedVersionCode_idx" ON "public"."AppUpdate"("platform", "channel", "minSupportedVersionCode");

-- CreateIndex
CREATE INDEX "AppUpdateEvent_platform_channel_versionCode_idx" ON "public"."AppUpdateEvent"("platform", "channel", "versionCode");

-- CreateIndex
CREATE INDEX "AppUpdateEvent_deviceId_idx" ON "public"."AppUpdateEvent"("deviceId");

-- CreateIndex
CREATE INDEX "AppUpdateEvent_updateId_idx" ON "public"."AppUpdateEvent"("updateId");

-- AddForeignKey
ALTER TABLE "public"."AppUpdateEvent" ADD CONSTRAINT "AppUpdateEvent_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "public"."AppUpdate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AppUpdateEvent" ADD CONSTRAINT "AppUpdateEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
