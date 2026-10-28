-- Additive private image metadata; originals and existing message bindings are unchanged.
ALTER TABLE "HelpAttachment"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "thumbnailDataUri" TEXT,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Legacy messages never recorded send order. Preserve their deterministic creation order.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "messageId" ORDER BY "createdAt", "id") - 1 AS position
  FROM "HelpAttachment" WHERE "messageId" IS NOT NULL
)
UPDATE "HelpAttachment" AS attachment SET "position" = ordered.position::INTEGER
FROM ordered WHERE attachment."id" = ordered."id";

ALTER TABLE "HelpAttachment"
  ADD CONSTRAINT "HelpAttachment_image_dimensions_check" CHECK (
    ("width" IS NULL AND "height" IS NULL) OR ("width" > 0 AND "height" > 0 AND "width" IS NOT NULL AND "height" IS NOT NULL)
  ),
  ADD CONSTRAINT "HelpAttachment_thumbnail_size_check" CHECK ("thumbnailDataUri" IS NULL OR octet_length("thumbnailDataUri") <= 2048),
  ADD CONSTRAINT "HelpAttachment_position_check" CHECK ("position" >= 0);
