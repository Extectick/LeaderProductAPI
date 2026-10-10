import { pool } from '../prisma/client';

// Fixed identifiers only; neither HTTP parameters nor environment variables can select tables.
export const ONEC_STAGE_TABLES = [
  'OnecStageStock', 'OnecStageNomenclature', 'OnecStageOrganization', 'OnecStageWarehouse',
  'OnecStageCounterparty', 'OnecStageContract', 'OnecStageAgreement',
  'OnecStageProductPrice', 'OnecStageSpecialPrice',
] as const;
const LOCK_NAME = 'onec-sync-retention-v1';
const closedSession = `s.status IN ('COMPLETED', 'PARTIAL') AND s.notes IS NULL
  AND NOT (s."replaceMode" AND s.status = 'PARTIAL')
  AND s."completedAt" < $1 AND s."lastActivityAt" < $1`;
const resolvedRow = `t."resolveStatus" = 'RESOLVED' AND t."lastResolveError" IS NULL
  AND t."resolvedAt" < $1 AND t."lastImportedAt" < $1`;
const successfulRun = `${closedSession} AND r.entity = 'STOCK' AND r.direction = 'IMPORT'
  AND r.status IN ('COMPLETED', 'PARTIAL') AND r."finishedAt" < $1 AND r.notes IS NULL`;
const successfulItem = `t.status = 'OK' AND t.error IS NULL AND t."createdAt" < $1`;

export type OnecRetentionOptions = {
  dryRun?: boolean;
  now?: Date;
  retentionHours?: number;
  batchSize?: number;
  maxRows?: number;
  budgetMs?: number;
};
function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

/** Defaults to read-only. Sessions/summaries, errors, live balances and offline datasets are never deleted. */
export async function runOnecSyncMaintenance(options: OnecRetentionOptions = {}) {
  const dryRun = options.dryRun !== false;
  const hours = bounded(options.retentionHours, 24, 24, 365 * 24);
  const batchSize = bounded(options.batchSize, 1000, 1, 2000);
  const maxRows = bounded(options.maxRows, 50_000, 1, 200_000);
  const budgetMs = bounded(options.budgetMs, 15_000, 1, 45_000);
  const cutoff = new Date((options.now ?? new Date()).getTime() - hours * 3600_000);
  const counts: Record<string, number> = {};
  const result = { dryRun, cutoff: cutoff.toISOString(), counts, skipped: false, total: 0, bounded: false };
  const client = await pool.connect();
  let locked = false;
  let discardConnection = false;
  try {
    // Session advisory lock spans short batch transactions, never an entire backlog transaction.
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_NAME]);
    locked = lock.rows[0].locked;
    if (!locked) return { ...result, skipped: true };
    const deadline = Date.now() + budgetMs;
    let targets: string[] = [...ONEC_STAGE_TABLES, 'SyncRunItem'];
    for (;;) {
      let passTotal = 0;
      const exhausted = new Set<string>();
      for (const table of targets) {
        if (!dryRun && (Date.now() >= deadline || result.total >= maxRows)) {
          result.bounded = true;
          return result;
        }
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL lock_timeout = '250ms'");
          // Small indexed batches must not pay a JIT compilation cost each time.
          await client.query('SET LOCAL jit = off');
          await client.query(`SET LOCAL statement_timeout = '${dryRun ? 30000 : 5000}ms'`);
          const limit = Math.min(batchSize, maxRows - result.total);
          let sql: string;
          if (table === 'SyncRunItem') {
            const from = `"SyncRunItem" t JOIN "SyncRun" r ON r.id = t."runId"
              JOIN "OnecSyncSession" s ON s.id = r.meta->>'sessionId'`;
            sql = dryRun ? `SELECT count(*)::int AS count FROM ${from} WHERE ${successfulRun} AND ${successfulItem}` : `
              WITH parent AS MATERIALIZED (
                SELECT r.id FROM "SyncRun" r JOIN "OnecSyncSession" s ON s.id = r.meta->>'sessionId'
                WHERE ${successfulRun} AND EXISTS (
                  SELECT 1 FROM "SyncRunItem" t WHERE t."runId" = r.id AND ${successfulItem} LIMIT 1 OFFSET 0)
                ORDER BY r."startedAt", r.id LIMIT 1 FOR UPDATE OF r, s SKIP LOCKED
              ), candidates AS MATERIALIZED (
                SELECT t.id FROM "SyncRunItem" t JOIN parent p ON p.id = t."runId"
                WHERE ${successfulItem} LIMIT $2 FOR UPDATE OF t SKIP LOCKED
              ), deleted AS (
                DELETE FROM "SyncRunItem" t USING candidates c WHERE t.id = c.id RETURNING 1
              ) SELECT count(*)::int AS count FROM deleted`;
          } else {
            sql = dryRun ? `SELECT count(*)::int AS count FROM "${table}" t
              JOIN "OnecSyncSession" s ON s.id = t."sessionId" WHERE ${closedSession} AND ${resolvedRow}` : `
              WITH parent AS MATERIALIZED (
                SELECT s.id FROM "OnecSyncSession" s WHERE ${closedSession} AND EXISTS (
                  SELECT 1 FROM "${table}" t WHERE t."sessionId" = s.id AND ${resolvedRow} LIMIT 1 OFFSET 0)
                ORDER BY s."completedAt", s.id LIMIT 1 FOR UPDATE SKIP LOCKED
              ), candidates AS MATERIALIZED (
                SELECT t.id FROM "${table}" t JOIN parent p ON p.id = t."sessionId"
                WHERE ${resolvedRow} LIMIT $2 FOR UPDATE OF t SKIP LOCKED
              ), deleted AS (
                DELETE FROM "${table}" t USING candidates c WHERE t.id = c.id RETURNING 1
              ) SELECT count(*)::int AS count FROM deleted`;
          }
          const query = await client.query(sql, dryRun ? [cutoff] : [cutoff, limit]);
          await client.query('COMMIT');
          const count = query.rows[0].count as number;
          counts[table] = (counts[table] ?? 0) + count;
          result.total += count;
          passTotal += count;
          if (count === 0) exhausted.add(table);
        } catch (error) {
          await client.query('ROLLBACK');
          const failure = new Error(`Retention stopped at ${table}: ${error instanceof Error ? error.message : String(error)}`);
          Object.assign(failure, { progress: { ...result, failedTable: table } });
          throw failure;
        }
      }
      if (dryRun || passTotal === 0) return result;
      // The cutoff is fixed for this run. Do not repeatedly scan already-empty
      // historical partitions while draining another table's large backlog.
      targets = targets.filter(table => !exhausted.has(table));
      // Yield between rounds for normal imports/HTTP traffic and WAL flushing.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]); }
      catch { discardConnection = true; }
    }
    client.release(discardConnection);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = true;
export function startOnecSyncMaintenance() {
  if (process.env.ONEC_SYNC_RETENTION_ENABLED !== 'true' || !stopped) return;
  stopped = false;
  const run = async () => {
    try {
      const result = await runOnecSyncMaintenance({ dryRun: false });
      console.log('[onec-retention]', result);
    } catch (error) {
      console.warn('[onec-retention] failed; committed batches are safe to retry', error);
    } finally {
      if (!stopped) { timer = setTimeout(run, 15 * 60_000); timer.unref(); }
    }
  };
  timer = setTimeout(run, 60_000);
  timer.unref();
}
export function stopOnecSyncMaintenance() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
