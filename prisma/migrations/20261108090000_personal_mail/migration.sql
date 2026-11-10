CREATE TABLE IF NOT EXISTS "PersonalMailConnection" (
 "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "provider" TEXT NOT NULL CHECK ("provider" IN ('mail','yandex')),
 "email" TEXT NOT NULL DEFAULT '', "passwordCipher" TEXT, "verifiedAt" TIMESTAMPTZ,
 "revision" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0,
 "attemptWindow" TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY ("userId","provider")
);
CREATE TABLE IF NOT EXISTS "HelpMailDraft" (
 "id" UUID PRIMARY KEY, "ownerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "ticketId" INTEGER NOT NULL REFERENCES "HelpTicket"("id") ON DELETE CASCADE,
 "provider" TEXT NOT NULL, "connectionRevision" INTEGER NOT NULL, "sender" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "contentHash" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','SENDING','SENT','UNKNOWN','FAILED')),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "attemptedAt" TIMESTAMPTZ, "sentAt" TIMESTAMPTZ,
 "messageId" TEXT, UNIQUE ("ownerId","ticketId","contentHash")
);
CREATE INDEX IF NOT EXISTS "HelpMailDraft_owner_created_idx" ON "HelpMailDraft" ("ownerId","createdAt");
