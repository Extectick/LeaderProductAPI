-- Only purge credentials after the whole rotation family has been unusable for 30 days.
BEGIN;
SET LOCAL lock_timeout = '150ms';
SET LOCAL statement_timeout = '4s';
SET LOCAL jit = off;
WITH cutoff AS MATERIALIZED (SELECT (now() AT TIME ZONE 'UTC') - interval '30 days' AS t
                           WHERE pg_try_advisory_xact_lock(hashtext('leader-expired-refresh-tokens'))),
eligible AS MATERIALIZED (
  SELECT r.id FROM "RefreshToken" r, cutoff c
  WHERE greatest(r."expiresAt", r."usedAt", r."graceUntil", r."createdAt") < c.t
    AND NOT EXISTS (
      SELECT 1 FROM "RefreshToken" f WHERE f."familyId" = r."familyId"
        AND greatest(f."expiresAt", f."usedAt", f."graceUntil", f."createdAt") >= c.t
    )
    AND NOT EXISTS (
      SELECT 1 FROM "RefreshToken" f WHERE f."replacedById" = r.id
        AND greatest(f."expiresAt", f."usedAt", f."graceUntil", f."createdAt") >= c.t
    )
  ORDER BY r.id LIMIT 500 FOR UPDATE OF r SKIP LOCKED
), gone AS (
  DELETE FROM "RefreshToken" t USING eligible e WHERE t.id=e.id RETURNING 1
)
SELECT count(*) FROM gone;
COMMIT;
