CREATE TABLE IF NOT EXISTS "UserNotificationSettings" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "inAppNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "telegramNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "pushNewMessage" BOOLEAN NOT NULL DEFAULT true,
  "pushStatusChanged" BOOLEAN NOT NULL DEFAULT true,
  "pushDeadlineChanged" BOOLEAN NOT NULL DEFAULT true,
  "telegramNewAppeal" BOOLEAN NOT NULL DEFAULT true,
  "telegramStatusChanged" BOOLEAN NOT NULL DEFAULT true,
  "telegramDeadlineChanged" BOOLEAN NOT NULL DEFAULT true,
  "telegramUnreadReminder" BOOLEAN NOT NULL DEFAULT true,
  "telegramClosureReminder" BOOLEAN NOT NULL DEFAULT true,
  "telegramNewMessage" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserNotificationSettings_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserNotificationSettings_userId_key'
  ) THEN
    ALTER TABLE "UserNotificationSettings"
      ADD CONSTRAINT "UserNotificationSettings_userId_key" UNIQUE ("userId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "UserNotificationSettings_userId_idx"
  ON "UserNotificationSettings"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserNotificationSettings_userId_fkey'
  ) THEN
    ALTER TABLE "UserNotificationSettings"
      ADD CONSTRAINT "UserNotificationSettings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "AppealMute" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "appealId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppealMute_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppealMute_userId_appealId_key'
  ) THEN
    ALTER TABLE "AppealMute"
      ADD CONSTRAINT "AppealMute_userId_appealId_key" UNIQUE ("userId", "appealId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AppealMute_appealId_idx" ON "AppealMute"("appealId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppealMute_userId_fkey'
  ) THEN
    ALTER TABLE "AppealMute"
      ADD CONSTRAINT "AppealMute_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppealMute_appealId_fkey'
  ) THEN
    ALTER TABLE "AppealMute"
      ADD CONSTRAINT "AppealMute_appealId_fkey"
      FOREIGN KEY ("appealId") REFERENCES "Appeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
