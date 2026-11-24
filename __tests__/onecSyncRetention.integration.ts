import { randomUUID } from 'node:crypto';
import prisma, { pool } from '../src/prisma/client';
import { completeOnecSyncSession, stageStockBatch, startOnecSyncSession } from '../src/modules/onec/onec.sync';
import { handleStockBatch } from '../src/modules/onec/onec.controllers';
import { runOnecSyncMaintenance } from '../src/services/onecSyncMaintenanceService';

jest.mock('../src/utils/cache', () => ({ cacheDelPrefix: jest.fn().mockResolvedValue(undefined) }));
const old = new Date('2026-10-01T00:00:00Z');
const clock = new Date('2026-10-10T12:00:00Z');
const stamp = new Date('2026-10-10T10:00:00Z');
const stock = { productGuid: 'p', warehouseGuid: 'w', organizationGuid: 'o', quantity: 9, reserved: 2, updatedAt: stamp };
const complete = (sessionId: string) => completeOnecSyncSession({ secret: 'test', sessionId });
const start = (replaceMode = false) => startOnecSyncSession({ secret: 'test', replaceMode, selectedEntities: ['stock'] });

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/LeaderAPI_retention_')) {
    throw new Error('These destructive fixtures require a dedicated local LeaderAPI_retention_* database');
  }
});
beforeEach(async () => {
  await pool.query(`TRUNCATE "SyncRunItem", "SyncRun", "OnecSyncSession", "StockBalance",
    "Product", "Warehouse", "Organization", "OfflineDatasetChange", "OfflineDatasetState", "OfflineDatasetRow" CASCADE`);
  await prisma.product.create({ data: { guid: 'p', name: 'Product' } });
  await prisma.warehouse.create({ data: { guid: 'w', name: 'Warehouse' } });
  await prisma.organization.create({ data: { guid: 'o', name: 'Organization' } });
});
afterAll(async () => { await prisma.$disconnect(); await pool.end(); });

async function importStock(items = [stock]) {
  const session = await start();
  await stageStockBatch(session.id, items);
  return complete(session.id);
}
async function ageSession(id: string) {
  await prisma.onecSyncSession.update({ where: { id }, data: { completedAt: old, lastActivityAt: old } });
  await prisma.onecStageStock.updateMany({ where: { sessionId: id, resolveStatus: 'RESOLVED' },
    data: { lastImportedAt: old, resolvedAt: old } });
}
async function fixture(status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'COMPLETING' | 'ACCEPTING',
  resolveStatus: 'RESOLVED' | 'BLOCKED' | 'ERROR' | 'PENDING' = 'RESOLVED', extra: object = {}) {
  const session = await prisma.onecSyncSession.create({ data: {
    requestId: randomUUID(), status, acceptedCount: 1, resolvedCount: 1,
    completedAt: old, lastActivityAt: old, ...extra,
  } });
  const row = await prisma.onecStageStock.create({ data: {
    sessionId: session.id, sourceKey: 'fixture', productGuid: 'p', warehouseGuid: 'w', organizationGuid: 'o',
    payload: {}, payloadHash: 'hash', resolveStatus, resolvedAt: old, lastImportedAt: old,
  } });
  return { session, row };
}

