ALTER TABLE "HelpMessage" ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "HelpMessage" ADD COLUMN "assistantState" JSONB;
ALTER TABLE "HelpEvent" ALTER COLUMN "actorId" DROP NOT NULL;
CREATE TABLE "HelpAssistantJob" (
 "id" TEXT PRIMARY KEY, "taskId" TEXT NOT NULL, "ticketId" INTEGER NOT NULL, "ownerId" INTEGER NOT NULL,
 "messageId" INTEGER NOT NULL UNIQUE, "revision" INTEGER NOT NULL, "contextStartSequence" INTEGER NOT NULL,
 "context" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED', "step" INTEGER NOT NULL DEFAULT 0,
 "attempts" INTEGER NOT NULL DEFAULT 0, "provider" TEXT NOT NULL, "durationMs" INTEGER NOT NULL DEFAULT 5000,
 "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" TIMESTAMP(3), "leaseToken" TEXT,
 "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 "completedAt" TIMESTAMP(3), UNIQUE("taskId","revision"),
 CONSTRAINT "HelpAssistantJob_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpTicket"("id") ON DELETE CASCADE,
 CONSTRAINT "HelpAssistantJob_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "HelpMessage"("id") ON DELETE CASCADE,
 CONSTRAINT "HelpAssistantJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT
);
CREATE INDEX "HelpAssistantJob_status_nextAt_leaseUntil_idx" ON "HelpAssistantJob"("status","nextAt","leaseUntil");
CREATE INDEX "HelpAssistantJob_ticketId_createdAt_idx" ON "HelpAssistantJob"("ticketId","createdAt");
CREATE TABLE "HelpSession" (
 "userId" INTEGER NOT NULL, "sessionId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "socketId" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT FALSE, "ticketId" INTEGER, "expiresAt" TIMESTAMP(3) NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY("userId","sessionId"),
 CONSTRAINT "HelpSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);
CREATE INDEX "HelpSession_userId_expiresAt_idx" ON "HelpSession"("userId","expiresAt");
CREATE TABLE "HelpNotificationAck" (
 "userId" INTEGER NOT NULL, "eventId" INTEGER NOT NULL, "sessionId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("userId","eventId","sessionId"),
 CONSTRAINT "HelpNotificationAck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);
CREATE INDEX "HelpNotificationAck_eventId_userId_idx" ON "HelpNotificationAck"("eventId","userId");
CREATE TABLE "HelpNotificationDelivery" (
 "notificationId" INTEGER NOT NULL, "tokenHash" TEXT NOT NULL, "status" TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY("notificationId","tokenHash"),
 CONSTRAINT "HelpNotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "HelpNotification"("id") ON DELETE CASCADE
);
