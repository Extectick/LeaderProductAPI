import { pool } from '../prisma/client';

// Fixed identifiers only; neither HTTP parameters nor environment variables can select tables.
export const ONEC_STAGE_TABLES = [
  'OnecStageStock', 'OnecStageNomenclature', 'OnecStageOrganization', 'OnecStageWarehouse',
  'OnecStageCounterparty', 'OnecStageContract', 'OnecStageAgreement',
  'OnecStageProductPrice', 'OnecStageSpecialPrice',
] as const;
const LOCK_NAME = 'onec-sync-retention-v1';
const usableSession = `s.status IN ('COMPLETED', 'PARTIAL') AND s.notes IS NULL
  AND NOT (s."replaceMode" AND s.status = 'PARTIAL')`;
const closedSession = `${usableSession} AND s."completedAt" < $1 AND s."lastActivityAt" < $1`;
const cleanRow = `t."resolveStatus" = 'RESOLVED' AND t."lastResolveError" IS NULL`;
const resolvedRow = `${cleanRow} AND t."resolvedAt" < $1 AND t."lastImportedAt" < $1`;
const successfulRun = `${closedSession} AND r.entity = 'STOCK' AND r.direction = 'IMPORT'
  AND r.status IN ('COMPLETED', 'PARTIAL') AND r."finishedAt" < $1 AND r.notes IS NULL`;
const successfulItem = `t.status = 'OK' AND t.error IS NULL AND t."createdAt" < $1`;

// A stock delta needn't cover every warehouse. Only two usable, newer sessions
// covering this exact organization/warehouse can retire an older session's rows.
// Inspect a bounded set of recent stock imports once per invocation. A scope
// absent from that window keeps its existing rows until it appears twice again.
const stockBoundariesQuery = `
  WITH latest AS MATERIALIZED (
    SELECT s.id, s."completedAt" FROM "OnecSyncSession" s
    WHERE ${usableSession} AND s."completedAt" <= $1 AND s."lastActivityAt" <= $1
      AND (s."selectedEntities" IS NULL OR s."selectedEntities" = '[]'::jsonb OR s."selectedEntities" ? 'stock')
    ORDER BY s."completedAt" DESC, s.id DESC LIMIT 128
  ), recent AS MATERIALIZED (
    SELECT s.id, s."completedAt" FROM latest s
    WHERE EXISTS (SELECT 1 FROM "OnecStageStock" t WHERE t."sessionId" = s.id AND ${cleanRow}
        AND t."organizationGuid" <> '' AND t."warehouseGuid" <> ''
        AND t."resolvedAt" <= $1 AND t."lastImportedAt" <= $1 LIMIT 1 OFFSET 0)
    ORDER BY s."completedAt" DESC, s.id DESC LIMIT 32
  ), coverage AS (
    SELECT DISTINCT r.id, r."completedAt", t."organizationGuid", t."warehouseGuid"
    FROM recent r JOIN "OnecStageStock" t ON t."sessionId" = r.id
    WHERE ${cleanRow} AND t."organizationGuid" <> '' AND t."warehouseGuid" <> ''
      AND t."resolvedAt" <= $1 AND t."lastImportedAt" <= $1
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY "organizationGuid", "warehouseGuid"
      ORDER BY "completedAt" DESC, id DESC) AS position FROM coverage
  )
  SELECT coalesce(json_agg(json_build_object('org', "organizationGuid", 'warehouse', "warehouseGuid",
    'boundary', "completedAt")), '[]'::json)::text AS scopes FROM ranked WHERE position = 2`;

const stockScopes = `scopes AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(org text, warehouse text, boundary timestamp)
)`;
const joinStockScope = `JOIN scopes w ON w.org = t."organizationGuid" AND w.warehouse = t."warehouseGuid"`;
const supersededStock = `${cleanRow} AND s."completedAt" < w.boundary AND s."lastActivityAt" < w.boundary
  AND t."resolvedAt" < w.boundary AND t."lastImportedAt" < w.boundary`;
