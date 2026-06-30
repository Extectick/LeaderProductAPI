ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "lineGuid" TEXT;

UPDATE "OrderItem"
SET "lineGuid" = COALESCE(NULLIF("lineGuid", ''), md5(random()::text || clock_timestamp()::text || "id"))
WHERE "lineGuid" IS NULL OR "lineGuid" = '';

ALTER TABLE "OrderItem" ALTER COLUMN "lineGuid" SET NOT NULL;
ALTER TABLE "OrderItem" ALTER COLUMN "lineGuid" SET DEFAULT md5(random()::text || clock_timestamp()::text);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderItem_orderId_lineGuid_key" ON "OrderItem"("orderId", "lineGuid");
CREATE INDEX IF NOT EXISTS "OrderItem_lineGuid_idx" ON "OrderItem"("lineGuid");
