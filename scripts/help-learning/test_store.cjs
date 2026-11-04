'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStore } = require('./store.cjs');
function snapshot(id = 1, version = 'a') { return { ticketId: id, sourceVersion: version.repeat(64), status: 'CLOSED', closedAt: '2026-11-05T00:00:00Z',
  itRequested: false, updatedAt: '2026-11-05T00:00:00Z', lastEventId: id * 2, truncated: false, jobs: [],
  messages: [{ id: id * 10, sequence: 1, authorRole: 'OWNER', kind: 'TEXT', text: 'Спасибо, помогло. Всё работает.', rating: 5, createdAt: '2026-11-05T00:00:00Z' }] }; }
function review(source) { return { ticketId: source.ticketId, sourceVersion: source.sourceVersion, decision: 'create', summary: 'Проверка принтера помогла.', issues: [],
  resolution: { confirmed: true, evidenceMessageIds: [source.messages[0].id] },
  instruction: { title: 'Проверка принтера', body: 'Откройте очередь печати и проверьте состояние задания.', targetDocumentId: null, baseRevision: null }, regressionTests: [] }; }
function scan(snapshots, afterEventId = 0, nextEventId = 10) { return { schemaVersion: 1, afterEventId, nextEventId, hasMore: false, snapshots }; }
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'help-learning-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function open(t, dir) { const store = createStore(dir); t.after(() => store.close()); return store; }
function complete(store, batch, now = 2, fresh = batch.snapshots) {
  return store.completeBatch(batch.batchId, batch.leaseToken, batch.snapshots.map(review), fresh, { now });
}

