-- Add index to speed up appeal messages cursor pagination
CREATE INDEX IF NOT EXISTS "AppealMessage_appealId_createdAt_id_idx"
ON "AppealMessage" ("appealId", "createdAt", "id");
