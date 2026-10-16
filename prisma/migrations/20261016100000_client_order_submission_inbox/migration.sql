CREATE TABLE "ClientOrderSubmission" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "clientRevision" INTEGER NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "orderGuid" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientOrderSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientOrderSubmission_revision_check" CHECK ("clientRevision" > 0),
    CONSTRAINT "ClientOrderSubmission_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "ClientOrderSubmission_state_check" CHECK ("state" IN ('ACCEPTED','PROCESSING','RETRY','QUEUED','NEEDS_REVIEW','REJECTED')),
    CONSTRAINT "ClientOrderSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ClientOrderSubmission_userId_clientOrderId_clientRevision_key"
    ON "ClientOrderSubmission"("userId", "clientOrderId", "clientRevision");
CREATE INDEX "ClientOrderSubmission_state_nextAttemptAt_acceptedAt_idx"
    ON "ClientOrderSubmission"("state", "nextAttemptAt", "acceptedAt");
CREATE INDEX "ClientOrderSubmission_userId_updatedAt_idx"
    ON "ClientOrderSubmission"("userId", "updatedAt");