test('cursor is acknowledged only with durable reviews and identical versions are deduplicated after reopening', t => {
  const dir = temporary(t), store = open(t, dir), source = snapshot();
  const batch = store.claimBatch(scan([source]), { now: 1 }); assert.equal(store.getCursor(), 0);
  assert.deepEqual(complete(store, batch), { batchId: batch.batchId, cursor: 10, reviewed: 1, stale: 0, removed: 0, candidates: 1 });
  store.close(); const reopened = open(t, dir);
  assert.equal(reopened.getCursor(), 10); assert.equal(reopened.claimBatch(scan([source], 10, 20), { now: 3 }), null);
  assert.equal(reopened.getCursor(), 20); assert.equal(reopened.listReviews().length, 1); assert.equal(reopened.listCandidates().length, 1);
  const candidate = reopened.listCandidates()[0]; assert.equal(candidate.status, 'REVIEW_REQUIRED'); assert.equal(candidate.audience, 'IT_REVIEW_ONLY');
  assert.match(candidate.id, /^[a-f0-9]{64}$/); assert.equal(reopened.listReviews()[0].model, 'gpt-6.1-sol');
  assert.equal(reopened.listReviews()[0].contractVersion, 1);
  assert.equal(JSON.stringify(reopened.status()).includes('принтер'), false);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
});
test('failed/expired leases keep pending input; stale holders cannot advance a cursor or publish', t => {
  const store = open(t, temporary(t)), input = scan([snapshot()]);
  const first = store.claimBatch(input, { now: 100, leaseMs: 10 });
  assert.equal(store.claimBatch(input, { now: 105 }), null);
  const second = store.claimBatch(input, { now: 111, leaseMs: 10 });
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.throws(() => complete(store, first, 112), { code: 'HELP_LEARNING_LEASE_LOST' });
  store.failBatch(second.batchId, second.leaseToken, 'MODEL_TIMEOUT', { now: 112 }); assert.equal(store.getCursor(), 0);
  const third = store.claimBatch(input, { now: 113 }); complete(store, third, 114);
  assert.equal(store.getCursor(), 10); assert.equal(store.listReviews().length, 1);
});
test('invalid output rolls back every result and cursor, with no partially eligible candidate', t => {
  const store = open(t, temporary(t)); const batch = store.claimBatch(scan([snapshot(1), snapshot(2)]), { now: 1 });
  const reviews = batch.snapshots.map(review); reviews[1].summary = 'password=fixture-private';
  assert.throws(() => store.completeBatch(batch.batchId, batch.leaseToken, reviews, batch.snapshots, { now: 2 }), { code: 'HELP_LEARNING_UNSAFE_OUTPUT' });
  assert.equal(store.getCursor(), 0); assert.equal(store.listReviews().length, 0); assert.equal(store.listCandidates().length, 0);
  complete(store, batch); assert.equal(store.getCursor(), 10);
});
test('a changed source stays pending after cursor advancement and is reviewed on an empty next scan', t => {
  const store = open(t, temporary(t)), first = snapshot(), changed = snapshot(1, 'b');
  const batch = store.claimBatch(scan([first]), { now: 1 });
  assert.equal(complete(store, batch, 2, [changed]).stale, 1);
  assert.equal(store.listCandidates().length, 0); assert.equal(store.listReviews()[0].status, 'STALE');
  const retry = store.claimBatch(scan([], 10, 11), { now: 3 }); assert.equal(retry.snapshots[0].sourceVersion, changed.sourceVersion);
  complete(store, retry, 4); assert.equal(store.listCandidates()[0].status, 'REVIEW_REQUIRED');
  assert.equal(store.getCursor(), 11);
});
test('normalized recipes deduplicate across tickets; source revocation preserves only still-authorized references', t => {
  const store = open(t, temporary(t)); const batch = store.claimBatch(scan([snapshot(1), snapshot(2)]), { now: 1 });
  const reviews = batch.snapshots.map(review); reviews[1].instruction.body = '  ОТКРОЙТЕ очередь печати\nи проверьте состояние задания.  ';
  assert.equal(store.completeBatch(batch.batchId, batch.leaseToken, reviews, batch.snapshots, { now: 2 }).candidates, 1);
  assert.equal(store.listCandidates().length, 1); assert.equal(store.listCandidates()[0].sources.length, 2);
  store.reconcileSnapshots([], [1], { now: 3 });
  assert.equal(store.listCandidates()[0].status, 'REVIEW_REQUIRED');
  assert.equal(store.listCandidates()[0].sources.filter(source => source.active).length, 1);
  assert.equal(store.listReviews().find(item => item.ticketId === 1).status, 'REJECTED');
  store.reconcileSnapshots([], [2], { now: 4 }); assert.equal(store.listCandidates()[0].status, 'STALE');
  assert.deepEqual(store.getSourceTicketIds(), []);
});
test('reconciliation winning after fresh read cannot be reverted by a late model completion', t => {
  const store = open(t, temporary(t)), source = snapshot(), changed = snapshot(1, 'c');
  const batch = store.claimBatch(scan([source]), { now: 1 });
  store.reconcileSnapshots([changed], [1], { now: 2 });
  assert.equal(complete(store, batch, 3, [source]).stale, 1);
  const retry = store.claimBatch(scan([], 10, 11), { now: 4 }); assert.equal(retry.snapshots[0].sourceVersion, changed.sourceVersion);
  store.reconcileSnapshots([], [1], { now: 5 });
  assert.equal(complete(store, retry, 6, [changed]).removed, 1);
  assert.equal(store.listCandidates().length, 0); assert.deepEqual(store.getSourceTicketIds(), []);
});
test('multiple processes racing to claim produce exactly one active lease', async t => {
  const dir = temporary(t), first = open(t, dir); first.close();
  const source = snapshot(), input = scan([source]);
  const program = `const {createStore}=require(${JSON.stringify(require.resolve('./store.cjs'))});
    const store=createStore(process.argv[1]); const result=store.claimBatch(JSON.parse(process.argv[2]),{now:1});
    process.stdout.write(JSON.stringify({claimed:!!result}));store.close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, dir, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.resume();
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error('CHILD_FAILED')));
  });
  const result = await Promise.all([run(), run()]); assert.equal(result.filter(item => item.claimed).length, 1);
  const store = open(t, dir); assert.equal(store.status().batches.ACTIVE, 1); assert.equal(store.getCursor(), 0);
});
test('process death after claiming recovers the same input after lease expiry', async t => {
  const dir = temporary(t), input = scan([snapshot()]);
  const program = `const{createStore}=require(${JSON.stringify(require.resolve('./store.cjs'))});const store=createStore(process.argv[1]);
    store.claimBatch(JSON.parse(process.argv[2]),{now:1,leaseMs:10});process.exit(0);`;
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', program, dir, JSON.stringify(input)], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('CHILD_FAILED'))); });
  const store = open(t, dir), batch = store.claimBatch(input, { now: 12 });
  assert.equal(batch.snapshots[0].ticketId, 1); complete(store, batch, 13); assert.equal(store.getCursor(), 10);
});
test('empty scans advance, mismatched cursors and output paths never enter the state API', t => {
  const store = open(t, temporary(t)); assert.equal(store.claimBatch(scan([], 0, 7), { now: 1 }), null); assert.equal(store.getCursor(), 7);
  assert.throws(() => store.claimBatch(scan([], 0, 8)), { code: 'HELP_LEARNING_CURSOR_MISMATCH' });
  assert.throws(() => store.listReviews({ limit: 1001 }), { code: 'HELP_LEARNING_INVALID_LIMIT' });
});
test('pending retries and a full scan share bounded batches without losing unselected tickets', t => {
  const store = open(t, temporary(t));
  const retries = Array.from({ length: 5 }, (_, i) => snapshot(21 + i));
  store.reconcileSnapshots(retries, retries.map(item => item.ticketId), { now: 1 });
  const sources = Array.from({ length: 20 }, (_, i) => snapshot(i + 1));
  const first = store.claimBatch(scan(sources), { now: 2 }); assert.equal(first.snapshots.length, 20);
  complete(store, first, 3); assert.equal(store.getCursor(), 10); assert.equal(store.status().tickets.PENDING, 5);
  const second = store.claimBatch(scan([], 10, 11), { now: 4 }); assert.equal(second.snapshots.length, 5);
  complete(store, second, 5); assert.equal(store.listReviews().length, 25); assert.equal(store.status().tickets.PENDING, undefined);
});
test('sanitization occurs before any transcript is committed to SQLite or its journal', t => {
  const dir = temporary(t), store = open(t, dir), source = snapshot();
  source.messages[0].text = 'Учётка: fixture_user FictionPass_73';
  const batch = store.claimBatch(scan([source]), { now: 1 });
  assert.equal(batch.snapshots[0].truncated, true); complete(store, batch);
  assert.equal(store.listCandidates().length, 0); assert.equal(store.listReviews()[0].review.resolution.confirmed, false);
  for (const filename of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, filename)).includes(Buffer.from('FictionPass_73')), false);
});
