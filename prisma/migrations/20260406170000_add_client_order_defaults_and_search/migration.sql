CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  CREATE TYPE "ClientOrderDeliveryDateMode" AS ENUM ('NEXT_DAY', 'OFFSET_DAYS', 'FIXED_DATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Counterparty"
  ADD COLUMN IF NOT EXISTS "defaultAgreementId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultContractId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultWarehouseId" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultDeliveryAddressId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'Counterparty' AND constraint_name = 'Counterparty_defaultAgreementId_fkey'
  ) THEN
    ALTER TABLE "Counterparty"
      ADD CONSTRAINT "Counterparty_defaultAgreementId_fkey"
      FOREIGN KEY ("defaultAgreementId") REFERENCES "ClientAgreement"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'Counterparty' AND constraint_name = 'Counterparty_defaultContractId_fkey'
  ) THEN
    ALTER TABLE "Counterparty"
      ADD CONSTRAINT "Counterparty_defaultContractId_fkey"
      FOREIGN KEY ("defaultContractId") REFERENCES "ClientContract"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'Counterparty' AND constraint_name = 'Counterparty_defaultWarehouseId_fkey'
  ) THEN
    ALTER TABLE "Counterparty"
      ADD CONSTRAINT "Counterparty_defaultWarehouseId_fkey"
      FOREIGN KEY ("defaultWarehouseId") REFERENCES "Warehouse"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'Counterparty' AND constraint_name = 'Counterparty_defaultDeliveryAddressId_fkey'
  ) THEN
    ALTER TABLE "Counterparty"
      ADD CONSTRAINT "Counterparty_defaultDeliveryAddressId_fkey"
      FOREIGN KEY ("defaultDeliveryAddressId") REFERENCES "DeliveryAddress"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ClientOrderUserSettings" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "preferredOrganizationId" TEXT,
  "deliveryDateMode" "ClientOrderDeliveryDateMode" NOT NULL DEFAULT 'NEXT_DAY',
  "deliveryDateOffsetDays" INTEGER NOT NULL DEFAULT 1,
  "fixedDeliveryDate" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientOrderUserSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClientOrderUserCounterpartyDefaults" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "organizationId" TEXT NOT NULL,
  "counterpartyId" TEXT NOT NULL,
  "agreementId" TEXT,
  "contractId" TEXT,
  "warehouseId" TEXT,
  "deliveryAddressId" TEXT,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientOrderUserCounterpartyDefaults_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserSettings' AND constraint_name = 'ClientOrderUserSettings_userId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserSettings"
      ADD CONSTRAINT "ClientOrderUserSettings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserSettings' AND constraint_name = 'ClientOrderUserSettings_preferredOrganizationId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserSettings"
      ADD CONSTRAINT "ClientOrderUserSettings_preferredOrganizationId_fkey"
      FOREIGN KEY ("preferredOrganizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_userId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_organizationId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_counterpartyId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_counterpartyId_fkey"
      FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_agreementId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_agreementId_fkey"
      FOREIGN KEY ("agreementId") REFERENCES "ClientAgreement"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_contractId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_contractId_fkey"
      FOREIGN KEY ("contractId") REFERENCES "ClientContract"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_warehouseId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_warehouseId_fkey"
      FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientOrderUserCounterpartyDefaults' AND constraint_name = 'ClientOrderUserCounterpartyDefaults_deliveryAddressId_fkey'
  ) THEN
    ALTER TABLE "ClientOrderUserCounterpartyDefaults"
      ADD CONSTRAINT "ClientOrderUserCounterpartyDefaults_deliveryAddressId_fkey"
      FOREIGN KEY ("deliveryAddressId") REFERENCES "DeliveryAddress"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ClientOrderUserSettings_userId_key" ON "ClientOrderUserSettings"("userId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserSettings_preferredOrganizationId_idx" ON "ClientOrderUserSettings"("preferredOrganizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_user_org_counterparty_key"
  ON "ClientOrderUserCounterpartyDefaults"("userId", "organizationId", "counterpartyId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_userId_idx" ON "ClientOrderUserCounterpartyDefaults"("userId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_organizationId_idx" ON "ClientOrderUserCounterpartyDefaults"("organizationId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_counterpartyId_idx" ON "ClientOrderUserCounterpartyDefaults"("counterpartyId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_agreementId_idx" ON "ClientOrderUserCounterpartyDefaults"("agreementId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_contractId_idx" ON "ClientOrderUserCounterpartyDefaults"("contractId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_warehouseId_idx" ON "ClientOrderUserCounterpartyDefaults"("warehouseId");
CREATE INDEX IF NOT EXISTS "ClientOrderUserCounterpartyDefaults_deliveryAddressId_idx" ON "ClientOrderUserCounterpartyDefaults"("deliveryAddressId");

CREATE INDEX IF NOT EXISTS "Counterparty_defaultAgreementId_idx" ON "Counterparty"("defaultAgreementId");
CREATE INDEX IF NOT EXISTS "Counterparty_defaultContractId_idx" ON "Counterparty"("defaultContractId");
CREATE INDEX IF NOT EXISTS "Counterparty_defaultWarehouseId_idx" ON "Counterparty"("defaultWarehouseId");
CREATE INDEX IF NOT EXISTS "Counterparty_defaultDeliveryAddressId_idx" ON "Counterparty"("defaultDeliveryAddressId");

CREATE INDEX IF NOT EXISTS "Counterparty_name_trgm_idx" ON "Counterparty" USING gin (LOWER(COALESCE("name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Counterparty_fullName_trgm_idx" ON "Counterparty" USING gin (LOWER(COALESCE("fullName", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Counterparty_inn_trgm_idx" ON "Counterparty" USING gin (LOWER(COALESCE("inn", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Counterparty_kpp_trgm_idx" ON "Counterparty" USING gin (LOWER(COALESCE("kpp", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING gin (LOWER(COALESCE("name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_code_trgm_idx" ON "Product" USING gin (LOWER(COALESCE("code", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_article_trgm_idx" ON "Product" USING gin (LOWER(COALESCE("article", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_sku_trgm_idx" ON "Product" USING gin (LOWER(COALESCE("sku", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ClientAgreement_name_trgm_idx" ON "ClientAgreement" USING gin (LOWER(COALESCE("name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ClientContract_number_trgm_idx" ON "ClientContract" USING gin (LOWER(COALESCE("number", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "DeliveryAddress_fullAddress_trgm_idx" ON "DeliveryAddress" USING gin (LOWER(COALESCE("fullAddress", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Warehouse_name_trgm_idx" ON "Warehouse" USING gin (LOWER(COALESCE("name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Warehouse_code_trgm_idx" ON "Warehouse" USING gin (LOWER(COALESCE("code", '')) gin_trgm_ops);
