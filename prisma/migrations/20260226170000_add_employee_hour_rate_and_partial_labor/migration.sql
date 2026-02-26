-- AlterEnum
ALTER TYPE "AppealLaborPaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

-- AlterTable
ALTER TABLE "EmployeeProfile"
ADD COLUMN "appealLaborHourlyRate" DECIMAL(8,2);

ALTER TABLE "AppealLaborEntry"
ADD COLUMN "paidHours" DECIMAL(8,2) NOT NULL DEFAULT 0.0;

ALTER TABLE "AppealLaborAuditLog"
ADD COLUMN "oldPaidHours" DECIMAL(8,2),
ADD COLUMN "newPaidHours" DECIMAL(8,2);

-- Backfill paidHours from legacy paymentStatus
UPDATE "AppealLaborEntry"
SET "paidHours" = CASE
  WHEN "paymentStatus" = 'PAID' THEN "hours"
  ELSE 0
END;

-- Normalize and recalculate paymentStatus by effective rate and paidHours
WITH normalized AS (
  SELECT
    e."id",
    e."hours"::numeric AS accrued,
    GREATEST(0, LEAST(e."paidHours"::numeric, e."hours"::numeric)) AS paid_clamped,
    CASE
      WHEN NOT d."appealPaymentRequired" THEN 0::numeric
      ELSE COALESCE(ep."appealLaborHourlyRate"::numeric, d."appealLaborHourlyRate"::numeric, 0::numeric)
    END AS effective_rate
  FROM "AppealLaborEntry" e
  JOIN "Appeal" a ON a."id" = e."appealId"
  JOIN "Department" d ON d."id" = a."toDepartmentId"
  LEFT JOIN "EmployeeProfile" ep ON ep."userId" = e."assigneeUserId"
)
UPDATE "AppealLaborEntry" e
SET
  "paidHours" = CASE
    WHEN n.effective_rate <= 0 THEN 0
    ELSE n.paid_clamped
  END,
  "paymentStatus" = CASE
    WHEN n.effective_rate <= 0 THEN 'NOT_REQUIRED'::"AppealLaborPaymentStatus"
    WHEN n.paid_clamped <= 0 THEN 'UNPAID'::"AppealLaborPaymentStatus"
    WHEN n.paid_clamped < n.accrued THEN 'PARTIAL'::"AppealLaborPaymentStatus"
    ELSE 'PAID'::"AppealLaborPaymentStatus"
  END,
  "paidAt" = CASE
    WHEN n.effective_rate > 0 AND n.paid_clamped >= n.accrued THEN COALESCE(e."paidAt", NOW())
    ELSE NULL
  END,
  "paidById" = CASE
    WHEN n.effective_rate > 0 AND n.paid_clamped >= n.accrued THEN e."paidById"
    ELSE NULL
  END
FROM normalized n
WHERE e."id" = n."id";

-- Constraint
ALTER TABLE "AppealLaborEntry"
ADD CONSTRAINT "AppealLaborEntry_hours_paidHours_check"
CHECK ("hours" >= 0 AND "paidHours" >= 0 AND "paidHours" <= "hours");
