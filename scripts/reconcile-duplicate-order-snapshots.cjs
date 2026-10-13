// Run via stdin inside the production leader_api container. Default is read-only.
// RECONCILE_APPLY=1 applies each freshly verified order through the normal API
// snapshot endpoint; it never writes to 1C or resets synchronization flags.
require('/app/dist/env');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { default: db, pool } = require('/app/dist/prisma/client');
const onec = require('/app/dist/modules/onec/onec.lpApp.client');
const { ordersSnapshotBatchSchema } = require('/app/dist/modules/onec/onec.schemas');
const { canRetryDuplicateLineSnapshot } = require('/app/dist/modules/onec/onec.orderSnapshotRecovery');
const apply = process.env.RECONCILE_APPLY === '1';
const auditDir = process.env.RECONCILE_AUDIT_DIR;
const select = {
  id: true, guid: true, number1c: true, revision: true, clientRevision: true,
  clientOrderId: true, source: true, status: true, syncState: true, last1cError: true,
  lastExportError: true, cancelRequestedAt: true, last1cSnapshot: true, totalAmount: true,
  updatedAt: true, isPostedIn1c: true, exportAttempts: true,
  counterparty: { select: { guid: true } }, organization: { select: { guid: true } },
  items: { include: { product: { select: { guid: true } }, package: { select: { guid: true } } } },
};
function save(name, value) {
  fs.writeFileSync(`${auditDir}/${name}.json`, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
}
function normalizedLines(lines) {
  return lines.map(x => ({
    id: x.lineGuid, product: x.product.guid, quantityBase: Number(x.quantityBase ?? x.quantity),
    price: Number(x.price ?? x.basePrice ?? 0), cancelled: Boolean(x.isCancelled),
    amount: Number(x.lineAmount ?? Number(x.quantityBase ?? x.quantity) * Number(x.price ?? 0)),
  })).sort((a, b) => a.id.localeCompare(b.id));
}
function signature(detail) {
  return createHash('sha256').update(JSON.stringify({
    documentGuid: detail.documentGuid, appGuid: detail.appGuid, imported: detail.lastImportedRevision,
    number: detail.number1c, posted: detail.isPostedIn1c, deleted: detail.deletionMark,
    total: Number(detail.totalAmount), lines: normalizedLines(detail.items),
  })).digest('hex');
}
async function read(order) {
  const response = await onec.getOnecLpAppClientOrder(order.guid, { appGuid: order.guid, importReceipt: true });
  return response.item || response;
}
async function prepare(order) {
  const detail = await read(order);
  assert.equal(detail.appGuid, order.guid, 'App identity mismatch');
  assert.equal(detail.number1c, order.number1c, 'Document number mismatch');
  assert.match(detail.documentGuid || '', /^[0-9a-f-]{36}$/i);
  assert.equal(detail.deletionMark, false, 'Document deleted');
  assert.equal(detail.isPostedIn1c, true, 'Document not posted');
  assert.equal(detail.counterparty?.guid, order.counterparty.guid, 'Counterparty mismatch');
  assert.equal(detail.organization?.guid, order.organization?.guid, 'Organization mismatch');
  assert.equal(detail.lastImportedRevision + 1, order.revision, 'Import revision mismatch');
  const body = ordersSnapshotBatchSchema.parse({ secret: process.env.ONEC_SECRET, items: [{
    ...detail, guid: order.guid, baseRevision: detail.lastImportedRevision,
    revision: detail.lastImportedRevision + 1, status: 'CONFIRMED', syncState: 'SYNCED',
    sourceUpdatedAt: detail.sourceUpdatedAt || detail.updatedAt,
  }] });
  const snapshot = body.items[0];
  assert.equal(canRetryDuplicateLineSnapshot(order, snapshot), true, 'Not a retryable failed snapshot');
  assert.equal(new Set(snapshot.items.map(x => x.lineGuid?.toLowerCase())).size, snapshot.items.length, 'Duplicate live line identities');
  assert.ok(snapshot.items.every(x => x.lineGuid), 'Missing live line identity');
  const productGuids = [...new Set(snapshot.items.map(x => x.product.guid))];
  const products = await db.product.findMany({ where: { guid: { in: productGuids } }, select: { guid: true } });
  assert.equal(products.length, productGuids.length, 'Missing product references');
  for (const line of snapshot.items) {
    if (line.package?.guid) assert.ok(await db.productPackage.findFirst({
      where: { guid: line.package.guid, product: { guid: line.product.guid } }, select: { id: true },
    }), 'Missing package reference');
    if (line.unit?.guid) assert.ok(await db.unit.findUnique({ where: { guid: line.unit.guid }, select: { id: true } }), 'Missing unit reference');
  }
  return { detail, snapshot, hash: signature(detail) };
}
async function main() {
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(new URL(process.env.DATABASE_URL).pathname, '/LeaderAPI');
  assert.equal(new URL(process.env.ONEC_LP_APP_BASE_URL).pathname.replace(/\/$/, ''), '/torg2026/hs/lp-app');
  assert.match(auditDir || '', /^\/tmp\/leader-snapshot-recovery-[a-z0-9-]+$/);
  fs.mkdirSync(auditDir, { mode: 0o700 });
  const ping = await onec.pingOnecLpApp();
  assert.equal(ping.clientOrdersApiVersion, '2026-10-13-posting-recovery-split-rows-v57');
  const candidates = await db.order.findMany({ where: {
    source: 'MANAGER_APP', syncState: 'ERROR', last1cError: { startsWith: 'Duplicate lineGuid ' },
  }, orderBy: { createdAt: 'desc' }, select, take: 200 });
  assert.ok(candidates.length < 200, 'Candidate limit reached; inspect before proceeding');
  save('before', candidates);
  const results = [];
  for (const baseline of candidates) {
    const result = { number: baseline.number1c, guid: baseline.guid };
    try {
      const order = await db.order.findUnique({ where: { id: baseline.id }, select });
      assert.ok(order && order.updatedAt.getTime() === baseline.updatedAt.getTime(), 'Order changed since baseline');
      const fresh = await prepare(order);
      save(`fresh-${order.guid}`, { detail: fresh.detail, snapshot: fresh.snapshot, hash: fresh.hash });
      result.rows = fresh.snapshot.items.length;
      result.beforeAmount = Number(order.totalAmount);
      result.currentAmount = Number(fresh.detail.totalAmount);
      if (apply) {
        const response = await fetch('http://127.0.0.1:3000/api/1c/orders/snapshot/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: process.env.ONEC_SECRET, items: [fresh.snapshot] }),
          signal: AbortSignal.timeout(30000),
        });
        assert.equal(response.status, 200, 'Snapshot HTTP request failed');
        const outcome = await response.json();
        save(`response-${order.guid}`, outcome);
        assert.equal(outcome.results?.length, 1);
        assert.equal(outcome.results[0].status, 'ok', outcome.results[0].error);
        const stored = await db.order.findUnique({ where: { id: order.id }, select });
        save(`after-${order.guid}`, stored);
        assert.equal(stored.syncState, 'SYNCED');
        assert.equal(stored.last1cError, null);
        assert.equal(stored.revision, order.revision);
        assert.equal(stored.clientRevision, order.clientRevision);
        assert.equal(stored.clientOrderId, order.clientOrderId);
        assert.equal(stored.exportAttempts, order.exportAttempts);
        assert.equal(stored.number1c, fresh.detail.number1c);
        assert.equal(Number(stored.totalAmount), Number(fresh.detail.totalAmount));
        assert.deepEqual(normalizedLines(stored.items), normalizedLines(fresh.snapshot.items));
        assert.equal(signature(await read(order)), fresh.hash, '1C changed during reconciliation; review required');
        result.status = 'reconciled';
      } else result.status = 'ready';
    } catch (e) { result.status = 'needs-review'; result.error = e.message; }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  save('results', results);
  console.log('SUMMARY', JSON.stringify({ mode: apply ? 'apply' : 'dry-run', total: results.length,
    counts: results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}), auditDir }));
  if (results.some(x => x.status === 'needs-review')) process.exitCode = 2;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); await pool.end(); });
