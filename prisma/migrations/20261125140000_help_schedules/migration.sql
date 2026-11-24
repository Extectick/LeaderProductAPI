CREATE TABLE "HelpSchedule" (
  id text PRIMARY KEY,
  "ownerId" integer NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "ticketId" integer NOT NULL REFERENCES "HelpTicket"(id) ON DELETE CASCADE,
  "messageId" integer NOT NULL UNIQUE REFERENCES "HelpMessage"(id) ON DELETE CASCADE,
  time text NOT NULL CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "timeZone" text NOT NULL,
  warehouse text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('inStock','available')),
  active boolean NOT NULL DEFAULT true,
  due timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "deletedAt" timestamptz,
  cancelled boolean NOT NULL DEFAULT false
);
CREATE INDEX "HelpSchedule_ownerId_createdAt_idx" ON "HelpSchedule" ("ownerId","createdAt" DESC);
CREATE INDEX "HelpSchedule_due_idx" ON "HelpSchedule" (due) WHERE active AND "deletedAt" IS NULL;

CREATE TABLE "HelpScheduleRun" (
  id text PRIMARY KEY,
  "scheduleId" text NOT NULL REFERENCES "HelpSchedule"(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  slot timestamptz,
  "requestId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "finishedAt" timestamptz,
  status text NOT NULL DEFAULT 'queued',
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  error text,
  "onecProof" jsonb,
  "readAt" timestamptz,
  "pushClaimedAt" timestamptz,
  "leaseToken" text,
  "leaseUntil" timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  UNIQUE ("scheduleId",slot),
  UNIQUE ("scheduleId","requestId")
);
CREATE INDEX "HelpScheduleRun_history_idx" ON "HelpScheduleRun" ("scheduleId","finishedAt" DESC,id DESC);
CREATE INDEX "HelpScheduleRun_unread_idx" ON "HelpScheduleRun" ("scheduleId") WHERE status='alert' AND "readAt" IS NULL;
CREATE INDEX "HelpScheduleRun_worker_idx" ON "HelpScheduleRun" (status,"leaseUntil","createdAt");
CREATE INDEX "HelpScheduleRun_push_idx" ON "HelpScheduleRun" ("createdAt") WHERE status='alert' AND "readAt" IS NULL AND "pushClaimedAt" IS NULL;
