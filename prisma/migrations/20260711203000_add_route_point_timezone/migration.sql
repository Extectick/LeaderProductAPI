ALTER TABLE "RoutePoint"
    ADD COLUMN IF NOT EXISTS "recordedTimeZone" TEXT,
    ADD COLUMN IF NOT EXISTS "recordedTimezoneOffsetMinutes" INTEGER;
