-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextScanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastScanAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "scanLeaseToken" TEXT,
    "scanLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "etag" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "publishedRevision" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "publishedById" INTEGER,
    "allEmployees" BOOLEAN NOT NULL DEFAULT false,
    "allowedUserIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "allowedDepartmentIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "seenScanId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "etag" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "sha256" TEXT,
    "text" TEXT,
    "errorCode" TEXT,
    "extractor" TEXT NOT NULL DEFAULT 'text-v1',
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS (
      to_tsvector('russian'::regconfig, "text") || to_tsvector('simple'::regconfig, "text")
    ) STORED,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeIngestionJob" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeIngestionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeAuditEvent" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "documentId" TEXT,
    "versionId" TEXT,
    "actorId" INTEGER,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_key_key" ON "KnowledgeSource"("key");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_sourceId_seenScanId_idx" ON "KnowledgeDocument"("sourceId", "seenScanId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_sourceId_section_deletedAt_idx" ON "KnowledgeDocument"("sourceId", "section", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_sourceId_remoteId_key" ON "KnowledgeDocument"("sourceId", "remoteId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_documentId_revision_key" ON "KnowledgeVersion"("documentId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_versionId_ordinal_key" ON "KnowledgeChunk"("versionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeIngestionJob_versionId_key" ON "KnowledgeIngestionJob"("versionId");

-- CreateIndex
CREATE INDEX "KnowledgeIngestionJob_status_nextAt_idx" ON "KnowledgeIngestionJob"("status", "nextAt");

-- CreateIndex
CREATE INDEX "KnowledgeAuditEvent_documentId_createdAt_idx" ON "KnowledgeAuditEvent"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "KnowledgeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeIngestionJob" ADD CONSTRAINT "KnowledgeIngestionJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "KnowledgeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "KnowledgeChunk_searchVector_idx" ON "KnowledgeChunk" USING GIN ("searchVector");
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_section_check" CHECK ("section" IN ('COMPANY','AI_WORKSPACE','ARCHIVE','OTHER'));
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_publication_check" CHECK ("publishedRevision" IS NULL OR ("publishedRevision"="currentRevision" AND "section"='COMPANY' AND "deletedAt" IS NULL));
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_size_check" CHECK ("size">=0);
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_status_check" CHECK ("status" IN ('QUEUED','PROCESSING','READY','ERROR','SKIPPED'));
ALTER TABLE "KnowledgeIngestionJob" ADD CONSTRAINT "KnowledgeIngestionJob_status_check" CHECK ("status" IN ('QUEUED','RUNNING','COMPLETED','ERROR','CANCELLED'));

-- Knowledge publishing is a separate privilege; existing IT roles receive no implicit grant.
INSERT INTO "Permission" ("name","displayName","description","groupId")
VALUES ('manage_knowledge','Управление базой знаний','Проверка, публикация и отзыв версий документов',
  (SELECT "id" FROM "PermissionGroup" WHERE "key"='admin'))
ON CONFLICT ("name") DO NOTHING;

