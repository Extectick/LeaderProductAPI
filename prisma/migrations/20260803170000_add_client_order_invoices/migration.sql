-- Invoice request flag stored on the manager order sent to 1C.
ALTER TABLE "Order" ADD COLUMN "invoiceRequested" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "ClientOrderInvoiceState" AS ENUM ('WAITING', 'QUEUED', 'SENDING', 'PARTIAL', 'SENT', 'ERROR', 'SUPERSEDED', 'CANCELLED');
CREATE TYPE "ClientOrderInvoiceDeliveryChannel" AS ENUM ('TELEGRAM', 'MAX');
CREATE TYPE "ClientOrderInvoiceDeliveryState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'ERROR', 'SKIPPED');

CREATE TABLE "ClientOrderInvoicePreference" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "counterpartyId" TEXT NOT NULL,
  "invoiceRequested" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientOrderInvoicePreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientOrderInvoice" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "realizationGuid" TEXT NOT NULL,
  "realizationNumber" TEXT,
  "businessHash" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "token" TEXT NOT NULL,
  "state" "ClientOrderInvoiceState" NOT NULL DEFAULT 'WAITING',
  "waitReason" TEXT,
  "readyAt" TIMESTAMP(3),
  "s3Key" TEXT,
  "fileName" TEXT,
  "contentType" TEXT,
  "fileSize" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "onecUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientOrderInvoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientOrderInvoiceDelivery" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "channel" "ClientOrderInvoiceDeliveryChannel" NOT NULL,
  "state" "ClientOrderInvoiceDeliveryState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "externalId" TEXT,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientOrderInvoiceDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientOrderInvoicePreference_userId_counterpartyId_key" ON "ClientOrderInvoicePreference"("userId", "counterpartyId");
CREATE INDEX "ClientOrderInvoicePreference_counterpartyId_idx" ON "ClientOrderInvoicePreference"("counterpartyId");
CREATE UNIQUE INDEX "ClientOrderInvoice_token_key" ON "ClientOrderInvoice"("token");
CREATE UNIQUE INDEX "ClientOrderInvoice_orderId_realizationGuid_token_key" ON "ClientOrderInvoice"("orderId", "realizationGuid", "token");
CREATE INDEX "ClientOrderInvoice_orderId_realizationGuid_version_idx" ON "ClientOrderInvoice"("orderId", "realizationGuid", "version");
CREATE INDEX "ClientOrderInvoice_state_nextAttemptAt_idx" ON "ClientOrderInvoice"("state", "nextAttemptAt");
CREATE INDEX "ClientOrderInvoice_realizationGuid_businessHash_idx" ON "ClientOrderInvoice"("realizationGuid", "businessHash");
CREATE UNIQUE INDEX "ClientOrderInvoiceDelivery_invoiceId_channel_key" ON "ClientOrderInvoiceDelivery"("invoiceId", "channel");
CREATE INDEX "ClientOrderInvoiceDelivery_state_nextAttemptAt_idx" ON "ClientOrderInvoiceDelivery"("state", "nextAttemptAt");

ALTER TABLE "ClientOrderInvoicePreference" ADD CONSTRAINT "ClientOrderInvoicePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientOrderInvoicePreference" ADD CONSTRAINT "ClientOrderInvoicePreference_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientOrderInvoice" ADD CONSTRAINT "ClientOrderInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientOrderInvoiceDelivery" ADD CONSTRAINT "ClientOrderInvoiceDelivery_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ClientOrderInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
