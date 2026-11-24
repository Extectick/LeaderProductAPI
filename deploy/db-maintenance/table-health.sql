BEGIN READ ONLY;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='150ms';
SELECT json_build_object(
  'utc', now() AT TIME ZONE 'UTC', 'databaseBytes',pg_database_size(current_database()),
  'postgresStartedAt',pg_postmaster_start_time(), 'statisticsResetAt',
    (SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()),
  'tables',(SELECT jsonb_object_agg(relname,jsonb_build_array(pg_total_relation_size(relid),
     pg_indexes_size(relid),n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del))
     FROM pg_stat_user_tables WHERE schemaname='public'),
  'indexBytes',(SELECT jsonb_object_agg(indexrelname,pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE schemaname='public'),
  'indexScans',(SELECT jsonb_object_agg(indexrelname,idx_scan) FROM pg_stat_user_indexes WHERE schemaname='public')
);
COMMIT;
