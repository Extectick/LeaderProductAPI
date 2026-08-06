ALTER TABLE "ClientOrderInvoice"
  ADD COLUMN "realizationDate" DATE,
  ADD COLUMN "invoiceAmount" DECIMAL(18, 2),
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "counterpartyName" TEXT,
  ADD COLUMN "organizationName" TEXT,
  ADD COLUMN "orderNumber" TEXT;
