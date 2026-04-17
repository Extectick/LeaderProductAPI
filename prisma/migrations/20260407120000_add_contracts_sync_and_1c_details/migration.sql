DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'SyncEntityType'
      AND e.enumlabel = 'CONTRACTS'
  ) THEN
    ALTER TYPE "SyncEntityType" ADD VALUE 'CONTRACTS';
  END IF;
END
$$;

ALTER TABLE "Counterparty"
  ADD COLUMN IF NOT EXISTS "dataVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "isSeparateSubdivision" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "legalEntityType" TEXT,
  ADD COLUMN IF NOT EXISTS "legalOrIndividualType" TEXT,
  ADD COLUMN IF NOT EXISTS "registrationCountryGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "headCounterpartyGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "additionalInfo" TEXT,
  ADD COLUMN IF NOT EXISTS "partnerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "vatByRates4And2" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "okpoCode" TEXT,
  ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "taxNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "internationalName" TEXT,
  ADD COLUMN IF NOT EXISTS "isPredefined" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "predefinedDataName" TEXT;

ALTER TABLE "ClientContract"
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "dataVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "name" TEXT,
  ADD COLUMN IF NOT EXISTS "printName" TEXT,
  ADD COLUMN IF NOT EXISTS "partnerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "bankAccountGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "counterpartyBankAccountGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "contactPersonGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "departmentGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "managerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "cashFlowItemGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "businessOperation" TEXT,
  ADD COLUMN IF NOT EXISTS "financialAccountingGroupGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "activityDirectionGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "currency" TEXT,
  ADD COLUMN IF NOT EXISTS "currencyGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "status" TEXT,
  ADD COLUMN IF NOT EXISTS "contractType" TEXT,
  ADD COLUMN IF NOT EXISTS "purpose" TEXT,
  ADD COLUMN IF NOT EXISTS "isAgreed" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "hasPaymentTerm" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "paymentTermDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "settlementProcedure" TEXT,
  ADD COLUMN IF NOT EXISTS "limitDebtAmount" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "amount" DECIMAL(18, 2),
  ADD COLUMN IF NOT EXISTS "allowedDebtAmount" DECIMAL(18, 2),
  ADD COLUMN IF NOT EXISTS "forbidOverdueDebt" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "vatTaxation" TEXT,
  ADD COLUMN IF NOT EXISTS "vatRate" TEXT,
  ADD COLUMN IF NOT EXISTS "vatDefinedInDocument" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "deliveryMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "carrierPartnerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryZoneGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryTimeFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryTimeTo" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "deliveryAddressFields" TEXT,
  ADD COLUMN IF NOT EXISTS "additionalDeliveryInfo" TEXT;

ALTER TABLE "ClientAgreement"
  ADD COLUMN IF NOT EXISTS "number" TEXT,
  ADD COLUMN IF NOT EXISTS "date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "organizationId" TEXT,
  ADD COLUMN IF NOT EXISTS "dataVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "partnerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "partnerSegmentGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentScheduleGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "documentAmount" DECIMAL(18, 2),
  ADD COLUMN IF NOT EXISTS "isTemplate" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "deliveryTerm" TEXT,
  ADD COLUMN IF NOT EXISTS "priceIncludesVat" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "usedBySalesRepresentatives" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "parentAgreementGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "nomenclatureSegmentGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "validFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "validTo" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "comment" TEXT,
  ADD COLUMN IF NOT EXISTS "isRegular" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "period" TEXT,
  ADD COLUMN IF NOT EXISTS "periodCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "status" TEXT,
  ADD COLUMN IF NOT EXISTS "isAgreed" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "managerGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "businessOperation" TEXT,
  ADD COLUMN IF NOT EXISTS "manualDiscountPercent" DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS "manualMarkupPercent" DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS "availableForExternalUsers" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "usesCounterpartyContracts" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "limitManualDiscounts" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "paymentForm" TEXT,
  ADD COLUMN IF NOT EXISTS "contactPersonGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "settlementProcedure" TEXT,
  ADD COLUMN IF NOT EXISTS "priceCalculationVariant" TEXT,
  ADD COLUMN IF NOT EXISTS "minOrderAmount" DECIMAL(18, 2),
  ADD COLUMN IF NOT EXISTS "orderFrequency" TEXT,
  ADD COLUMN IF NOT EXISTS "individualPriceTypeGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentInCurrency" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "financialAccountingGroupGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "cashFlowItemGuid" TEXT,
  ADD COLUMN IF NOT EXISTS "activityDirectionGuid" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientContract' AND constraint_name = 'ClientContract_organizationId_fkey'
  ) THEN
    ALTER TABLE "ClientContract"
      ADD CONSTRAINT "ClientContract_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ClientAgreement' AND constraint_name = 'ClientAgreement_organizationId_fkey'
  ) THEN
    ALTER TABLE "ClientAgreement"
      ADD CONSTRAINT "ClientAgreement_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "OnecStageContract" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "counterpartyGuid" TEXT,
  "organizationGuid" TEXT,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3),
  "lastImportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolveStatus" "OnecStageResolveStatus" NOT NULL DEFAULT 'PENDING',
  "lastResolveError" TEXT,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "OnecStageContract_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'OnecStageContract' AND constraint_name = 'OnecStageContract_sessionId_fkey'
  ) THEN
    ALTER TABLE "OnecStageContract"
      ADD CONSTRAINT "OnecStageContract_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "OnecSyncSession"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "OnecStageContract_sessionId_sourceKey_key" ON "OnecStageContract"("sessionId", "sourceKey");
CREATE INDEX IF NOT EXISTS "OnecStageContract_sessionId_resolveStatus_idx" ON "OnecStageContract"("sessionId", "resolveStatus");
CREATE INDEX IF NOT EXISTS "OnecStageContract_guid_idx" ON "OnecStageContract"("guid");
CREATE INDEX IF NOT EXISTS "OnecStageContract_counterpartyGuid_idx" ON "OnecStageContract"("counterpartyGuid");
CREATE INDEX IF NOT EXISTS "OnecStageContract_organizationGuid_idx" ON "OnecStageContract"("organizationGuid");

CREATE INDEX IF NOT EXISTS "ClientContract_organizationId_idx" ON "ClientContract"("organizationId");
CREATE INDEX IF NOT EXISTS "ClientContract_status_idx" ON "ClientContract"("status");
CREATE INDEX IF NOT EXISTS "ClientAgreement_organizationId_idx" ON "ClientAgreement"("organizationId");
CREATE INDEX IF NOT EXISTS "ClientAgreement_status_idx" ON "ClientAgreement"("status");