// Page an exact preview over session summaries. One count across many millions
// of stock rows can exceed the statement timeout and hold a long MVCC snapshot.
const previewPageSize = 32;
const countCompactStock = `WITH ${stockScopes}, parents AS MATERIALIZED (
    SELECT s.id, s."completedAt", s."lastActivityAt" FROM "OnecSyncSession" s
    WHERE ${usableSession} AND s."completedAt" < (SELECT max(boundary) FROM scopes)
      AND ($2::text IS NULL OR s.id > $2) ORDER BY s.id LIMIT ${previewPageSize}
  )
  SELECT coalesce(sum(m.n),0)::int AS count, max(s.id) AS cursor, count(*) = ${previewPageSize} AS more
  FROM parents s CROSS JOIN LATERAL (
    SELECT count(*) AS n FROM "OnecStageStock" t ${joinStockScope}
    WHERE t."sessionId" = s.id AND ${supersededStock}
  ) m`;
// First order inexpensive session summaries; probe their indexed stage rows
// only until a bounded worklist is full. Reusing IDs across batches avoids
// rescanning thousands of historical sessions for every 1,000 deleted rows.
const compactParentsQuery = `WITH ${stockScopes}, ordered AS MATERIALIZED (
    SELECT s.id, s."completedAt", s."lastActivityAt" FROM "OnecSyncSession" s
    WHERE ${usableSession} AND s."completedAt" < (SELECT max(boundary) FROM scopes)
    ORDER BY s."completedAt" DESC, s.id DESC
  ) SELECT s.id FROM ordered s CROSS JOIN LATERAL (
    SELECT 1 FROM "OnecStageStock" t ${joinStockScope}
    WHERE t."sessionId" = s.id AND ${supersededStock} LIMIT 1
  ) matched LIMIT $2`;
const deleteCompactStock = `WITH ${stockScopes}, parent AS MATERIALIZED (
    SELECT s.id, s."completedAt", s."lastActivityAt" FROM "OnecSyncSession" s
    WHERE s.id = $3 AND ${usableSession} FOR UPDATE OF s SKIP LOCKED
  ), candidates AS MATERIALIZED (
    SELECT t.id FROM parent s JOIN "OnecStageStock" t ON t."sessionId" = s.id ${joinStockScope}
    WHERE ${supersededStock} LIMIT $2 FOR UPDATE OF t SKIP LOCKED
  ), deleted AS (DELETE FROM "OnecStageStock" t USING candidates c WHERE t.id = c.id RETURNING 1)
  SELECT count(*)::int AS count FROM deleted`;