test('completion commits data, statuses and revisions together, and is idempotent after cleanup', async () => {
  const result = await importStock();
  expect(result).toMatchObject({ status: 'COMPLETED', acceptedCount: 1, resolvedCount: 1 });
  expect((await prisma.stockBalance.findFirstOrThrow()).available!.toNumber()).toBe(7);
  const revision = (await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision;
  await ageSession(result.sessionId);
  expect((await runOnecSyncMaintenance({ dryRun: false, now: clock })).counts.OnecStageStock).toBe(1);
  expect(await complete(result.sessionId)).toEqual(result);
  expect((await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision).toBe(revision);
  await expect(stageStockBatch(result.sessionId, [{ ...stock, quantity: 100 }])).rejects.toThrow('start a new session');
  expect((await prisma.stockBalance.findFirstOrThrow()).quantity.toNumber()).toBe(9);
});

test('duplicate batches count distinct staging rows; unchanged/stale snapshots emit no offline delta', async () => {
  const session = await start();
  await stageStockBatch(session.id, [stock]);
  await stageStockBatch(session.id, [stock]);
  expect((await complete(session.id)).acceptedCount).toBe(1);
  const revision = (await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision;
  await importStock([{ ...stock, updatedAt: new Date(stamp.getTime() + 2000) }]);
  await importStock([{ ...stock, quantity: 99, updatedAt: new Date(stamp.getTime() + 1000) }]);
  expect((await prisma.stockBalance.findFirstOrThrow()).quantity.toNumber()).toBe(9);
  expect((await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision).toBe(revision);
  await importStock([{ ...stock, quantity: 10, updatedAt: new Date(stamp.getTime() + 3000) }]);
  expect((await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision).toBeGreaterThan(revision);
});

test('partial session keeps missing references and only projects committed balances', async () => {
  const result = await importStock([stock, { ...stock, productGuid: 'missing' }]);
  expect(result).toMatchObject({ status: 'PARTIAL', resolvedCount: 1, blockedCount: 1 });
  expect(await prisma.offlineDatasetChange.count()).toBe(1);
  await ageSession(result.sessionId);
  await runOnecSyncMaintenance({ dryRun: false, now: clock });
  expect(await prisma.onecStageStock.count({ where: { sessionId: result.sessionId } })).toBe(1);
  expect((await prisma.onecStageStock.findFirstOrThrow()).resolveStatus).toBe('BLOCKED');
  expect(await complete(result.sessionId)).toEqual(result);
});

test('stock batches cross chunk boundaries, deduplicate keys and retain series/date fields', async () => {
  const session = await start();
  const series = Array.from({ length: 501 }, (_, n) => ({
    ...stock, seriesGuid: 'series-' + n, seriesNumber: String(n), seriesProductionDate: old,
  }));
  await stageStockBatch(session.id, [...series, { ...series[0], quantity: 11 }]);
  expect(await prisma.onecStageStock.count()).toBe(501);
  expect((await complete(session.id)).resolvedCount).toBe(501);
  expect((await prisma.stockBalance.findFirstOrThrow({ where: { seriesGuid: 'series-0' } })).quantity.toNumber()).toBe(11);
  expect((await prisma.stockBalance.findFirstOrThrow({ where: { seriesGuid: 'series-500' } })).seriesProductionDate).toEqual(old);
});

test('replace failure rolls back clears, data, revisions and RESOLVED markers', async () => {
  await importStock();
  const revision = (await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision;
  const session = await start(true);
  await stageStockBatch(session.id, [{ ...stock, quantity: 50 }, { ...stock, productGuid: 'missing' }]);
  expect(await complete(session.id)).toMatchObject({ status: 'FAILED', resolvedCount: 0 });
  expect((await prisma.stockBalance.findFirstOrThrow()).quantity.toNumber()).toBe(9);
  expect((await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision).toBe(revision);
  expect(await prisma.onecStageStock.count({ where: { sessionId: session.id, resolveStatus: 'PENDING' } })).toBe(2);
});

test('database failure cannot produce a successful session or resolved rows', async () => {
  await pool.query('ALTER TABLE "StockBalance" ADD CONSTRAINT retention_test_positive CHECK (quantity >= 0)');
  try {
    const result = await importStock([{ ...stock, quantity: -1 }]);
    expect(result).toMatchObject({ status: 'FAILED', resolvedCount: 0 });
    expect(await prisma.stockBalance.count()).toBe(0);
    expect(await prisma.offlineDatasetChange.count()).toBe(0);
    expect((await prisma.onecStageStock.findFirstOrThrow()).resolveStatus).toBe('PENDING');
  } finally { await pool.query('ALTER TABLE "StockBalance" DROP CONSTRAINT retention_test_positive'); }
});

test('concurrent completion applies at most once; durable in-progress sessions cannot be replayed', async () => {
  const session = await start();
  await stageStockBatch(session.id, [stock]);
  const results = await Promise.allSettled([complete(session.id), complete(session.id)]);
  expect(results.some(result => result.status === 'fulfilled' && result.value.status === 'COMPLETED')).toBe(true);
  expect(await prisma.offlineDatasetChange.count()).toBe(1);
  const stuck = await fixture('COMPLETING', 'PENDING');
  await expect(complete(stuck.session.id)).rejects.toThrow('already completing');
});

test('retention dry-run and batches protect active, recent, error and ambiguous legacy sessions', async () => {
  const disposable = await fixture('COMPLETED');
  await fixture('PARTIAL');
  const protectedRows = await Promise.all([
    fixture('COMPLETING'), fixture('ACCEPTING'), fixture('FAILED'), fixture('PARTIAL', 'BLOCKED'),
    fixture('PARTIAL', 'ERROR'), fixture('PARTIAL', 'PENDING'), fixture('COMPLETED', 'RESOLVED', { notes: 'legacy rollback' }),
    fixture('PARTIAL', 'RESOLVED', { replaceMode: true }), fixture('COMPLETED', 'RESOLVED', { completedAt: clock }),
  ]);
  const run = await prisma.syncRun.create({ data: { requestId: randomUUID(), entity: 'STOCK', direction: 'IMPORT',
    status: 'COMPLETED', finishedAt: old, meta: { sessionId: disposable.session.id }, successCount: 1,
    items: { create: [{ key: 'ok', status: 'OK', createdAt: old }, { key: 'error', status: 'ERROR', error: 'preserve', createdAt: old }] },
  } });
  const orderRun = await prisma.syncRun.create({ data: { requestId: randomUUID(), entity: 'ORDERS_SNAPSHOT', direction: 'IMPORT',
    status: 'COMPLETED', finishedAt: old, items: { create: { key: 'order', status: 'OK', createdAt: old } },
  } });
  const before = await prisma.onecStageStock.count();
  const preview = await runOnecSyncMaintenance({ now: clock });
  expect(preview.counts.OnecStageStock).toBe(2);
  expect(preview.counts.SyncRunItem).toBe(1);
  expect(await prisma.onecStageStock.count()).toBe(before);
  const limited = await runOnecSyncMaintenance({ dryRun: false, now: clock, batchSize: 1, maxRows: 1 });
  expect(limited.total).toBe(1);
  await runOnecSyncMaintenance({ dryRun: false, now: clock });
  expect(await prisma.onecStageStock.count()).toBe(protectedRows.length);
  expect(await prisma.syncRunItem.count({ where: { runId: run.id } })).toBe(1);
  expect(await prisma.syncRunItem.count({ where: { runId: orderRun.id } })).toBe(1);
  expect((await prisma.syncRun.findUniqueOrThrow({ where: { id: run.id } })).successCount).toBe(1);
  expect(await prisma.onecSyncSession.count()).toBe(before);
});

test('retention skips a locked session and excludes concurrent workers', async () => {
  const target = await fixture('COMPLETED');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT id FROM "OnecSyncSession" WHERE id=$1 FOR UPDATE', [target.session.id]);
    expect((await runOnecSyncMaintenance({ dryRun: false, now: clock })).total).toBe(0);
    await connection.query('ROLLBACK');
    await connection.query("SELECT pg_advisory_lock(hashtext('onec-sync-retention-v1'))");
    expect((await runOnecSyncMaintenance({ dryRun: false, now: clock })).skipped).toBe(true);
    await connection.query("SELECT pg_advisory_unlock(hashtext('onec-sync-retention-v1'))");
  } finally { connection.release(); }
  expect((await runOnecSyncMaintenance({ dryRun: false, now: clock })).total).toBe(1);
});

test('journal cleanup batches many small runs while preserving their summaries and errors', async () => {
  const target = await fixture('COMPLETED');
  const runs = Array.from({ length: 120 }, () => ({ id: randomUUID(), requestId: randomUUID(),
    entity: 'STOCK' as const, direction: 'IMPORT' as const, status: 'COMPLETED' as const,
    finishedAt: old, meta: { sessionId: target.session.id }, totalCount: 2, successCount: 1, errorCount: 1 }));
  await prisma.syncRun.createMany({ data: runs });
  await prisma.syncRunItem.createMany({ data: runs.flatMap(run => [
    { runId: run.id, key: 'ok', status: 'OK' as const, createdAt: old },
    { runId: run.id, key: 'error', status: 'ERROR' as const, error: 'preserve', createdAt: old },
  ]) });
  const result = await runOnecSyncMaintenance({ dryRun: false, now: clock, batchSize: 25, budgetMs: 45_000 });
  expect(result.counts.SyncRunItem).toBe(120);
  expect(await prisma.syncRun.count()).toBe(120);
  expect(await prisma.syncRunItem.count()).toBe(120);
  expect(await prisma.syncRunItem.count({ where: { status: 'OK' } })).toBe(0);
});

async function dateStockSession(sessionId: string, at: Date) {
  await prisma.onecSyncSession.update({ where: { id: sessionId }, data: {
    startedAt: at, completedAt: at, lastActivityAt: at,
  } });
  await prisma.onecStageStock.updateMany({ where: { sessionId }, data: { lastImportedAt: at } });
  await prisma.onecStageStock.updateMany({ where: { sessionId, resolveStatus: 'RESOLVED' }, data: { resolvedAt: at } });
}

test('compact stock keeps the latest two applied imports per organization and warehouse, including partial imports', async () => {
  await prisma.organization.create({ data: { guid: 'o2', name: 'Second organization' } });
  await prisma.warehouse.create({ data: { guid: 'w2', name: 'Second warehouse' } });
  const first = await importStock([stock, { ...stock, warehouseGuid: 'w2' }, { ...stock, organizationGuid: 'o2' },
    { ...stock, productGuid: 'missing' }]);
  const second = await importStock([stock, { ...stock, warehouseGuid: 'w2' }]);
  const third = await importStock([stock, { ...stock, productGuid: 'missing' }]);
  expect(third.status).toBe('PARTIAL');
  const fourth = await importStock([{ ...stock, quantity: 13, updatedAt: new Date(stamp.getTime() + 1000) }]);
  const sessions = [first, second, third, fourth].map(result => result.sessionId);
  for (const [index, id] of sessions.entries()) {
    await dateStockSession(id, new Date(stamp.getTime() + index * 60_000));
  }
  const balances = await prisma.stockBalance.findMany({ orderBy: { syncKey: 'asc' } });
  const revision = (await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision;
  const options = { compactStock: true, now: clock };
  const preview = await runOnecSyncMaintenance(options);
  expect(preview.counts.OnecStageStock).toBe(2);
  expect(await prisma.onecStageStock.count()).toBe(9);

  const one = await runOnecSyncMaintenance({ ...options, dryRun: false, batchSize: 1, maxRows: 1 });
  expect(one.counts.OnecStageStock).toBe(1);
  const rest = await runOnecSyncMaintenance({ ...options, dryRun: false });
  expect(rest.counts.OnecStageStock).toBe(1);
  expect((await runOnecSyncMaintenance(options)).counts.OnecStageStock).toBe(0);

  const primaryRows = await prisma.onecStageStock.findMany({
    where: { productGuid: 'p', organizationGuid: 'o', warehouseGuid: 'w' }, select: { sessionId: true },
  });
  expect(primaryRows.map(row => row.sessionId).sort()).toEqual([third.sessionId, fourth.sessionId].sort());
  expect(await prisma.onecStageStock.count({ where: { warehouseGuid: 'w2' } })).toBe(2);
  expect(await prisma.onecStageStock.count({ where: { organizationGuid: 'o2' } })).toBe(1);
  expect(await prisma.onecStageStock.count({ where: { resolveStatus: 'BLOCKED' } })).toBe(2);
  expect(await prisma.stockBalance.findMany({ orderBy: { syncKey: 'asc' } })).toEqual(balances);
  expect((await prisma.offlineDatasetState.findFirstOrThrow()).currentRevision).toBe(revision);
  expect(await complete(first.sessionId)).toEqual(first);
});

test('invalid, unfinished and empty imports cannot displace older diagnostic copies', async () => {
  const baseline = await fixture('COMPLETED');
  const previous = await fixture('PARTIAL');
  await dateStockSession(baseline.session.id, old);
  await dateStockSession(previous.session.id, stamp);
  const protectedRows = await Promise.all([
    fixture('COMPLETING'), fixture('ACCEPTING'), fixture('FAILED'),
    fixture('PARTIAL', 'RESOLVED', { replaceMode: true }),
    fixture('COMPLETED', 'RESOLVED', { notes: 'ambiguous' }),
    fixture('PARTIAL', 'ERROR'), fixture('PARTIAL', 'PENDING'), fixture('PARTIAL', 'BLOCKED'),
  ]);
  for (const { session } of protectedRows) {
    await dateStockSession(session.id, new Date(stamp.getTime() + 60_000));
  }
  const invalidResolved = await fixture('COMPLETED');
  await dateStockSession(invalidResolved.session.id, new Date(stamp.getTime() + 60_000));
  await prisma.onecStageStock.update({ where: { id: invalidResolved.row.id }, data: { lastResolveError: 'legacy error' } });
  const unknownScope = await fixture('COMPLETED');
  await prisma.onecStageStock.update({ where: { id: unknownScope.row.id }, data: { organizationGuid: null } });
  const future = await fixture('COMPLETED');
  await dateStockSession(future.session.id, new Date(clock.getTime() + 60_000));
  await prisma.onecSyncSession.create({ data: {
    requestId: randomUUID(), selectedEntities: ['stock'], status: 'COMPLETED', completedAt: clock, lastActivityAt: clock,
  } });
  const options = { compactStock: true, now: clock, dryRun: false };
  expect((await runOnecSyncMaintenance(options)).counts.OnecStageStock).toBe(0);
  const next = await fixture('COMPLETED');
  await dateStockSession(next.session.id, new Date(stamp.getTime() + 120_000));
  expect((await runOnecSyncMaintenance(options)).counts.OnecStageStock).toBe(1);
  expect(await prisma.onecStageStock.count({ where: { sessionId: baseline.session.id } })).toBe(0);
  expect(await prisma.onecStageStock.count({ where: { sessionId: { in: protectedRows.map(r => r.session.id) } } }))
    .toBe(protectedRows.length);
  const guardedIds = [invalidResolved.row.id, unknownScope.row.id, future.row.id];
  expect(await prisma.onecStageStock.count({ where: { id: { in: guardedIds } } })).toBe(guardedIds.length);
});

test('a tie at the second newest completion does not discard an ambiguous diagnostic copy', async () => {
  const ids: string[] = [];
  for (const time of [old, stamp, stamp, new Date(stamp.getTime() + 60_000)]) {
    const { session } = await fixture('COMPLETED');
    await dateStockSession(session.id, time);
    ids.push(session.id);
  }
  const result = await runOnecSyncMaintenance({ dryRun: false, compactStock: true, now: clock });
  expect(result.counts.OnecStageStock).toBe(1);
  const remaining = await prisma.onecStageStock.findMany({ select: { sessionId: true } });
  expect(remaining.map(row => row.sessionId).sort()).toEqual(ids.slice(1).sort());
});

test('compact cleanup skips a locked session and resumes it without touching either recent copy', async () => {
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const { session } = await fixture('COMPLETED');
    await dateStockSession(session.id, new Date(stamp.getTime() + index * 60_000));
    ids.push(session.id);
  }
  const options = { compactStock: true, dryRun: false, now: clock };
  const locker = await pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM "OnecSyncSession" WHERE id=$1 FOR UPDATE', [ids[0]]);
    expect((await runOnecSyncMaintenance(options)).counts.OnecStageStock).toBe(1);
    expect(await prisma.onecStageStock.count({ where: { sessionId: ids[0] } })).toBe(1);
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
  }
  expect((await runOnecSyncMaintenance(options)).counts.OnecStageStock).toBe(1);
  const remaining = await prisma.onecStageStock.findMany({ select: { sessionId: true } });
  expect(remaining.map(row => row.sessionId).sort()).toEqual(ids.slice(2).sort());
});

test('stock-only mode leaves other staging rows untouched and regular maintenance applies their original age cutoff', async () => {
  const older = await fixture('COMPLETED');
  const recent = await fixture('COMPLETED');
  await dateStockSession(older.session.id, old);
  await dateStockSession(recent.session.id, stamp);
  for (const [sessionId, date] of [[older.session.id, old], [recent.session.id, stamp]] as const) {
    await prisma.onecStageWarehouse.create({ data: {
      sessionId, guid: 'w', sourceKey: 'w', payload: {}, payloadHash: 'hash',
      resolveStatus: 'RESOLVED', resolvedAt: date, lastImportedAt: date,
    } });
  }
  const options = { compactStock: true, dryRun: false, now: clock };
  expect((await runOnecSyncMaintenance({ ...options, stockOnly: true })).total).toBe(0);
  expect(await prisma.onecStageWarehouse.count()).toBe(2);
  expect((await runOnecSyncMaintenance({ ...options, stockOnly: false })).counts.OnecStageWarehouse).toBe(1);
  expect((await prisma.onecStageWarehouse.findFirstOrThrow()).sessionId).toBe(recent.session.id);
});

test('successful stock HTTP batch journals totals rather than one item per balance', async () => {
  const response: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await handleStockBatch({ body: { secret: 'test', items: [stock] } } as any, response);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  expect(await prisma.syncRunItem.count()).toBe(0);
  expect(await prisma.syncRun.findFirstOrThrow()).toMatchObject({ totalCount: 1, successCount: 1, errorCount: 0, status: 'COMPLETED' });
});
