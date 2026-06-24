ALTER TABLE "public"."AppOtaUpdate"
ADD COLUMN "otaSequence" INTEGER,
ADD COLUMN "displayVersion" TEXT;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "platform", "channel", "runtimeVersion"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS sequence
  FROM "public"."AppOtaUpdate"
)
UPDATE "public"."AppOtaUpdate" AS ota
SET "otaSequence" = ranked.sequence
FROM ranked
WHERE ota."id" = ranked."id";

UPDATE "public"."AppOtaUpdate"
SET "displayVersion" = CONCAT('v', "runtimeVersion", '.ota.', "otaSequence")
WHERE "otaSequence" IS NOT NULL
  AND "displayVersion" IS NULL;

CREATE INDEX "AppOtaUpdate_platform_channel_runtimeVersion_otaSequence_idx"
ON "public"."AppOtaUpdate"("platform", "channel", "runtimeVersion", "otaSequence");
