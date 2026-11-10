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
    WHEN m."authorId" IS NULL AND trusted_ai.id IS NOT NULL THEN 'ASSISTANT' ELSE 'OTHER' END AS author_role,
  m.kind,left(m.text,4000) AS text,md5(m.text) AS text_digest,char_length(m.text)>4000 AS text_truncated,
  m.rating,m."createdAt" AS created_at,m."editedAt" AS edited_at,
  -- BEGIN optional metadata: append columns only; existing view dependencies survive.
  true AS metadata_included,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'kind',CASE WHEN a.kind IN ('FILE','IMAGE','AUDIO') THEN a.kind ELSE 'OTHER' END,
    'extension',CASE WHEN lower(substring(a.name from '[.][a-zA-Z0-9]{1,10}$')) IN
      ('.txt','.md','.csv','.json','.xlsx','.docx','.png','.jpg','.jpeg','.gif','.webp','.avif','.heic','.heif','.bmp','.tif','.tiff')
      THEN lower(substring(a.name from '[.][a-zA-Z0-9]{1,10}$')) ELSE NULL END,
    'size',a.size,
    'mimeType',CASE WHEN a."mimeType" IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','text/csv','application/json','application/pdf','application/zip','application/octet-stream',
      'image/png','image/jpeg','image/gif','image/webp','image/avif','image/heic','image/heif','image/bmp','image/tiff','audio/mp4','audio/mpeg','audio/wav','audio/ogg','audio/webm')
      THEN a."mimeType" ELSE NULL END) ORDER BY a.position,a."createdAt",a.id)
    FROM (SELECT a.kind,a.name,a.size,a."mimeType",a.position,a."createdAt",a.id FROM public."HelpAttachment" a
      WHERE a."messageId"=m.id ORDER BY a.position,a."createdAt",a.id LIMIT 4) a),'[]'::jsonb) AS attachments,
  EXISTS (SELECT 1 FROM public."HelpAttachment" a WHERE a."messageId"=m.id OFFSET 4 LIMIT 1) AS attachments_truncated,
  (m."assistantState"->>'activityVersion'='1' AND jsonb_typeof(m."assistantState"->'activities')='array') IS TRUE AS activity_metadata_included,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'toolName',CASE WHEN a.value->>'toolName' IN ('onec_list_metadata_objects','onec_get_metadata_structure','onec_get_access_rights','onec_get_object','onec_execute_query',
      'onec_inspect_metadata','onec_find_latest_purchase','onec_find_latest_receipt','onec_find_latest_order','help_create_spreadsheet','help_create_document','help_search_history','help_read_history','help_read_attachment') THEN a.value->>'toolName' ELSE NULL END,
    'status',CASE WHEN a.value->>'status' IN ('running','completed','failed','stopped') THEN a.value->>'status' ELSE 'unknown' END,
    'errorCode',CASE WHEN a.value->>'errorCode' IN ('ONEC_TOOL_ARGUMENTS','ONEC_QUERY_FORBIDDEN','ONEC_TOOL_FAILED','ONEC_RPC_ERROR','ONEC_REPEATED_REJECTED_REQUEST',
      'ONEC_UNAVAILABLE','ONEC_TIMEOUT','ONEC_RESPONSE_TOO_LARGE','ONEC_FORBIDDEN','ONEC_VAULT_UNAVAILABLE','ONEC_NOT_CONFIGURED','ONEC_UNKNOWN') THEN a.value->>'errorCode' ELSE NULL END) ORDER BY a.ordinality)
    FROM (SELECT value,ordinality FROM jsonb_array_elements(CASE WHEN m."assistantState"->>'activityVersion'='1' AND jsonb_typeof(m."assistantState"->'activities')='array'
      THEN m."assistantState"->'activities' ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
      WHERE value->>'kind'='tool' ORDER BY ordinality DESC LIMIT 8) a),'[]'::jsonb) AS activities,
  EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN m."assistantState"->>'activityVersion'='1' AND jsonb_typeof(m."assistantState"->'activities')='array'
    THEN m."assistantState"->'activities' ELSE '[]'::jsonb END) a(value) WHERE value->>'kind'='tool' OFFSET 8 LIMIT 1) AS activities_truncated,
  CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN m."assistantState"->>'activityVersion'='1' AND jsonb_typeof(m."assistantState"->'activities')='array'
    THEN m."assistantState"->'activities' ELSE '[]'::jsonb END) a(value) WHERE value->>'id'='images' AND value->>'status'='completed') THEN true
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN m."assistantState"->>'activityVersion'='1' AND jsonb_typeof(m."assistantState"->'activities')='array'
    THEN m."assistantState"->'activities' ELSE '[]'::jsonb END) a(value) WHERE value->>'id'='images' AND value->>'status' IN ('failed','stopped')) THEN false
    ELSE NULL END AS images_prepared,
  (trusted_ai.id IS NOT NULL AND jsonb_typeof(m."assistantState")='object' AND
    (jsonb_typeof(m."assistantState"->'questions')='array' OR m."assistantState"->>'status' IN ('queued','thinking','streaming','completed','stopped','error'))) IS TRUE AS questions_metadata_included,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'multiSelect',(q.value->'multiSelect'='true'::jsonb) IS TRUE,
    'optionCount',LEAST(12,jsonb_array_length(CASE WHEN jsonb_typeof(q.value->'options')='array' THEN q.value->'options' ELSE '[]'::jsonb END))) ORDER BY q.ordinality)
    FROM (SELECT value,ordinality FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."assistantState"->'questions')='array'
      THEN m."assistantState"->'questions' ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality) LIMIT 3) q),'[]'::jsonb) AS questions,
  (jsonb_array_length(CASE WHEN jsonb_typeof(m."assistantState"->'questions')='array' THEN m."assistantState"->'questions' ELSE '[]'::jsonb END)>3
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m."assistantState"->'questions')='array'
      THEN m."assistantState"->'questions' ELSE '[]'::jsonb END) q(value) WHERE jsonb_array_length(CASE WHEN jsonb_typeof(q.value->'options')='array' THEN q.value->'options' ELSE '[]'::jsonb END)>12)) AS questions_truncated,
  CASE WHEN trusted_ai.id IS NOT NULL AND m."assistantState"->>'status' IN ('queued','thinking','streaming','completed','stopped','error') THEN m."assistantState"->>'status' ELSE NULL END AS assistant_status
  -- END optional metadata
