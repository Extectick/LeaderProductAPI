CREATE TABLE "public"."AppOtaUpdate" (
    "id" SERIAL NOT NULL,
    "platform" "public"."AppPlatform" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'prod',
    "runtimeVersion" TEXT NOT NULL,
    "updateId" TEXT NOT NULL,
    "manifestKey" TEXT,
    "launchAssetKey" TEXT NOT NULL,
    "launchAssetHash" TEXT,
    "launchAssetType" TEXT NOT NULL DEFAULT 'application/javascript',
    "assets" JSONB,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "commitSha" TEXT,
    "releaseNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppOtaUpdate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppOtaUpdate_updateId_key" ON "public"."AppOtaUpdate"("updateId");
CREATE INDEX "AppOtaUpdate_platform_channel_runtimeVersion_createdAt_idx" ON "public"."AppOtaUpdate"("platform", "channel", "runtimeVersion", "createdAt");
CREATE INDEX "AppOtaUpdate_platform_channel_runtimeVersion_isActive_idx" ON "public"."AppOtaUpdate"("platform", "channel", "runtimeVersion", "isActive");
