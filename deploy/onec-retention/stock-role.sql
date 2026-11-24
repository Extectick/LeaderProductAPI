BEGIN;
DO $$
DECLARE
  role_id oid;
BEGIN
  IF current_database() NOT IN ('LeaderAPI','LeaderAPI_retention_copy') THEN RAISE EXCEPTION 'Wrong database'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='leader_stock_stage_maintenance') THEN
    CREATE ROLE leader_stock_stage_maintenance NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  SELECT oid INTO role_id FROM pg_roles WHERE rolname='leader_stock_stage_maintenance'
    AND NOT (rolcanlogin OR rolbypassrls OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit);
  IF role_id IS NULL OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=role_id OR roleid=role_id)
    OR NOT pg_has_role(current_user,role_id,'SET') THEN RAISE EXCEPTION 'Unsafe role'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('"OnecSyncSession"'::regclass,'"OnecStageStock"'::regclass) AND relrowsecurity) THEN RAISE EXCEPTION 'Review row-level policies'; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO leader_stock_stage_maintenance;
GRANT SELECT (id, status, notes, "selectedEntities","replaceMode","completedAt","lastActivityAt"), UPDATE (id) ON "OnecSyncSession" TO leader_stock_stage_maintenance;
GRANT SELECT (id, "sessionId", "organizationGuid","warehouseGuid","resolveStatus","lastResolveError","resolvedAt","lastImportedAt"),UPDATE (id),DELETE ON "OnecStageStock" TO leader_stock_stage_maintenance;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
    has_table_privilege('leader_stock_stage_maintenance',c.oid,'INSERT,UPDATE,TRUNCATE,TRIGGER,REFERENCES') OR
    (c.oid <> '"OnecStageStock"'::regclass AND has_table_privilege('leader_stock_stage_maintenance',c.oid,'DELETE'))))
 OR EXISTS (SELECT FROM information_schema.column_privileges WHERE grantee='leader_stock_stage_maintenance'
 AND table_schema='public' AND privilege_type='UPDATE' AND (column_name<>'id' OR table_name NOT IN ('OnecStageStock','OnecSyncSession'))) THEN RAISE EXCEPTION 'Unexpected write privileges'; END IF;
END $$;
COMMIT;