FROM public."HelpMessage" m JOIN public."HelpTicket" t ON t.id=m."ticketId"
JOIN help_learning.tickets_v1 allowed ON allowed.ticket_id=t.id
LEFT JOIN public."HelpAssistantJob" trusted_ai ON trusted_ai."messageId"=m.id AND trusted_ai."ticketId"=t.id AND trusted_ai."ownerId"=t."ownerId" AND m."authorId" IS NULL
WHERE m.kind<>'ASSISTANT_PROGRESS';

CREATE OR REPLACE VIEW help_learning.jobs_v1 WITH (security_barrier=true) AS
SELECT j."ticketId" AS ticket_id,j.status,j."errorCode" AS error_code,j.provider,
  j."completedAt" AS completed_at,j."createdAt" AS created_at,j."updatedAt" AS updated_at
FROM public."HelpAssistantJob" j JOIN help_learning.tickets_v1 allowed ON allowed.ticket_id=j."ticketId";
REVOKE ALL ON help_learning.events_v1,help_learning.tickets_v1,help_learning.messages_v1,help_learning.jobs_v1 FROM PUBLIC,leader_help_learning_ro;
GRANT SELECT ON help_learning.events_v1,help_learning.tickets_v1,help_learning.messages_v1,help_learning.jobs_v1 TO leader_help_learning_ro;
COMMIT;
