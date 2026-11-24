-- Post-release smoke on a populated prod copy or on prod. Emits plans and counts only.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '800ms';
DO $check$
DECLARE
  reply json;
BEGIN
  IF (
    SELECT count(*) FROM pg_index
    WHERE indrelid='public."SyncRun"'::regclass AND indisunique AND indisvalid AND indisready AND indislive
      AND indexrelid IN ('public."SyncRun_pkey"'::regclass,'public."SyncRun_requestId_key"'::regclass)
  ) <> 2 THEN RAISE EXCEPTION 'Missing valid primary key or request ID uniqueness'; END IF;
  IF NOT EXISTS (
    SELECT FROM pg_constraint WHERE conrelid='public."SyncRunItem"'::regclass
      AND confrelid='public."SyncRun"'::regclass AND contype='f' AND convalidated
  ) THEN RAISE EXCEPTION 'Missing validated run-item foreign key'; END IF;
  IF EXISTS (
    SELECT FROM pg_index WHERE indrelid IN ('public."SyncRun"'::regclass, 'public."SyncRunItem"'::regclass)
      AND (NOT indisvalid OR NOT indisready OR NOT indislive)
  ) THEN RAISE EXCEPTION 'Invalid index after migration'; END IF;
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT * FROM public."SyncRun" ORDER BY "startedAt" DESC LIMIT 50' INTO reply;
  IF (SELECT reltuples FROM pg_class WHERE oid='public."SyncRun"'::regclass)>10000
    AND NOT jsonb_path_exists(reply::jsonb, '$.**."Index Name" ? (@ == "SyncRun_startedAt_idx")')
  THEN RAISE EXCEPTION 'Time index missing from default list query plan'; END IF;
END $check$;
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT * FROM public."SyncRun" ORDER BY "startedAt" DESC LIMIT 50;
SELECT count(*) AS details, count(*) FILTER (WHERE status='ERROR' OR error IS NOT NULL) AS error_details
FROM public."SyncRunItem";
ROLLBACK;
