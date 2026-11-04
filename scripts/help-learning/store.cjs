'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { sanitizeSnapshot, isPlainObject } = require('./privacy.cjs');
const { validateReviews } = require('./contract.cjs');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
const hash = value => createHash('sha256').update(value).digest('hex');
const textSize = snapshot => snapshot.messages.reduce((size, message) => size + message.text.length, 0);
const countLimit = options => {
  const limit = options?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('HELP_LEARNING_INVALID_LIMIT');
  return limit;
};
function clock(options) {
  const now = options?.now instanceof Date ? options.now.getTime() : options?.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) fail('HELP_LEARNING_INVALID_TIME');
  return now;
}
function snapshotsInput(input, maximum = 20) {
  if (!Array.isArray(input) || input.length > maximum) fail('HELP_LEARNING_INVALID_SNAPSHOTS');
  const snapshots = input.map(sanitizeSnapshot);
  if (new Set(snapshots.map(snapshot => snapshot.ticketId)).size !== snapshots.length || snapshots.reduce((size, snapshot) => size + textSize(snapshot), 0) > 160000) fail('HELP_LEARNING_INVALID_SNAPSHOTS');
  return snapshots;
}
function createStore(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) fail('HELP_LEARNING_INVALID_STATE_DIR');
  const directory = path.resolve(stateDir), dbPath = path.join(directory, 'help-learning.sqlite');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('HELP_LEARNING_INVALID_STATE_DIR');
  fs.chmodSync(directory, 0o700);
  const fd = fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try { if (!fs.fstatSync(fd).isFile()) fail('HELP_LEARNING_INVALID_STATE_FILE'); fs.fchmodSync(fd, 0o600); }
  finally { fs.closeSync(fd); }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta VALUES('cursor','0');
    CREATE TABLE IF NOT EXISTS tickets(ticket_id INTEGER PRIMARY KEY,source_version TEXT NOT NULL,snapshot_json TEXT,
      disposition TEXT NOT NULL CHECK(disposition IN ('PENDING','REVIEWED','REMOVED')),updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,lease_token TEXT NOT NULL,status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER,after_event INTEGER NOT NULL,next_event INTEGER NOT NULL,
      snapshots_json TEXT NOT NULL,error_code TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch ON batches(status) WHERE status='ACTIVE';
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,ticket_id INTEGER NOT NULL,source_version TEXT NOT NULL,review_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('CURRENT','STALE','REJECTED')),audience TEXT NOT NULL CHECK(audience='IT_REVIEW_ONLY'),
      created_at INTEGER NOT NULL,model TEXT NOT NULL,reasoning_effort TEXT NOT NULL,prompt_version TEXT NOT NULL,contract_version INTEGER NOT NULL,
      UNIQUE(ticket_id,source_version));
    CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,target_document_id TEXT,base_revision INTEGER,
      status TEXT NOT NULL CHECK(status IN ('REVIEW_REQUIRED','STALE','REJECTED')),audience TEXT NOT NULL CHECK(audience='IT_REVIEW_ONLY'),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS candidate_sources(candidate_id TEXT NOT NULL REFERENCES candidates(id),ticket_id INTEGER NOT NULL,source_version TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN(0,1)),PRIMARY KEY(candidate_id,ticket_id,source_version));
    CREATE INDEX IF NOT EXISTS pending_tickets ON tickets(disposition,updated_at,ticket_id);
    CREATE INDEX IF NOT EXISTS candidate_ticket ON candidate_sources(ticket_id,active); COMMIT;`);
  let closed = false;
  const permissions = () => { for (const filename of [dbPath, dbPath + '-wal', dbPath + '-shm']) { if (fs.existsSync(filename)) fs.chmodSync(filename, 0o600); } };
  permissions();
  function transaction(fn) {
    if (closed) fail('HELP_LEARNING_STORE_CLOSED');
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); permissions(); return result; }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function getCursor() { return Number(db.prepare("SELECT value FROM meta WHERE key='cursor'").get().value); }
  function advanceCursor(cursor) { db.prepare("UPDATE meta SET value=? WHERE key='cursor'").run(String(Math.max(getCursor(), cursor))); }
  function refreshCandidates(now) {
    db.prepare(`UPDATE candidates SET status=CASE WHEN EXISTS(SELECT 1 FROM candidate_sources s WHERE s.candidate_id=candidates.id AND s.active=1)
      THEN 'REVIEW_REQUIRED' ELSE 'STALE' END,updated_at=? WHERE status!='REJECTED'`).run(now);
  }
  function invalidate(ticketId, now, removed = false) {
    db.prepare('UPDATE candidate_sources SET active=0 WHERE ticket_id=?').run(ticketId);
    db.prepare("UPDATE reviews SET status=? WHERE ticket_id=? AND status='CURRENT'").run(removed ? 'REJECTED' : 'STALE', ticketId);
    if (removed) db.prepare("UPDATE tickets SET disposition='REMOVED',snapshot_json=NULL,updated_at=? WHERE ticket_id=?").run(now, ticketId);
  }
  function merge(snapshot, now) {
    const previous = db.prepare('SELECT source_version,disposition FROM tickets WHERE ticket_id=?').get(snapshot.ticketId);
    if (previous && (previous.source_version !== snapshot.sourceVersion || previous.disposition === 'REMOVED')) invalidate(snapshot.ticketId, now);
    const reviewed = db.prepare('SELECT 1 FROM reviews WHERE ticket_id=? AND source_version=?').get(snapshot.ticketId, snapshot.sourceVersion);
    db.prepare(`INSERT INTO tickets VALUES(?,?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET source_version=excluded.source_version,
      snapshot_json=excluded.snapshot_json,disposition=excluded.disposition,updated_at=excluded.updated_at`).run(
      snapshot.ticketId, snapshot.sourceVersion, JSON.stringify(snapshot), reviewed ? 'REVIEWED' : 'PENDING', now);
  }
  function validBatch(batchId, leaseToken, now) {
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
    if (!batch || batch.status !== 'ACTIVE' || typeof leaseToken !== 'string' || batch.lease_token !== leaseToken) fail('HELP_LEARNING_LEASE_LOST');
    if (batch.expires_at <= now) fail('HELP_LEARNING_LEASE_EXPIRED');
    return batch;
  }
  function claimBatch(scan, options = {}) {
    if (!isPlainObject(scan) || scan.schemaVersion !== 1 || !Number.isSafeInteger(scan.afterEventId) || scan.afterEventId < 0 ||
      !Number.isSafeInteger(scan.nextEventId) || scan.nextEventId < scan.afterEventId || typeof scan.hasMore !== 'boolean') fail('HELP_LEARNING_INVALID_SCAN');
    const snapshots = snapshotsInput(scan.snapshots), now = clock(options), leaseMs = options.leaseMs ?? 600000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000 || !Number.isSafeInteger(now + leaseMs)) fail('HELP_LEARNING_INVALID_LEASE');
    return transaction(() => {
      if (scan.afterEventId !== getCursor()) fail('HELP_LEARNING_CURSOR_MISMATCH');
      if (db.prepare("SELECT 1 FROM batches WHERE status='ACTIVE' AND expires_at>?").get(now)) return null;
      db.prepare("UPDATE batches SET status='EXPIRED',error_code='LEASE_EXPIRED' WHERE status='ACTIVE'").run();
      snapshots.forEach(snapshot => merge(snapshot, now)); refreshCandidates(now);
      const pending = db.prepare("SELECT snapshot_json FROM tickets WHERE disposition='PENDING' ORDER BY updated_at,ticket_id").iterate();
      const selected = []; let budget = 160000;
      for (const row of pending) {
        if (selected.length === 20) break;
        const snapshot = JSON.parse(row.snapshot_json), size = textSize(snapshot);
        if (selected.length < 20 && size <= budget) { selected.push(snapshot); budget -= size; }
      }
      if (!selected.length) { advanceCursor(scan.nextEventId); return null; }
      const batchId = randomUUID(), leaseToken = randomUUID(), expiresAt = now + leaseMs;
      db.prepare(`INSERT INTO batches(id,lease_token,status,expires_at,created_at,after_event,next_event,snapshots_json)
        VALUES(?,?,'ACTIVE',?,?,?,?,?)`).run(batchId, leaseToken, expiresAt, now, scan.afterEventId, scan.nextEventId, JSON.stringify(selected));
      return { batchId, leaseToken, expiresAt, snapshots: selected };
    });
  }
  function completeBatch(batchId, leaseToken, reviews, freshSnapshots, options = {}) {
    const now = clock(options), fresh = snapshotsInput(freshSnapshots);
    const model = options.model ?? 'gpt-6.1-sol', reasoning = options.reasoningEffort ?? 'high', promptVersion = options.promptVersion ?? 'help-learning-v1';
    if (!/^[a-z0-9._-]{1,80}$/.test(model) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning) || !/^[a-zA-Z0-9._:-]{1,80}$/.test(promptVersion)) fail('HELP_LEARNING_INVALID_PROVENANCE');
    return transaction(() => {
      const batch = validBatch(batchId, leaseToken, now), snapshots = JSON.parse(batch.snapshots_json);
      const validated = validateReviews(Array.isArray(reviews) ? { schemaVersion: 1, reviews } : reviews, snapshots);
      const expected = new Set(snapshots.map(snapshot => snapshot.ticketId));
      if (fresh.some(snapshot => !expected.has(snapshot.ticketId))) fail('HELP_LEARNING_REVIEW_SET_MISMATCH');
      const latest = new Map(fresh.map(snapshot => [snapshot.ticketId, snapshot]));
      let reviewed = 0, stale = 0, removed = 0;
      const candidateIds = new Set();
      for (const review of validated) {
        const observed = db.prepare('SELECT source_version,snapshot_json,disposition FROM tickets WHERE ticket_id=?').get(review.ticketId);
        const changedDuringBatch = observed && (observed.source_version !== review.sourceVersion || observed.disposition === 'REMOVED');
        // A reconciliation can win after the caller read freshSnapshots. Never
        // roll its newer observation/revocation back to this batch's old version.
        const snapshot = !latest.has(review.ticketId) || observed?.disposition === 'REMOVED' ? undefined
          : changedDuringBatch ? JSON.parse(observed.snapshot_json) : latest.get(review.ticketId);
        const current = snapshot?.sourceVersion === review.sourceVersion;
        if (!snapshot) { invalidate(review.ticketId, now, true); removed++; }
        else if (!current) { invalidate(review.ticketId, now); merge(snapshot, now); stale++; }
        else { merge(snapshot, now); db.prepare("UPDATE tickets SET disposition='REVIEWED' WHERE ticket_id=?").run(review.ticketId); reviewed++; }
        const reviewId = hash(`${review.ticketId}:${review.sourceVersion}`);
        db.prepare(`INSERT OR IGNORE INTO reviews VALUES(?,?,?,?,?,'IT_REVIEW_ONLY',?,?,?,?,?)`).run(reviewId, review.ticketId, review.sourceVersion,
          JSON.stringify(review), current ? 'CURRENT' : snapshot ? 'STALE' : 'REJECTED', now, model, reasoning, promptVersion, 1);
        if (current && review.instruction) {
          const instruction = review.instruction;
          const normalize = text => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
          const candidateId = hash(JSON.stringify([normalize(instruction.body), instruction.targetDocumentId, instruction.baseRevision]));
          db.prepare(`INSERT OR IGNORE INTO candidates VALUES(?,?,?,?,?,'REVIEW_REQUIRED','IT_REVIEW_ONLY',?,?)`).run(
            candidateId, instruction.title, instruction.body, instruction.targetDocumentId, instruction.baseRevision, now, now);
          db.prepare(`INSERT INTO candidate_sources VALUES(?,?,?,1) ON CONFLICT(candidate_id,ticket_id,source_version) DO UPDATE SET active=1`).run(candidateId, review.ticketId, review.sourceVersion);
          candidateIds.add(candidateId);
        }
      }
      refreshCandidates(now);
      db.prepare("UPDATE batches SET status='COMPLETED',completed_at=? WHERE id=?").run(now, batchId);
      advanceCursor(batch.next_event);
      return { batchId, cursor: getCursor(), reviewed, stale, removed, candidates: candidateIds.size };
    });
  }
  function failBatch(batchId, leaseToken, code, options = {}) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) fail('HELP_LEARNING_INVALID_FAILURE');
    return transaction(() => {
      const now = clock(options); validBatch(batchId, leaseToken, now);
      db.prepare("UPDATE batches SET status='FAILED',error_code=?,completed_at=? WHERE id=?").run(code, now, batchId);
      return { batchId, cursor: getCursor() };
    });
  }
  function getSourceTicketIds() {
    return db.prepare(`SELECT ticket_id FROM tickets WHERE disposition='PENDING' UNION SELECT ticket_id FROM candidate_sources WHERE active=1
      UNION SELECT ticket_id FROM reviews WHERE status='CURRENT' ORDER BY ticket_id`).all().map(row => row.ticket_id);
  }
  function reconcileSnapshots(freshSnapshots, requestedIds, options = {}) {
    const fresh = snapshotsInput(freshSnapshots), now = clock(options);
    if (!Array.isArray(requestedIds) || requestedIds.length > 20 || requestedIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(requestedIds).size !== requestedIds.length || fresh.some(snapshot => !requestedIds.includes(snapshot.ticketId))) fail('HELP_LEARNING_INVALID_SNAPSHOTS');
    return transaction(() => {
      const latest = new Map(fresh.map(snapshot => [snapshot.ticketId, snapshot]));
      let stale = 0, removed = 0;
      for (const id of requestedIds) {
        const previous = db.prepare('SELECT source_version,disposition FROM tickets WHERE ticket_id=?').get(id), snapshot = latest.get(id);
        if (!snapshot) { if (previous && previous.disposition !== 'REMOVED') removed++; invalidate(id, now, true); }
        else { if (previous && previous.source_version !== snapshot.sourceVersion) stale++; merge(snapshot, now); }
      }
      refreshCandidates(now);
      const pending = db.prepare("SELECT count(*) AS count FROM tickets WHERE disposition='PENDING'").get().count;
      return { stale, removed, pending };
    });
  }
  function listReviews(options = {}) {
    return db.prepare('SELECT * FROM reviews ORDER BY created_at DESC,id LIMIT ?').all(countLimit(options)).map(row => ({
      id: row.id, ticketId: row.ticket_id, sourceVersion: row.source_version, status: row.status, audience: row.audience,
      createdAt: row.created_at, model: row.model, reasoningEffort: row.reasoning_effort, promptVersion: row.prompt_version,
      contractVersion: row.contract_version, review: JSON.parse(row.review_json),
    }));
  }
  function listCandidates(options = {}) {
    return db.prepare('SELECT * FROM candidates ORDER BY created_at DESC,id LIMIT ?').all(countLimit(options)).map(row => ({
      id: row.id, title: row.title, body: row.body, targetDocumentId: row.target_document_id, baseRevision: row.base_revision,
      status: row.status, audience: row.audience, createdAt: row.created_at, updatedAt: row.updated_at,
      sources: db.prepare('SELECT ticket_id,source_version,active FROM candidate_sources WHERE candidate_id=? ORDER BY ticket_id,source_version').all(row.id)
        .map(source => ({ ticketId: source.ticket_id, sourceVersion: source.source_version, active: Boolean(source.active) })),
    }));
  }
  function status() {
    const counts = table => Object.fromEntries(db.prepare(`SELECT ${table === 'tickets' ? 'disposition' : 'status'} AS state,count(*) AS count FROM ${table} GROUP BY state`).all().map(row => [row.state, row.count]));
    return { cursor: getCursor(), tickets: counts('tickets'), batches: counts('batches'), reviews: counts('reviews'), candidates: counts('candidates') };
  }
  function close() { if (!closed) { permissions(); db.close(); closed = true; } }
  return { getCursor, claimBatch, completeBatch, failBatch, status, getSourceTicketIds, reconcileSnapshots, listReviews, listCandidates, close };
}
module.exports = { createStore };