export type OnecRetentionOptions = {
  dryRun?: boolean;
  now?: Date;
  compactStock?: boolean;
  stockOnly?: boolean;
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
  const compactStock = options.compactStock ?? process.env.ONEC_STOCK_COMPACT_ENABLED === 'true';
  const stockOnly = options.stockOnly ?? (compactStock && process.env.ONEC_SYNC_RETENTION_ENABLED !== 'true');
  const hours = bounded(options.retentionHours, 24, 24, 365 * 24);
  const batchSize = bounded(options.batchSize, 1000, 1, 2000);
  const maxRows = bounded(options.maxRows, 50_000, 1, 200_000);
  const budgetMs = bounded(options.budgetMs, 15_000, 1, 45_000);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - hours * 3600_000);
  const counts: Record<string, number> = {};
  const result = { dryRun, compactStock, stockOnly, cutoff: cutoff.toISOString(), counts, skipped: false, total: 0, bounded: false };
  const client = await pool.connect();
  let locked = false;
  let discardConnection = false;
  try {
    // Session advisory lock spans short batch transactions, never an entire backlog transaction.
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_NAME]);
    locked = lock.rows[0].locked;
    if (!locked) return { ...result, skipped: true };
    const deadline = Date.now() + budgetMs;
    let stockScopesJson: string | undefined;
    let stockParents: string[] | undefined;
    let moreStockParents = false;
    let previewCursor: string | null = null;
    let morePreview = false;
    let targets: string[] = stockOnly ? ['OnecStageStock'] : [...ONEC_STAGE_TABLES, 'SyncRunItem'];
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
          const compacting = table === 'OnecStageStock' && compactStock;
          // Scope the production stock transaction to its staging-only role.
          // SET LOCAL is undone by COMMIT/ROLLBACK before the next entity runs.
          if (compacting && process.env.NODE_ENV === 'production') {
            await client.query('SET LOCAL ROLE leader_stock_stage_maintenance');
          }
          // Prisma timestamp columns store UTC wall time. pg serializes JS Date
          // in the process timezone, whose offset PostgreSQL ignores for timestamp.
          let params: (string | number | null)[] = dryRun ? [cutoff.toISOString()] : [cutoff.toISOString(), limit];
          if (compacting) {
            if (stockScopesJson === undefined) {
              stockScopesJson = String((await client.query(stockBoundariesQuery, [now.toISOString()])).rows[0].scopes);
            }
            if (!dryRun && stockParents === undefined && stockScopesJson !== '[]') {
              const parentLimit = Math.min(maxRows, 512);
              const parents = await client.query<{ id: string }>(compactParentsQuery, [stockScopesJson, parentLimit + 1]);
              moreStockParents = parents.rows.length > parentLimit;
              stockParents = parents.rows.slice(0, parentLimit).map(row => row.id).reverse();
            }
            const nextParent = stockParents?.[stockParents.length - 1];
            if (stockScopesJson === '[]' || (!dryRun && nextParent === undefined)) {
              sql = 'SELECT 0 AS count';
              params = [];
            } else if (nextParent !== undefined) {
              sql = deleteCompactStock;
              params = [stockScopesJson, limit, nextParent];
            } else {
              sql = countCompactStock;
              params = [stockScopesJson, previewCursor];
            }
          } else if (table === 'SyncRunItem') {
            const from = `"SyncRunItem" t JOIN "SyncRun" r ON r.id = t."runId"
              JOIN "OnecSyncSession" s ON s.id = r.meta->>'sessionId'`;
            sql = dryRun ? `SELECT count(*)::int AS count FROM ${from} WHERE ${successfulRun} AND ${successfulItem}` : `
              WITH parent AS MATERIALIZED (
                SELECT r.id FROM "SyncRun" r JOIN "OnecSyncSession" s ON s.id = r.meta->>'sessionId'
                WHERE ${successfulRun} AND EXISTS (
                  SELECT 1 FROM "SyncRunItem" t WHERE t."runId" = r.id AND ${successfulItem} LIMIT 1 OFFSET 0)
                ORDER BY r."startedAt", r.id LIMIT 100 FOR UPDATE OF r, s SKIP LOCKED
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
          const query = await client.query(sql, params);
          await client.query('COMMIT');
          const count = query.rows[0].count as number;
          counts[table] = (counts[table] ?? 0) + count;
          result.total += count;
          passTotal += count;
          if (dryRun) {
            if (compacting) {
              morePreview = query.rows[0].more === true;
              previewCursor = query.rows[0].cursor ?? null;
            }
            if (!compacting || !morePreview) exhausted.add(table);
          } else if (compacting) {
            // Fewer than requested also covers rows or a session locked by an
            // importer: move on, re-discover anything skipped on the next run.
            if (count < limit) stockParents?.pop();
            if (!stockParents?.length) {
              exhausted.add(table);
              if (moreStockParents) result.bounded = true;
            }
          } else if (count === 0) exhausted.add(table);
        } catch (error) {
          await client.query('ROLLBACK');
          const failure = new Error(`Retention stopped at ${table}: ${error instanceof Error ? error.message : String(error)}`);
          Object.assign(failure, { progress: { ...result, failedTable: table } });
          throw failure;
        }
      }
      if (dryRun && !morePreview) return result;
      if (!dryRun && passTotal === 0 && !stockParents?.length) return result;
      // The cutoff is fixed for this run. Do not repeatedly scan already-empty
      // historical partitions while draining another table's large backlog.
      targets = targets.filter(table => !exhausted.has(table));
      // Yield between rounds for normal imports/HTTP traffic and WAL flushing.
      if (!dryRun) await new Promise(resolve => setTimeout(resolve, 50));
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
export function startOnecSyncMaintenance({ keepProcessAlive = false } = {}) {
  if (!stopped || (process.env.ONEC_SYNC_RETENTION_ENABLED !== 'true' && process.env.ONEC_STOCK_COMPACT_ENABLED !== 'true')) return;
  stopped = false;
  const run = async () => {
    try {
      const result = await runOnecSyncMaintenance({ dryRun: false });
      console.log('[onec-retention]', result);
    } catch (error) {
      console.warn('[onec-retention] failed; committed batches are safe to retry', error);
    } finally {
      if (!stopped) schedule(15 * 60_000);
    }
  };
  function schedule(delay: number) {
    timer = setTimeout(run, delay);
    if (!keepProcessAlive) timer.unref();
  }
  schedule(60_000);
}
export function stopOnecSyncMaintenance() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
