-- Scoped dev-only source installation. Owner applies this file; no passwords.
-- The reader receives no privileges on application tables or other schemas.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF current_database()<>'LeaderAPI_dev' THEN RAISE EXCEPTION 'Help learning requires LeaderAPI_dev'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='leader_help_learning_ro') THEN
    CREATE ROLE leader_help_learning_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='leader_help_learning_ro' AND
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='leader_help_learning_ro')) THEN
    RAISE EXCEPTION 'Help learning role is not restricted';
  END IF;
  IF has_schema_privilege('leader_help_learning_ro','public','CREATE') OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
      (has_table_privilege('leader_help_learning_ro',c.oid,'SELECT') OR has_table_privilege('leader_help_learning_ro',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  ) THEN RAISE EXCEPTION 'Help learning role has unexpected application privileges'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS help_learning;
REVOKE ALL ON SCHEMA help_learning FROM PUBLIC,leader_help_learning_ro;
GRANT USAGE ON SCHEMA help_learning TO leader_help_learning_ro;
ALTER ROLE leader_help_learning_ro SET default_transaction_read_only=on;
ALTER ROLE leader_help_learning_ro SET statement_timeout='10s';
ALTER ROLE leader_help_learning_ro SET lock_timeout='2s';
ALTER ROLE leader_help_learning_ro SET idle_in_transaction_session_timeout='15s';
ALTER ROLE leader_help_learning_ro SET search_path=pg_catalog,help_learning;

-- Events deliberately remain global: an excluded ticket still consumes its
-- position in the scan prefix, so the 21st distinct ticket cannot be skipped.
CREATE OR REPLACE VIEW help_learning.events_v1 WITH (security_barrier=true) AS
SELECT id AS event_id,"ticketId" AS ticket_id FROM public."HelpEvent";

CREATE OR REPLACE VIEW help_learning.tickets_v1 WITH (security_barrier=true) AS
SELECT t.id AS ticket_id,t.status,t."closedAt" AS closed_at,t."itRequested" AS it_requested,
  t."updatedAt" AS updated_at,t."messageSequence" AS message_sequence,
  COALESCE((SELECT max(e.id) FROM public."HelpEvent" e WHERE e."ticketId"=t.id),0) AS last_event_id,
  (SELECT count(*)::int FROM public."HelpMessage" m WHERE m."ticketId"=t.id AND m.kind<>'ASSISTANT_PROGRESS') AS message_count,
  (SELECT max(GREATEST(m."createdAt",m."editedAt")) FROM public."HelpMessage" m WHERE m."ticketId"=t.id) AS message_mutation_at,
  (SELECT count(*)::int FROM public."HelpAssistantJob" j WHERE j."ticketId"=t.id) AS job_count,
  (SELECT max(j."updatedAt") FROM public."HelpAssistantJob" j WHERE j."ticketId"=t.id) AS job_mutation_at,
  md5(concat_ws('|',u.id,u."isActive",u."deletedAt",u."profileStatus",ep.status)) AS eligibility_version,
  (SELECT md5(COALESCE(string_agg(concat_ws(':',m."userId",m.role,m."joinedAt"),'|' ORDER BY m."userId"),'')) FROM public."HelpMember" m WHERE m."ticketId"=t.id) AS member_version
FROM public."HelpTicket" t JOIN public."User" u ON u.id=t."ownerId"
LEFT JOIN public."EmployeeProfile" ep ON ep."userId"=u.id
WHERE t.status IN ('OPEN','CLOSED') AND u."isActive"=true AND u."deletedAt" IS NULL
  AND u."profileStatus"::text<>'BLOCKED' AND COALESCE(ep.status::text,'')<>'BLOCKED'
  AND EXISTS (SELECT 1 FROM public."HelpMember" m WHERE m."ticketId"=t.id AND m."userId"=t."ownerId" AND m.role='OWNER');

CREATE OR REPLACE VIEW help_learning.messages_v1 WITH (security_barrier=true) AS
SELECT m."ticketId" AS ticket_id,m.id,m.sequence,
  CASE WHEN m."authorId"=t."ownerId" THEN 'OWNER'
    WHEN m."authorRole"='IT' AND EXISTS (SELECT 1 FROM public."HelpMember" h WHERE h."ticketId"=t.id AND h."userId"=m."authorId" AND h.role='IT') THEN 'IT'
    WHEN m."authorId" IS NULL AND m."authorRole"='ASSISTANT' THEN 'ASSISTANT' ELSE 'OTHER' END AS author_role,
  m.kind,left(m.text,4000) AS text,md5(m.text) AS text_digest,char_length(m.text)>4000 AS text_truncated,
  m.rating,m."createdAt" AS created_at,m."editedAt" AS edited_at
FROM public."HelpMessage" m JOIN public."HelpTicket" t ON t.id=m."ticketId"
JOIN help_learning.tickets_v1 allowed ON allowed.ticket_id=t.id
WHERE m.kind<>'ASSISTANT_PROGRESS';

CREATE OR REPLACE VIEW help_learning.jobs_v1 WITH (security_barrier=true) AS
SELECT j."ticketId" AS ticket_id,j.status,j."errorCode" AS error_code,j.provider,
  j."completedAt" AS completed_at,j."createdAt" AS created_at,j."updatedAt" AS updated_at
FROM public."HelpAssistantJob" j JOIN help_learning.tickets_v1 allowed ON allowed.ticket_id=j."ticketId";
REVOKE ALL ON help_learning.events_v1,help_learning.tickets_v1,help_learning.messages_v1,help_learning.jobs_v1 FROM PUBLIC,leader_help_learning_ro;
GRANT SELECT ON help_learning.events_v1,help_learning.tickets_v1,help_learning.messages_v1,help_learning.jobs_v1 TO leader_help_learning_ro;
COMMIT;
