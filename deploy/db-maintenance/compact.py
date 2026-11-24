#!/usr/bin/env python3
"""One checked table rewrite. No waiting for readers or changing logical contents."""
import argparse
import json
import subprocess
from run import TARGETS, query

TABLES = ("OnecStageAgreement", "OnecStageContract", "OnecStageProductPrice", "OnecStageCounterparty")
if __name__ == "__main__":
    args=argparse.ArgumentParser()
    args.add_argument("target",choices=TARGETS)
    args.add_argument("table",choices=TABLES)
    cfg=args.parse_args()
    table=cfg.table
    tb='public."'+table+'"'
    index='"'+table+'_pkey"'
    # Catalog and hashes are verified under the same table lock before committing.
    checks = f"""SELECT jsonb_build_array(count(*), sum(hash_record_extended(t,271)::numeric), bit_xor(hash_record_extended(t,371))) FROM {tb} t"""
    catalog = f"""SELECT jsonb_build_array(
      (SELECT jsonb_agg(jsonb_build_array(indexrelid,pg_get_indexdef(indexrelid),indisvalid,indisready,indisclustered) order by indexrelid)
       FROM pg_index WHERE indrelid='{tb}'::regclass),
      (SELECT jsonb_agg(jsonb_build_array(oid,pg_get_constraintdef(oid),convalidated) order by oid)
       FROM pg_constraint WHERE conrelid='{tb}'::regclass OR confrelid='{tb}'::regclass))"""
    sql=f"""BEGIN;
    SET LOCAL lock_timeout='100ms'; SET LOCAL statement_timeout='2200ms';
    SET LOCAL idle_in_transaction_session_timeout='2s'; SET LOCAL jit=off;
    SET LOCAL max_parallel_maintenance_workers=0; SET LOCAL max_parallel_workers_per_gather=0;
    DO $$ DECLARE a jsonb; b jsonb; c jsonb; d jsonb; pre bigint; post bigint; elapsed timestamptz:=clock_timestamp(); BEGIN
    IF current_database()<>'{TARGETS[cfg.target][1]}' OR pg_is_in_recovery() OR NOT pg_try_advisory_xact_lock(hashtext('onec-sync-retention-v1'))
        THEN RAISE EXCEPTION 'Wrong DB or maintenance busy'; END IF;
    LOCK TABLE {tb} IN ACCESS EXCLUSIVE MODE NOWAIT;
    IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND
      (wait_event_type='Lock' OR (backend_xmin IS NOT NULL AND xact_start < transaction_timestamp()))) THEN RAISE EXCEPTION 'busy snapshot'; END IF;
    IF EXISTS(SELECT 1 FROM pg_index WHERE indrelid='{tb}'::regclass AND (indisclustered OR NOT indisvalid OR NOT indisready)) THEN RAISE EXCEPTION 'unexpected indexes'; END IF;
    pre:=pg_total_relation_size('{tb}'); a:=({checks}); c:=({catalog});
    CLUSTER {tb} USING {index};
    ALTER TABLE {tb} SET WITHOUT CLUSTER;
    b:=({checks}); d:=({catalog}); post:=pg_total_relation_size('{tb}');
    IF a IS DISTINCT FROM b OR c IS DISTINCT FROM d OR post>=pre THEN RAISE EXCEPTION 'invariant or size check failed % -> %',pre,post; END IF;
    PERFORM set_config('maintenance.proof',json_build_object('table','{table}','rows',a->0,'beforeBytes',pre,'afterBytes',post,
    'verifiedRowsAndCatalog',true,'ms',round(extract(epoch from clock_timestamp()-elapsed)*1000))::text,true);
    END $$;
    SELECT current_setting('maintenance.proof'); COMMIT;"""
    try:
        result=json.loads(query(cfg.target,sql))
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.stderr.split("CONTEXT:")[0].strip())
    print(json.dumps(result))
