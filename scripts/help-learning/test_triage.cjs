'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createHash } = require('node:crypto'); const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { createStore } = require('./store.cjs'); const { run } = require('./triage.cjs');
const NOW = Date.now() - 86400000;
const digest = value => createHash('sha256').update(value).digest('hex');
function snapshot(version = 'a', messageId = 10, createdAt = new Date(NOW - 10000).toISOString()) {
  return { ticketId: 1, sourceVersion: version.repeat(64), status: 'CLOSED', closedAt: '2026-11-05T01:00:00Z', itRequested: false,
    updatedAt: createdAt, lastEventId: 2, truncated: false, jobs: [],
    messages: [{ id: messageId, sequence: 1, authorRole: 'OWNER', kind: 'TEXT', text: 'Ошибка сохраняется.', rating: null, createdAt }] };
}
function review(source) { return { ticketId: 1, sourceVersion: source.sourceVersion, decision: 'needs_review', summary: 'Нужна проверка ответа.',
  issues: [{ code: 'SOURCE_LOOKUP', evidenceMessageIds: [source.messages[0].id], description: 'Не подтверждена полнота поиска.' }],
  resolution: { confirmed: false, evidenceMessageIds: [] }, instruction: null, regressionTests: [] }; }
function ingest(store, source, now = NOW) {
  const cursor = store.getCursor(); const batch = store.claimBatch({ schemaVersion: 1, afterEventId: cursor, nextEventId: cursor + 1, hasMore: false, snapshots: [source] }, { now });
  if (batch) store.completeBatch(batch.batchId, batch.leaseToken, [review(source)], [source], { now: now + 1 });
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'help-triage-')); const store = createStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  ingest(store, snapshot()); return { directory, store, id: store.listIssues()[0].id };
}
function proof(kind, outcome = 'PASS', at = NOW + 10, suffix = kind) {
  return { kind, ref: 'help-followup/' + suffix, sha256: digest(suffix), outcome, observedAt: at };
}
function move(store, id, from, to, now, evidence, extra = {}) {
  return store.transitionIssue(id, { expectedStatus: from, toStatus: to, operator: 'workspace-owner', rationale: 'Проверено отдельным синтетическим сценарием.', evidence, ...extra }, { now });
}
function verified(store, id) {
  move(store, id, 'NEW', 'CONFIRMED', NOW + 10, [proof('inspection', 'CONFIRMED')]);
  move(store, id, 'CONFIRMED', 'FIXED', NOW + 30, [proof('test', 'PASS', NOW + 20), proof('deployment', 'PASS', NOW + 25)]);
  move(store, id, 'FIXED', 'VERIFIED', NOW + 50, [proof('test', 'PASS', NOW + 40, 'live-check'), proof('deployment', 'PASS', NOW + 25)]);
}

