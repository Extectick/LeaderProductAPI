-- Add fixed effective hourly rate snapshot for labor entries.
ALTER TABLE "AppealLaborEntry"
ADD COLUMN "effectiveHourlyRateRub" DECIMAL(8,2) NOT NULL DEFAULT 0.0;

-- Backfill snapshot rate from current business rules.
WITH rates AS (
  SELECT
    e."id",
    CASE
      WHEN NOT d."appealPaymentRequired" THEN 0::numeric
      ELSE COALESCE(ep."appealLaborHourlyRate"::numeric, d."appealLaborHourlyRate"::numeric, 0::numeric)
    END AS rate_raw
  FROM "AppealLaborEntry" e
  JOIN "Appeal" a ON a."id" = e."appealId"
  JOIN "Department" d ON d."id" = a."toDepartmentId"
  LEFT JOIN "EmployeeProfile" ep ON ep."userId" = e."assigneeUserId"
)
UPDATE "AppealLaborEntry" e
SET "effectiveHourlyRateRub" = GREATEST(0::numeric, ROUND(r.rate_raw, 2))
FROM rates r
WHERE e."id" = r."id";

ALTER TABLE "AppealLaborEntry"
ADD CONSTRAINT "AppealLaborEntry_effectiveHourlyRateRub_check"
CHECK ("effectiveHourlyRateRub" >= 0);
