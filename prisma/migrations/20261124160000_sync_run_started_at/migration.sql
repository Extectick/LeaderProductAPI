-- The default unfiltered admin list orders by startedAt DESC LIMIT 50.
-- Run in autocommit: PostgreSQL builds this B-tree alongside normal writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SyncRun_startedAt_idx" ON public."SyncRun" ("startedAt");
