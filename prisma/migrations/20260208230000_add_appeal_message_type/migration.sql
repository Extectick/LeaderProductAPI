-- Add AppealMessageType enum and system message fields
DO $$ BEGIN
  CREATE TYPE "AppealMessageType" AS ENUM ('USER', 'SYSTEM');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AppealMessage"
  ADD COLUMN IF NOT EXISTS "type" "AppealMessageType" NOT NULL DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS "systemEvent" JSONB;
