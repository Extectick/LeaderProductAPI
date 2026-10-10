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
- Stock promotes are serialized; during delta imports older source timestamps cannot overwrite newer balances. Product/warehouse/organization lookup is batched. Identical stock only updates freshness, without generating another offline change.
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

## Production result — 2026-10-10

- Runtime image/source: `d360c08a5abd15fd9f7bb9e2964333c1ae461eea`. [Release workflow](https://github.com/Extectick/LeaderProductAPI/actions/runs/38036493189) passed type checking, 11 real PostgreSQL tests and 55 regression tests.
- Backup: `C:\Share\GitRepositories\LeaderProductMobile\.artifacts\onec-retention-20261010\production-before-cleanup.dump`, 260,920,071 bytes. SHA-256 `7df161e406361a7b315259c45aa088d6bb31ca4fa0905c4a861cd3a5ef68af50`. Restricted local ACL; pg_restore read/decompressed the entire archive successfully (not a full restore rehearsal).
- Removed 2,289,869 historical rows: 1,116,648 resolved stock-stage rows, 1,120,306 successful stock journal items, 52,915 resolved reference-stage rows. Current-day history is retained.
- All original 5,544 pending/blocked stock rows and 23 journal errors retained byte-equivalent JSON fingerprints. The legacy stuck COMPLETING session with 1,500 pending stocks remains for diagnosis; no forced completion/replay.
- Stock balances remain 4,939 rows; orders remain 5,840. Live 1C imports resumed and legitimately updated quantities and offline projections (108,933 → 108,976 rows); cleanup never targets those tables. Fresh stock batches of 500 report success with zero per-item success journal rows. Two pre-existing missing-product dependencies still produce PARTIAL sessions.
- Repeated HTTP completion of an old purged session returned its original COMPLETED outcome with unchanged summary.
- Final dry-run found zero eligible rows. `ONEC_SYNC_RETENTION_ENABLED=true`; first scheduled pass at 08:07 UTC completed successfully, zero backlog. Ordinary serial VACUUM/ANALYZE completed on both large tables. Disk still has approximately 1.8 GiB free; reclaimed table space is reusable, not a promise of physical file shrinkage. Increase disk headroom or plan a separate controlled compaction window.
- During external health verification Nginx was found failed since 06:21 UTC, before deployment. Configuration validation passed; starting the existing service without configuration changes restored both production and dev HTTPS. Production API, DB, Redis and S3 health passed.
- APP/OTA, 1C configuration and dev API code/data were not updated. Existing dirty Compose overrides on the server were preserved. Deployment environment backups are under `/var/backups/leader-retention-20261010*`.
