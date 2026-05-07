DO $$
BEGIN
  CREATE TYPE "TransportTaskDepartureSource" AS ENUM ('PRESET', 'CUSTOM_MAP', 'DEVICE_LOCATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "UserTransportTaskSettings" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "departureSource" "TransportTaskDepartureSource" NOT NULL,
  "presetKey" TEXT,
  "latitude" DECIMAL(10,6) NOT NULL,
  "longitude" DECIMAL(10,6) NOT NULL,
  "address" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserTransportTaskSettings_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserTransportTaskSettings_userId_key'
  ) THEN
    ALTER TABLE "UserTransportTaskSettings"
      ADD CONSTRAINT "UserTransportTaskSettings_userId_key" UNIQUE ("userId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "UserTransportTaskSettings_userId_idx"
  ON "UserTransportTaskSettings"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserTransportTaskSettings_userId_fkey'
  ) THEN
    ALTER TABLE "UserTransportTaskSettings"
      ADD CONSTRAINT "UserTransportTaskSettings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
