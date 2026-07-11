ALTER TABLE "Order"
    ADD COLUMN IF NOT EXISTS "trackingRoutePointId" INTEGER,
    ADD COLUMN IF NOT EXISTS "trackingSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "Order_trackingRoutePointId_idx"
    ON "Order"("trackingRoutePointId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'Order_trackingRoutePointId_fkey'
    ) THEN
        ALTER TABLE "Order"
            ADD CONSTRAINT "Order_trackingRoutePointId_fkey"
            FOREIGN KEY ("trackingRoutePointId")
            REFERENCES "RoutePoint"("id")
            ON DELETE SET NULL
            ON UPDATE CASCADE;
    END IF;
END $$;
