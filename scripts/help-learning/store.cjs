'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { sanitizeSnapshot, isPlainObject, containsSensitiveText } = require('./privacy.cjs');
const { validateReviews } = require('./contract.cjs');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
const hash = value => createHash('sha256').update(value).digest('hex');
const ISSUE_STATUSES = ['NEW', 'CONFIRMED', 'FIXED', 'VERIFIED', 'DISMISSED'];
const REASONS = ['confirmed_bug', 'fixed', 'verified', 'historical', 'already_fixed', 'insufficient_snapshot', 'regression'];
function strictKeys(value, required, optional = []) {
  if (!isPlainObject(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('HELP_LEARNING_INVALID_TRIAGE');
}
function issueId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('HELP_LEARNING_INVALID_ISSUE_ID'); return value; }
function safeText(value, maximum) { if (typeof value !== 'string' || !value.trim() || value.length > maximum || containsSensitiveText(value)) fail('HELP_LEARNING_INVALID_TRIAGE'); return value.trim(); }
function issueIdentity(ticketId, code, evidenceMessageIds) {
  if (!Number.isSafeInteger(ticketId) || ticketId < 1 || typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ||
      !Array.isArray(evidenceMessageIds) || evidenceMessageIds.length > 40 || evidenceMessageIds.some(id => !Number.isSafeInteger(id) || id < 1)) fail('HELP_LEARNING_INVALID_TRIAGE');
  const ids = [...new Set(evidenceMessageIds)].sort((a, b) => a - b);
  return { id: hash(JSON.stringify([ticketId, code, ids])), ids };
}
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
    CREATE INDEX IF NOT EXISTS candidate_ticket ON candidate_sources(ticket_id,active);
    CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,ticket_id INTEGER NOT NULL,code TEXT NOT NULL,evidence_ids_json TEXT NOT NULL,
      description TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('NEW','CONFIRMED','FIXED','VERIFIED','DISMISSED')),
      parent_issue_id TEXT REFERENCES issues(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_observations(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id),review_id TEXT REFERENCES reviews(id),
      source_version TEXT,description TEXT NOT NULL,classification TEXT NOT NULL CHECK(classification IN ('INITIAL','SEEN','SUSPECTED','HISTORICAL')),
      review_required INTEGER NOT NULL CHECK(review_required IN(0,1)),parent_transition_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_sources(issue_id TEXT NOT NULL REFERENCES issues(id),review_id TEXT NOT NULL REFERENCES reviews(id),
      ticket_id INTEGER NOT NULL,source_version TEXT NOT NULL,source_state TEXT NOT NULL CHECK(source_state IN ('CURRENT','STALE','REVOKED')),
      PRIMARY KEY(issue_id,review_id));
    CREATE TABLE IF NOT EXISTS issue_transitions(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id),from_status TEXT,to_status TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('INGEST','OPERATOR')),operator TEXT NOT NULL,rationale TEXT NOT NULL,evidence_json TEXT NOT NULL,
      resolution_reason TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS issue_ingested_reviews(review_id TEXT PRIMARY KEY REFERENCES reviews(id));
    CREATE INDEX IF NOT EXISTS issue_ticket_code ON issues(ticket_id,code,updated_at);
    CREATE INDEX IF NOT EXISTS issue_transition_order ON issue_transitions(issue_id,created_at,id);
    CREATE INDEX IF NOT EXISTS issue_source_ticket ON issue_sources(ticket_id,source_state);
    CREATE TRIGGER IF NOT EXISTS immutable_issue_transition_update BEFORE UPDATE ON issue_transitions BEGIN SELECT RAISE(ABORT,'HELP_LEARNING_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_issue_transition_delete BEFORE DELETE ON issue_transitions BEGIN SELECT RAISE(ABORT,'HELP_LEARNING_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_issue_observation_update BEFORE UPDATE ON issue_observations BEGIN SELECT RAISE(ABORT,'HELP_LEARNING_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_issue_observation_delete BEFORE DELETE ON issue_observations BEGIN SELECT RAISE(ABORT,'HELP_LEARNING_APPEND_ONLY'); END;
    COMMIT;`);
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
    db.prepare("UPDATE issue_sources SET source_state=? WHERE ticket_id=? AND (source_state='CURRENT' OR ?=1)").run(removed ? 'REVOKED' : 'STALE', ticketId, removed ? 1 : 0);
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
      const selected = []; let budget = 200000;
      for (const row of pending) {
        if (selected.length === 20) break;
        const snapshot = JSON.parse(row.snapshot_json), size = JSON.stringify(snapshot).length;
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
        ingestIssues(db.prepare('SELECT * FROM reviews WHERE id=?').get(reviewId), snapshot);
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
  function ingestIssues(row, snapshot) {
    if (db.prepare('SELECT 1 FROM issue_ingested_reviews WHERE review_id=?').get(row.id)) return;
    const review = JSON.parse(row.review_json);
    if (!Array.isArray(review.issues) || review.issues.length > 12) fail('HELP_LEARNING_INVALID_TRIAGE');
    for (const item of review.issues) {
      strictKeys(item, ['code', 'evidenceMessageIds', 'description']);
      const identity = issueIdentity(row.ticket_id, item.code, item.evidenceMessageIds);
      const description = safeText(item.description, 1600);
      let issue = db.prepare('SELECT * FROM issues WHERE id=?').get(identity.id);
      const previous = db.prepare("SELECT * FROM issues WHERE ticket_id=? AND code=? AND status IN ('FIXED','VERIFIED','DISMISSED') AND id!=? ORDER BY updated_at DESC,rowid DESC LIMIT 1")
        .get(row.ticket_id, item.code, identity.id);
      if (!issue) {
        db.prepare("INSERT INTO issues VALUES(?,?,?,?,?,'NEW',?,?,?)").run(identity.id, row.ticket_id, item.code, JSON.stringify(identity.ids), description, previous?.id ?? null, row.created_at, row.created_at);
        db.prepare("INSERT INTO issue_transitions VALUES(?,?,NULL,'NEW','INGEST','review-import',?,?,NULL,?)").run(
          hash(`initial:${identity.id}`), identity.id, 'Imported review observation; operator confirmation required.',
          JSON.stringify([{ kind: 'review', ref: row.id, sourceVersion: row.source_version, trusted: false }]), row.created_at);
        issue = db.prepare('SELECT * FROM issues WHERE id=?').get(identity.id);
      }
      const terminal = ['FIXED', 'VERIFIED', 'DISMISSED'].includes(issue.status) ? issue : previous;
      const terminalTransition = terminal && db.prepare("SELECT id,created_at FROM issue_transitions WHERE issue_id=? AND kind='OPERATOR' ORDER BY rowid DESC LIMIT 1").get(terminal.id);
      const evidenceTimes = snapshot ? snapshot.messages.filter(message => identity.ids.includes(message.id)).map(message => Date.parse(message.createdAt)) : [];
      // A different review/version or an old quoted failure alone is not a new
      // regression. Only genuinely newer dialogue evidence may be suspected.
      const newerObservation = terminal && terminalTransition && evidenceTimes.some(time => time > terminalTransition.created_at);
      const classification = terminal ? newerObservation ? 'SUSPECTED' : 'HISTORICAL'
        : db.prepare('SELECT 1 FROM issue_observations WHERE issue_id=?').get(identity.id) ? 'SEEN' : 'INITIAL';
      db.prepare('INSERT OR IGNORE INTO issue_observations VALUES(?,?,?,?,?,?,?,?,?)').run(hash(`${identity.id}:${row.id}`), identity.id, row.id,
        row.source_version, description, classification, terminal ? Number(Boolean(newerObservation)) : 1, terminalTransition?.id ?? null, row.created_at);
      db.prepare('INSERT OR IGNORE INTO issue_sources VALUES(?,?,?,?,?)').run(identity.id, row.id, row.ticket_id, row.source_version,
        row.status === 'CURRENT' ? 'CURRENT' : row.status === 'STALE' ? 'STALE' : 'REVOKED');
    }
    db.prepare('INSERT INTO issue_ingested_reviews VALUES(?)').run(row.id);
  }
  function listIssues(options = {}) {
    strictKeys(options, [], ['limit', 'status']);
    if (options.status !== undefined && !ISSUE_STATUSES.includes(options.status)) fail('HELP_LEARNING_INVALID_TRIAGE');
    const rows = options.status ? db.prepare('SELECT * FROM issues WHERE status=? ORDER BY updated_at DESC,id LIMIT ?').all(options.status, countLimit(options))
      : db.prepare('SELECT * FROM issues ORDER BY updated_at DESC,id LIMIT ?').all(countLimit(options));
    return rows.map(row => {
      const sources = db.prepare(`SELECT s.*,r.model,r.reasoning_effort,r.prompt_version,r.contract_version FROM issue_sources s
        JOIN reviews r ON r.id=s.review_id WHERE s.issue_id=? ORDER BY s.rowid`).all(row.id).map(source => ({
        reviewId: source.review_id, ticketId: source.ticket_id, sourceVersion: source.source_version, sourceState: source.source_state,
        model: source.model, reasoningEffort: source.reasoning_effort, promptVersion: source.prompt_version, contractVersion: source.contract_version,
      }));
      const observations = db.prepare('SELECT * FROM issue_observations WHERE issue_id=? ORDER BY rowid').all(row.id).map(observation => ({
        id: observation.id, reviewId: observation.review_id, sourceVersion: observation.source_version, description: observation.description,
        classification: observation.classification, reviewRequired: Boolean(observation.review_required), parentTransitionId: observation.parent_transition_id,
        trusted: observation.review_id === null, createdAt: observation.created_at,
      }));
      return { id: row.id, ticketId: row.ticket_id, code: row.code, evidenceMessageIds: JSON.parse(row.evidence_ids_json), description: row.description,
        status: row.status, sourceState: sources.some(source => source.sourceState === 'CURRENT') ? 'CURRENT'
          : sources.some(source => source.sourceState === 'REVOKED') ? 'REVOKED' : 'STALE',
        parentIssueId: row.parent_issue_id, audience: 'IT_REVIEW_ONLY', createdAt: row.created_at, updatedAt: row.updated_at, sources, observations };
    });
  }
  function listTransitions(input = {}, options = {}) {
    const query = typeof input === 'string' ? { ...options, issueId: input } : input;
    strictKeys(query, [], ['limit', 'issueId']);
    if (query.issueId !== undefined) issueId(query.issueId);
    const rows = query.issueId ? db.prepare('SELECT * FROM issue_transitions WHERE issue_id=? ORDER BY rowid LIMIT ?').all(query.issueId, countLimit(query))
      : db.prepare('SELECT * FROM issue_transitions ORDER BY rowid LIMIT ?').all(countLimit(query));
    return rows.map(row => ({ id: row.id, issueId: row.issue_id, fromStatus: row.from_status, toStatus: row.to_status, kind: row.kind,
      trusted: row.kind === 'OPERATOR', operator: row.operator, rationale: row.rationale, evidence: JSON.parse(row.evidence_json),
      resolutionReason: row.resolution_reason, createdAt: row.created_at }));
  }
  function transitionIssue(id, request, options = {}) {
    issueId(id); strictKeys(request, ['toStatus', 'expectedStatus', 'operator', 'rationale', 'evidence'], ['resolutionReason']);
    if (!ISSUE_STATUSES.includes(request.toStatus) || !ISSUE_STATUSES.includes(request.expectedStatus) ||
        typeof request.operator !== 'string' || !/^[a-z][a-z0-9_-]{2,63}$/.test(request.operator) || ['model', 'assistant', 'system', 'scheduler', 'codex', 't3'].includes(request.operator) ||
        request.resolutionReason !== undefined && !REASONS.includes(request.resolutionReason)) fail('HELP_LEARNING_INVALID_TRIAGE');
    const now = clock(options), rationale = safeText(request.rationale, 1600);
    if (!Array.isArray(request.evidence) || request.evidence.length < 1 || request.evidence.length > 16) fail('HELP_LEARNING_INVALID_PROOF');
    const evidence = request.evidence.map(proof => {
      strictKeys(proof, ['kind', 'ref', 'sha256', 'outcome', 'observedAt']);
      if (!['inspection', 'test', 'deployment'].includes(proof.kind) || !['PASS', 'FAIL', 'CONFIRMED'].includes(proof.outcome) ||
          typeof proof.ref !== 'string' || !/^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][A-Za-z0-9._:#/-]{0,199}$/.test(proof.ref) || containsSensitiveText(proof.ref) ||
          typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sha256) || !Number.isSafeInteger(proof.observedAt) || proof.observedAt < 0 || proof.observedAt > now) fail('HELP_LEARNING_INVALID_PROOF');
      return { ...proof };
    });
    if (new Set(evidence.map(proof => `${proof.kind}:${proof.ref}:${proof.sha256}`)).size !== evidence.length) fail('HELP_LEARNING_INVALID_PROOF');
    return transaction(() => {
      const issue = db.prepare('SELECT * FROM issues WHERE id=?').get(id);
      if (!issue) fail('HELP_LEARNING_ISSUE_NOT_FOUND');
      if (now < issue.updated_at) fail('HELP_LEARNING_INVALID_TIME');
      if (issue.status !== request.expectedStatus) fail('HELP_LEARNING_ISSUE_CONFLICT');
      const transitions = { NEW: ['CONFIRMED', 'DISMISSED'], CONFIRMED: ['FIXED', 'DISMISSED'], FIXED: ['VERIFIED', 'CONFIRMED', 'DISMISSED'],
        VERIFIED: ['CONFIRMED', 'DISMISSED'], DISMISSED: ['CONFIRMED'] };
      if (!transitions[issue.status].includes(request.toStatus)) fail('HELP_LEARNING_INVALID_TRANSITION');
      const tests = evidence.filter(proof => proof.kind === 'test' && proof.outcome === 'PASS');
      const deployments = evidence.filter(proof => proof.kind === 'deployment' && proof.outcome === 'PASS');
      if (['FIXED', 'VERIFIED'].includes(request.toStatus) && (!tests.length || !deployments.length)) fail('HELP_LEARNING_PROOF_REQUIRED');
      if (request.toStatus === 'VERIFIED' && !tests.some(proof => proof.observedAt > issue.updated_at && deployments.some(deployment => proof.observedAt >= deployment.observedAt))) fail('HELP_LEARNING_PROOF_REQUIRED');
      if (request.toStatus === 'DISMISSED' && (!['historical', 'already_fixed', 'insufficient_snapshot'].includes(request.resolutionReason) ||
          !evidence.some(proof => proof.kind === 'inspection' && ['PASS', 'CONFIRMED'].includes(proof.outcome)))) fail('HELP_LEARNING_PROOF_REQUIRED');
      const reopening = request.toStatus === 'CONFIRMED' && ['FIXED', 'VERIFIED', 'DISMISSED'].includes(issue.status);
      if (request.toStatus === 'CONFIRMED' && !evidence.some(proof => ['inspection', 'test'].includes(proof.kind) && ['FAIL', 'CONFIRMED'].includes(proof.outcome))) fail('HELP_LEARNING_PROOF_REQUIRED');
      if (reopening && !evidence.some(proof => ['inspection', 'test'].includes(proof.kind) && proof.outcome === 'FAIL' && proof.observedAt > issue.updated_at)) fail('HELP_LEARNING_PROOF_REQUIRED');
      const transitionId = hash(randomUUID());
      const previous = db.prepare("SELECT id FROM issue_transitions WHERE issue_id=? AND kind='OPERATOR' ORDER BY rowid DESC LIMIT 1").get(id);
      db.prepare("INSERT INTO issue_transitions VALUES(?,?,?,?,'OPERATOR',?,?,?,?,?)").run(transitionId, id, issue.status, request.toStatus,
        request.operator, rationale, JSON.stringify(evidence), request.resolutionReason ?? null, now);
      if (reopening) db.prepare('INSERT INTO issue_observations VALUES(?,?,NULL,NULL,?,?,1,?,?)').run(hash(`regression:${transitionId}`), id,
        rationale, 'SUSPECTED', previous?.id ?? null, now);
      db.prepare('UPDATE issues SET status=?,updated_at=? WHERE id=?').run(request.toStatus, now, id);
      return { issueId: id, status: request.toStatus, transitionId };
    });
  }
  function status() {
    const counts = table => Object.fromEntries(db.prepare(`SELECT ${table === 'tickets' ? 'disposition' : 'status'} AS state,count(*) AS count FROM ${table} GROUP BY state`).all().map(row => [row.state, row.count]));
    return { cursor: getCursor(), tickets: counts('tickets'), batches: counts('batches'), reviews: counts('reviews'), candidates: counts('candidates'), issues: counts('issues') };
  }
  function close() { if (!closed) { permissions(); db.close(); closed = true; } }
  // Additive/idempotent backfill; never reset cursor, leases, reviews or queues.
  transaction(() => {
    for (const row of db.prepare('SELECT * FROM reviews WHERE id NOT IN (SELECT review_id FROM issue_ingested_reviews) ORDER BY created_at,rowid').iterate()) ingestIssues(row, null);
  });
  return { getCursor, claimBatch, completeBatch, failBatch, status, getSourceTicketIds, reconcileSnapshots, listReviews, listCandidates,
    listIssues, listTransitions, transitionIssue, close };
}
module.exports = { createStore };