test('trusted evidence drives NEW -> CONFIRMED -> FIXED -> VERIFIED with immutable provenance', t => {
  const { store, id, directory } = fixture(t); verified(store, id);
  assert.equal(store.listIssues()[0].status, 'VERIFIED');
  const transitions = store.listTransitions(id); assert.deepEqual(transitions.map(item => item.toStatus), ['NEW', 'CONFIRMED', 'FIXED', 'VERIFIED']);
  assert.equal(transitions[0].trusted, false); assert.equal(transitions[3].trusted, true);
  assert.equal(transitions[3].evidence[0].ref, 'help-followup/live-check');
  const db = new DatabaseSync(path.join(directory, 'help-learning.sqlite'));
  assert.throws(() => db.prepare("UPDATE issue_transitions SET evidence_json='[]' WHERE id=?").run(transitions[3].id), /HELP_LEARNING_APPEND_ONLY/);
  assert.throws(() => db.prepare('DELETE FROM issue_observations WHERE issue_id=?').run(id), /HELP_LEARNING_APPEND_ONLY/);
  db.close(); assert.equal(store.listTransitions(id).length, 4);
});
test('invalid transitions, model identity, missing proof, stale verification and source-only claims are rejected', t => {
  const { store, id } = fixture(t);
  assert.throws(() => move(store, id, 'NEW', 'VERIFIED', NOW + 10, [proof('test'), proof('deployment')]), { code: 'HELP_LEARNING_INVALID_TRANSITION' });
  assert.throws(() => move(store, id, 'NEW', 'CONFIRMED', NOW + 10, [proof('inspection', 'CONFIRMED')], { operator: 'model' }), { code: 'HELP_LEARNING_INVALID_TRIAGE' });
  assert.throws(() => move(store, id, 'NEW', 'CONFIRMED', NOW + 10, [{ ...proof('inspection'), kind: 'source' }]), { code: 'HELP_LEARNING_INVALID_PROOF' });
  move(store, id, 'NEW', 'CONFIRMED', NOW + 10, [proof('inspection', 'CONFIRMED')]);
  assert.throws(() => move(store, id, 'CONFIRMED', 'FIXED', NOW + 30, [proof('test')]), { code: 'HELP_LEARNING_PROOF_REQUIRED' });
  move(store, id, 'CONFIRMED', 'FIXED', NOW + 30, [proof('test'), proof('deployment')]);
  assert.throws(() => move(store, id, 'FIXED', 'VERIFIED', NOW + 40, [proof('test'), proof('deployment')]), { code: 'HELP_LEARNING_PROOF_REQUIRED' });
  assert.throws(() => move(store, id, 'NEW', 'DISMISSED', NOW + 40, [proof('inspection')], { resolutionReason: 'historical' }), { code: 'HELP_LEARNING_ISSUE_CONFLICT' });
  assert.equal(store.listIssues()[0].status, 'FIXED'); assert.equal(store.listTransitions(id).length, 3);
});
test('dismissal is an explicit historical decision, never a claim of verified repair', t => {
  const { store, id } = fixture(t);
  assert.throws(() => move(store, id, 'NEW', 'DISMISSED', NOW + 20, [proof('inspection')]), { code: 'HELP_LEARNING_PROOF_REQUIRED' });
  move(store, id, 'NEW', 'DISMISSED', NOW + 20, [proof('inspection')], { resolutionReason: 'insufficient_snapshot' });
  assert.equal(store.listIssues()[0].status, 'DISMISSED'); assert.equal(store.listTransitions(id).at(-1).resolutionReason, 'insufficient_snapshot');
});
test('old-history replay and edited source versions cannot reopen a verified issue', t => {
  const { store, id } = fixture(t); verified(store, id);
  ingest(store, snapshot('b'), NOW + 100);
  const issue = store.listIssues()[0]; assert.equal(issue.status, 'VERIFIED'); assert.equal(issue.observations.length, 2);
  assert.equal(issue.observations[1].classification, 'HISTORICAL'); assert.equal(issue.observations[1].reviewRequired, false);
  assert.equal(store.listTransitions(id).length, 4);
  ingest(store, snapshot('b'), NOW + 110); assert.equal(store.listIssues()[0].observations.length, 2);
  assert.throws(() => move(store, id, 'VERIFIED', 'CONFIRMED', NOW + 120, [proof('test', 'FAIL', NOW + 40)]), { code: 'HELP_LEARNING_PROOF_REQUIRED' });
});
test('newer model evidence creates a linked suspected observation without promoting or reopening the fixed issue', t => {
  const { store, id } = fixture(t); verified(store, id);
  ingest(store, snapshot('b', 11, new Date(NOW + 100).toISOString()), NOW + 110);
  const issues = store.listIssues(), original = issues.find(item => item.id === id), next = issues.find(item => item.id !== id);
  assert.equal(original.status, 'VERIFIED'); assert.equal(next.status, 'NEW'); assert.equal(next.parentIssueId, id);
  assert.equal(next.observations[0].classification, 'SUSPECTED'); assert.equal(next.observations[0].reviewRequired, true);
  assert.equal(store.listTransitions(id).length, 4);
});
test('only a later trusted failing test can reopen; previous repair decisions remain in history', t => {
  const { store, id } = fixture(t); verified(store, id);
  move(store, id, 'VERIFIED', 'CONFIRMED', NOW + 100, [proof('test', 'FAIL', NOW + 90, 'regression')], { resolutionReason: 'regression' });
  assert.equal(store.listIssues()[0].status, 'CONFIRMED'); assert.equal(store.listTransitions(id)[3].toStatus, 'VERIFIED');
  assert.equal(store.listIssues()[0].observations.at(-1).trusted, true);
});
test('source edits/revocation affect source state and preserve every operator decision', t => {
  const { store, id } = fixture(t); verified(store, id);
  store.reconcileSnapshots([snapshot('c')], [1], { now: NOW + 100 });
  assert.equal(store.listIssues()[0].sourceState, 'STALE'); assert.equal(store.listIssues()[0].status, 'VERIFIED');
  store.reconcileSnapshots([], [1], { now: NOW + 110 }); assert.equal(store.listIssues()[0].sourceState, 'REVOKED');
  assert.equal(store.listTransitions(id).length, 4);
});
test('issue identity canonicalizes sorted evidence IDs and repeated ingest never promotes status', t => {
  const { store } = fixture(t);
  for (const [index, ids] of [[0, [10, 11]], [1, [11, 10, 10]]]) {
    const source = snapshot(index ? 'c' : 'b'); source.messages.push({ ...source.messages[0], id: 11, sequence: 2 });
    const cursor = store.getCursor(), batch = store.claimBatch({ schemaVersion: 1, afterEventId: cursor, nextEventId: cursor + 1, hasMore: false, snapshots: [source] }, { now: NOW + 100 + index * 10 });
    const item = review(source); item.issues[0].code = 'CANONICAL'; item.issues[0].evidenceMessageIds = ids;
    store.completeBatch(batch.batchId, batch.leaseToken, [item], [source], { now: NOW + 101 + index * 10 });
  }
  const issues = store.listIssues().filter(issue => issue.code === 'CANONICAL');
  assert.equal(issues.length, 1); assert.deepEqual(issues[0].evidenceMessageIds, [10, 11]);
  assert.equal(issues[0].observations.length, 2); assert.equal(issues[0].status, 'NEW');
});
test('model output cannot inject issue status or transitions and roll back partial ingestion', t => {
  const { store } = fixture(t), source = snapshot('b'), cursor = store.getCursor();
  const batch = store.claimBatch({ schemaVersion: 1, afterEventId: cursor, nextEventId: cursor + 1, hasMore: false, snapshots: [source] }, { now: NOW + 100 });
  const value = review(source); value.issues[0].status = 'VERIFIED';
  assert.throws(() => store.completeBatch(batch.batchId, batch.leaseToken, [value], [source], { now: NOW + 101 }), { code: 'HELP_LEARNING_INVALID_REVIEW' });
  assert.equal(store.getCursor(), cursor); assert.equal(store.listIssues()[0].status, 'NEW');
});
function manifest(directory, overrides = {}) {
  const artifact = path.join(directory, 'inspection.json'); fs.writeFileSync(artifact, '{"synthetic":true,"passed":true}', { mode: 0o600 });
  const evidence = { ...proof('inspection', 'CONFIRMED', Date.now() - 1), sha256: digest(fs.readFileSync(artifact)), artifact: 'inspection.json', ...overrides };
  const filename = path.join(directory, 'manifest.json'); fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 1, evidence: [evidence] }), { mode: 0o600 }); return filename;
}
test('CLI validates local artifact hashes, transitions with CAS, and exports fixed private files', t => {
  const { store, id, directory } = fixture(t), filename = manifest(directory);
  const result = run(['transition', '--state-dir', directory, '--issue', id, '--to', 'CONFIRMED', '--expect', 'NEW', '--operator', 'workspace-owner',
    '--rationale', 'Подтверждено отдельной проверкой.', '--evidence', filename]);
  assert.equal(result.status, 'CONFIRMED'); assert.equal(store.listIssues()[0].status, 'CONFIRMED');
  const exported = run(['export', '--state-dir', directory]); assert.equal(exported.exportedIssues, 1);
  const journal = path.join(directory, 'issue-queue/journal.json'); assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(journal)).audience, 'IT_REVIEW_ONLY');
  assert.equal(run(['list', '--state-dir', directory, '--status', 'CONFIRMED']).issues.length, 1);
  assert.throws(() => run(['transition', '--state-dir', directory, '--issue', id, '--to', 'VERIFIED', '--expect', 'CONFIRMED', '--operator', 'workspace-owner',
    '--rationale', 'Некорректный файл.', '--evidence', manifest(directory, { sha256: '0'.repeat(64) })]), { code: 'HELP_LEARNING_ARTIFACT_MISMATCH' });
});
test('CLI rejects path traversal/symlinks, secrets, arbitrary commands and emits only fixed error codes', t => {
  const { directory, id } = fixture(t);
  assert.throws(() => run(['exec', '--state-dir', directory, '--command', 'echo private']), { code: 'HELP_LEARNING_INVALID_ARGUMENTS' });
  const filename = manifest(directory, { artifact: '../inspection.json' });
  assert.throws(() => run(['transition', '--state-dir', directory, '--issue', id, '--to', 'CONFIRMED', '--expect', 'NEW', '--operator', 'workspace-owner',
    '--rationale', 'Проверка.', '--evidence', filename]), { code: 'HELP_LEARNING_INVALID_MANIFEST' });
  fs.symlinkSync('manifest.json', path.join(directory, 'link.json'));
  const child = spawnSync(process.execPath, [require.resolve('./triage.cjs'), 'transition', '--state-dir', directory, '--issue', id, '--to', 'CONFIRMED', '--expect', 'NEW', '--operator', 'workspace-owner',
    '--rationale', 'password=synthetic-secret', '--evidence', path.join(directory, 'link.json')], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(child.stderr.includes('synthetic-secret'), false); assert.match(child.stderr, /HELP_LEARNING_INVALID_MANIFEST/);
  const goodManifest = manifest(directory);
  const sensitive = spawnSync(process.execPath, [require.resolve('./triage.cjs'), 'transition', '--state-dir', directory, '--issue', id, '--to', 'CONFIRMED', '--expect', 'NEW', '--operator', 'workspace-owner',
    '--rationale', 'password=synthetic-secret', '--evidence', goodManifest], { encoding: 'utf8' });
  assert.equal(sensitive.status, 1); assert.equal(sensitive.stderr.includes('synthetic-secret'), false); assert.match(sensitive.stderr, /HELP_LEARNING_INVALID_TRIAGE/);
});


test('explicit owner age review preserves administrative reason without fabricated repair evidence', t => {
  const {store,id}=fixture(t), later=NOW+3*86400000+10;
  const evidence=[proof('inspection','CONFIRMED',later,'owner-age-policy')];
  assert.throws(()=>move(store,id,'NEW','VERIFIED',NOW+3*86400000,evidence.map(p=>({...p,observedAt:NOW})),{resolutionReason:'owner_age_reviewed'}),{code:'HELP_LEARNING_PROOF_REQUIRED'});
  assert.throws(()=>move(store,id,'NEW','VERIFIED',later,evidence,{resolutionReason:'owner_age_reviewed',operator:'it-reviewer'}),{code:'HELP_LEARNING_PROOF_REQUIRED'});
  move(store,id,'NEW','VERIFIED',later,evidence,{resolutionReason:'owner_age_reviewed'});
  const transition=store.listTransitions(id).at(-1);
  assert.equal(transition.resolutionReason,'owner_age_reviewed');
  assert.equal(store.listIssues()[0].reviewBasis,'owner_age_reviewed');
  assert.deepEqual(transition.evidence.map(p=>p.kind),['inspection']);
  ingest(store,snapshot('b'),later+10);
  assert.equal(store.listIssues()[0].status,'VERIFIED');
  assert.equal(store.listIssues()[0].observations.at(-1).classification,'HISTORICAL');
});
