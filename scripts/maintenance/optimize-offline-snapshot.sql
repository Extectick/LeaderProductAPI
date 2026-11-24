-- Run with psql in autocommit mode. Supply expected_db and the physical
-- rebuild_above_bytes threshold derived from a freshly rebuilt copy of this
-- index. This is a scoped maintenance pass, not a periodic rebuild schedule.
-- Example for the Nov 2026 copy: -v expected_db=LeaderAPI -v rebuild_above_bytes=80000000
\set ON_ERROR_STOP on
SET application_name = 'leader-offline-snapshot-maintenance';
SET search_path = pg_catalog, public;
SET lock_timeout = '800ms';
SET statement_timeout = '90s';
SET maintenance_work_mem = '128MB';
SET vacuum_cost_delay = '2ms';

SELECT set_config('leader.snapshot_expected_db', :'expected_db', false);
SELECT set_config('leader.snapshot_rebuild_above', :'rebuild_above_bytes', false);
DO $guard$
DECLARE
  target oid := to_regclass('public."OfflineDatasetRow"');
  key_index oid := to_regclass('public."OfflineDatasetRow_pkey"');
BEGIN
  IF current_database() <> current_setting('leader.snapshot_expected_db') OR pg_is_in_recovery() THEN
    RAISE EXCEPTION 'Wrong target database or recovery in progress';
  END IF;
  IF current_setting('leader.snapshot_rebuild_above')::bigint <= 0 THEN
    RAISE EXCEPTION 'Specify a positive rebuild threshold from the copy measurement';
  END IF;
  IF NOT pg_try_advisory_lock(1701696624, 1949397841) THEN
    RAISE EXCEPTION 'Another snapshot maintenance session is running';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = target AND indexrelid = key_index
    AND indisunique AND indisprimary AND indisready AND indisvalid AND indislive AND indnkeyatts = 3
    AND pg_get_indexdef(key_index, 1, true) = '"scopeKey"'
    AND pg_get_indexdef(key_index, 2, true) = 'entity'
    AND pg_get_indexdef(key_index, 3, true) = '"itemKey"') THEN
    RAISE EXCEPTION 'Unexpected snapshot primary index';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index WHERE indrelid = target AND NOT indisvalid)
     OR EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE relid = target) THEN
    RAISE EXCEPTION 'Unfinished index operation on the snapshot table; inspect before retry';
  END IF;
END $guard$;

SELECT json_build_object('phase','before','at',clock_timestamp(),'tableOid',t.oid,'totalBytes',pg_total_relation_size(t.oid),
  'indexBytes',pg_relation_size(i.oid),'options',t.reloptions) FROM pg_class t, pg_class i
WHERE t.oid='public."OfflineDatasetRow"'::regclass AND i.oid='public."OfflineDatasetRow_pkey"'::regclass;
SELECT NOT (coalesce(reloptions, ARRAY[]::text[]) @> ARRAY['autovacuum_vacuum_scale_factor=0.05','autovacuum_analyze_scale_factor=0.05']) AS tune
FROM pg_class WHERE oid='public."OfflineDatasetRow"'::regclass \gset
\if :tune
ALTER TABLE public."OfflineDatasetRow" SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.05);
\endif

SELECT pg_relation_size('public."OfflineDatasetRow_pkey"') > :'rebuild_above_bytes'::bigint AS rebuild \gset
\if :rebuild
REINDEX INDEX CONCURRENTLY public."OfflineDatasetRow_pkey";
\endif
-- Prevent heap tail truncation from requesting ACCESS EXCLUSIVE on this hot table.
VACUUM (ANALYZE, TRUNCATE FALSE) public."OfflineDatasetRow";

SELECT json_build_object('phase','after','at',clock_timestamp(),'tableOid',t.oid,'totalBytes',pg_total_relation_size(t.oid),
  'indexBytes',pg_relation_size(i.indexrelid),'primaryValid',i.indisprimary AND i.indisvalid AND i.indisready AND i.indislive,
  'options',t.reloptions,'indexRebuilt',:'rebuild'::boolean)
FROM pg_class t JOIN pg_index i ON i.indrelid=t.oid
WHERE t.oid='public."OfflineDatasetRow"'::regclass AND i.indexrelid='public."OfflineDatasetRow_pkey"'::regclass;
SELECT pg_advisory_unlock(1701696624, 1949397841);
