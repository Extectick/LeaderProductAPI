-- CreateTable
CREATE TABLE "HelpSchemaVersion" (
    "id" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HelpSchemaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpTicket" (
    "id" SERIAL NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "clientTicketId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "itRequested" BOOLEAN NOT NULL DEFAULT true,
    "sourceTicketId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "messageSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HelpTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpMember" (
    "ticketId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "lastReadSequence" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpMember_pkey" PRIMARY KEY ("ticketId","userId")
);

-- CreateTable
CREATE TABLE "HelpMessage" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "authorRole" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "clientMessageId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "replyToId" INTEGER,
    "forwardedFromId" INTEGER,
    "rating" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "HelpMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpAttachment" (
    "id" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpReaction" (
    "messageId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpReaction_pkey" PRIMARY KEY ("messageId","userId","emoji")
);

-- CreateTable
CREATE TABLE "HelpEvent" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpNotification" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "userId" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HelpTicket_ownerId_status_updatedAt_idx" ON "HelpTicket"("ownerId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "HelpTicket_status_itRequested_updatedAt_idx" ON "HelpTicket"("status", "itRequested", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HelpTicket_ownerId_clientTicketId_key" ON "HelpTicket"("ownerId", "clientTicketId");

-- CreateIndex
CREATE INDEX "HelpMember_userId_idx" ON "HelpMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpMessage_ticketId_authorId_clientMessageId_key" ON "HelpMessage"("ticketId", "authorId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpMessage_ticketId_sequence_key" ON "HelpMessage"("ticketId", "sequence");

-- CreateIndex
CREATE INDEX "HelpAttachment_ownerId_messageId_idx" ON "HelpAttachment"("ownerId", "messageId");

-- CreateIndex
CREATE INDEX "HelpAttachment_objectKey_idx" ON "HelpAttachment"("objectKey");

-- CreateIndex
CREATE INDEX "HelpEvent_ticketId_id_idx" ON "HelpEvent"("ticketId", "id");

-- CreateIndex
CREATE INDEX "HelpNotification_deliveredAt_dueAt_idx" ON "HelpNotification"("deliveredAt", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "HelpNotification_eventId_userId_key" ON "HelpNotification"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "HelpTicket" ADD CONSTRAINT "HelpTicket_sourceTicketId_fkey" FOREIGN KEY ("sourceTicketId") REFERENCES "HelpTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpMember" ADD CONSTRAINT "HelpMember_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpMessage" ADD CONSTRAINT "HelpMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "HelpMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpMessage" ADD CONSTRAINT "HelpMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpAttachment" ADD CONSTRAINT "HelpAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "HelpMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpReaction" ADD CONSTRAINT "HelpReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "HelpMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpEvent" ADD CONSTRAINT "HelpEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Narrow additive registration; no existing access rules or IT grants are changed.
ALTER TABLE "HelpTicket" ADD CONSTRAINT "HelpTicket_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpMember" ADD CONSTRAINT "HelpMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpMessage" ADD CONSTRAINT "HelpMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpAttachment" ADD CONSTRAINT "HelpAttachment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpReaction" ADD CONSTRAINT "HelpReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpEvent" ADD CONSTRAINT "HelpEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HelpNotification" ADD CONSTRAINT "HelpNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Narrow additive registration; no existing access rules or IT grants are changed.
INSERT INTO "Service" ("key","name","kind","route","icon","description","gradientStart","gradientEnd","isActive","defaultVisible","defaultEnabled","createdAt","updatedAt")
VALUES ('help','Помощь','CLOUD','/services/help','chatbubbles-outline','Чат поддержки с IT','#2F88FF','#5768DE',true,true,true,NOW(),NOW())
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "PermissionGroup" ("key","displayName","description","sortOrder","isSystem","serviceId","createdAt","updatedAt")
SELECT 'help','Помощь','Управление очередью поддержки',100,true,"id",NOW(),NOW() FROM "Service" WHERE "key"='help'
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "Permission" ("name","displayName","description","groupId")
SELECT 'manage_help','Работа специалиста IT','Просмотр очереди помощи и подключение к обращениям',"id" FROM "PermissionGroup" WHERE "key"='help'
ON CONFLICT ("name") DO NOTHING;

ALTER TABLE "HelpTicket" ADD CONSTRAINT "HelpTicket_status_check" CHECK ("status" IN ('OPEN','CLOSED'));
ALTER TABLE "HelpMessage" ADD CONSTRAINT "HelpMessage_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 0 AND 5);
ALTER TABLE "HelpMessage" ADD CONSTRAINT "HelpMessage_sequence_check" CHECK ("sequence">0);
