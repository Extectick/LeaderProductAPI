# 1C staging retention and atomic completion

## Policy

- Successful stage rows: retain at least 24 hours after both session completion/activity and row import/resolution.
- Only final `COMPLETED` and `PARTIAL` sessions without notes are eligible. Legacy partial replace-mode sessions are excluded (old code could mark rolled-back rows resolved).
- Never delete `PENDING`, `BLOCKED`, `ERROR`, failed/active sessions, session summaries, current balances or offline datasets.
- Stock import journal: retain totals and all errors. New successful stock items are not duplicated in `SyncRunItem`. Old OK details are removed only when their linked source session is safely finalized and older than 24h. Other entities/order logs are untouched.
- Successful rows of a partial delta session are disposable; the failed rows and counters remain available for diagnosis.
- `OfflineDatasetRow` is a live snapshot, not history. Manager deltas retain the existing 30-day policy and revision/epoch safeguards. This cleanup does not modify either offline table.

## Correctness and performance

- Batch ingestion uses a transaction and a session row lock. A completing/finalized session cannot be reopened by a late batch.
- Completion acquires a durable `COMPLETING` fence. Duplicate completion returns the stored terminal outcome; a concurrent in-progress request fails for retry rather than starting a second promote.
- Live records, source offline revisions, stage resolution and final summary commit together. A rollback leaves payloads unresolved and records `FAILED`, never a false successful promote.
- A stuck `COMPLETING` session is deliberately preserved, not auto-replayed: inspect it and start a fresh 1C export when appropriate.
- Stock promotes are serialized; older source timestamps cannot overwrite newer balances. Product/warehouse/organization lookup is batched. Identical stock only updates freshness, without generating another offline change.
- Stock staging is a parameterized bulk upsert in chunks of 250, with duplicate keys normalized before SQL; timestamps and series are retained.
- Cleanup uses an advisory lock across instances and short batch transactions with row locks/SKIP LOCKED, a 250ms lock timeout, 5s statement timeout, <=2000 rows/batch and a bounded execution budget. No long transaction spans a backlog.
- Exhausted tables are skipped for the rest of the pass. On failure the CLI reports the table and already committed counts; repeating the command is safe.
- Parent eligibility probes deliberately remain correlated (`LIMIT 1 OFFSET 0`), using the existing session/status and run indexes; maintenance disables JIT locally. On the production backlog the flattened plan scanned 208k heap buffers per probe, versus approximately 6k buffers with indexed probes. No global planner settings are changed.
- Journal batches can lock up to 100 finalized parent runs together while still deleting no more than the row limit, avoiding repeated scans for historical one-item runs. Their summaries and errors remain intact.

## Operations

1. Take a fresh custom-format PostgreSQL backup to a separate disk; verify archive readability and checksum.
2. Deploy API with retention disabled. No Prisma/schema or 1C/APP changes required.
3. Preview inside the production API container: `node scripts/onec-sync-retention.js`.
4. Apply one bounded portion: `node scripts/onec-sync-retention.js --apply` (45s, <=200k rows). Repeat while monitoring free disk, WAL, API health and unresolved-row counts. Default command is read-only.
5. Set `ONEC_SYNC_RETENTION_ENABLED=true`, recreate only API. Worker starts after one minute, then every 15 minutes, <=50k rows/15s per pass.
6. Use ordinary `VACUUM (ANALYZE, TRUNCATE FALSE, PARALLEL 0)` as needed to make deleted space reusable; a 16MB maintenance work memory avoids Docker's default 64MB shared-memory limit. Refresh statistics/index cleanup between large backlog portions if the guarded statements time out. DELETE/VACUUM do not promise a smaller filesystem file. `VACUUM FULL`/table rewrites need a separately planned maintenance window and extra disk; never run automatically here.

Rollback: disable worker and return to the previous pinned image. Cleanup is not undone by a code rollback; deleted staging/journal rows are recoverable from the verified backup. Restore only required historical rows, not the whole live database over new business writes.

## Verification

Dedicated local/CI PostgreSQL database only, name `LeaderAPI_retention_*` on localhost; fixture test refuses other targets.

```
npx prisma db push
npx jest --config jest.onec-retention.config.ts --runInBand
npm run type-check
```

Coverage: terminal replay after purge, late batches, duplicate batches, unchanged/stale stock, partial dependencies, replace rollback, actual SQL failure, concurrent completion, dry-run, batch limits, protected statuses, locked sessions, worker mutual exclusion, and stock HTTP journal totals.
