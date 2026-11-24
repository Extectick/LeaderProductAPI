-- Scoped to indexes with demonstrated excess space in the November 2026 copy.
-- Run using psql autocommit and -v expected_db=... . This is a one-off pass.
\set ON_ERROR_STOP on
SET application_name = 'leader-sync-run-index-maintenance';
SET search_path = pg_catalog,public;
SET lock_timeout = '800ms';
SET statement_timeout = '90s';
SET maintenance_work_mem = '128MB';
SELECT set_config('leader.sync_run_expected_db', :'expected_db', false);
DO $guard$
BEGIN
  IF current_database() <> current_setting('leader.sync_run_expected_db') OR pg_is_in_recovery() THEN
    RAISE EXCEPTION 'Wrong sync run maintenance target';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid='public."SyncRun_startedAt_idx"'::regclass
      AND i.indrelid='public."SyncRun"'::regclass AND i.indisvalid AND i.indisready
      AND i.indislive AND NOT i.indisunique AND i.indpred IS NULL AND i.indnatts=1
      AND pg_get_indexdef(i.indexrelid, 1, true)='"startedAt"'
  ) THEN RAISE EXCEPTION 'Invalid or incompatible SyncRun_startedAt_idx'; END IF;
  IF NOT pg_try_advisory_lock(1701696624,1949397842) THEN
    RAISE EXCEPTION 'Another sync run index maintenance session is active';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index WHERE indrelid IN ('public."SyncRun"'::regclass,'public."SyncRunItem"'::regclass) AND NOT indisvalid)
    OR EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE relid IN ('public."SyncRun"'::regclass,'public."SyncRunItem"'::regclass)) THEN
    RAISE EXCEPTION 'Unfinished sync run index operation; inspect before proceeding';
  END IF;
END $guard$;
-- Use actual row counts so future legitimate data growth cannot by itself trigger another rebuild.
CREATE TEMP TABLE compact_sync_index AS
WITH sizes(index_name,index_table,copy_rows,copy_bytes) AS (VALUES
 ('SyncRun_pkey','SyncRun',200013,9969664),
 ('SyncRun_requestId_key','SyncRun',200013,11829248),
 ('SyncRun_entity_direction_startedAt_idx','SyncRun',200013,6332416),
 ('SyncRun_status_startedAt_idx','SyncRun',200013,6332416),
 ('SyncRunItem_key_idx','SyncRunItem',157274,7380992)
), counts(index_table,live_rows) AS (
 SELECT 'SyncRun',count(*) FROM public."SyncRun" UNION ALL SELECT 'SyncRunItem',count(*) FROM public."SyncRunItem"
)
SELECT s.index_name, pg_relation_size(i.indexrelid) AS before_bytes,
  ceil(s.copy_bytes::numeric * c.live_rows / s.copy_rows) AS compact_estimate
FROM sizes s JOIN counts c USING(index_table) JOIN pg_index i
 ON i.indexrelid = format('public.%I',s.index_name)::regclass AND i.indrelid=format('public.%I',s.index_table)::regclass;
-- Require both 20% excess vs copy and at least one MB to pay for the concurrent rewrite.
SELECT format('REINDEX INDEX CONCURRENTLY public.%I',index_name)
FROM compact_sync_index WHERE before_bytes>compact_estimate*1.2 AND before_bytes-compact_estimate>1000000
ORDER BY index_name \gexec
ANALYZE public."SyncRun";
ANALYZE public."SyncRunItem";
SELECT jsonb_agg(jsonb_build_object('index',index_name,'before',before_bytes,'after',pg_relation_size(format('public.%I',index_name)::regclass))
  ORDER BY index_name) FROM compact_sync_index;
SELECT pg_advisory_unlock(1701696624,1949397842);
