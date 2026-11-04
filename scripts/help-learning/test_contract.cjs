'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { reviewOutputSchema, validateReviews, renderReviewOutput } = require('./contract.cjs');
function snapshot(overrides = {}) { return { ticketId: 1, sourceVersion: 'a'.repeat(64), status: 'CLOSED', closedAt: '2026-11-05T00:00:00Z',
  itRequested: false, updatedAt: '2026-11-05T00:00:00Z', lastEventId: 3, truncated: false, jobs: [],
  messages: [{ id: 1, sequence: 1, authorRole: 'OWNER', kind: 'TEXT', text: 'Спасибо, помогло. Теперь всё работает.', rating: 5, createdAt: '2026-11-05T00:00:00Z' }], ...overrides }; }
function review(overrides = {}) { return { ticketId: 1, sourceVersion: 'a'.repeat(64), decision: 'create', summary: 'Проверка принтера помогла.', issues: [],
  resolution: { confirmed: true, evidenceMessageIds: [1] }, instruction: { title: 'Проверка принтера', body: 'Откройте очередь печати и проверьте состояние задания.', targetDocumentId: null, baseRevision: null },
  regressionTests: [{ question: 'Не печатает принтер', expectedBehavior: 'Предложить проверить очередь печати.', evidenceMessageIds: [1] }], ...overrides }; }
const validate = (item = review(), source = snapshot()) => validateReviews({ schemaVersion: 1, reviews: [item] }, [source])[0];
test('Codex schema recursively requires every declared field and forbids extra fields', () => {
  function check(schema) { if (schema.anyOf) schema.anyOf.forEach(check); if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort()); Object.values(schema.properties).forEach(check);
  } if (schema.type === 'array') check(schema.items); }
  check(structuredClone(reviewOutputSchema)); assert.equal(validate().decision, 'create');
});
test('closure, rating, AI claims, untrusted USER role and truncated evidence cannot approve a recipe', () => {
  const variants = [snapshot({ status: 'OPEN', closedAt: null }), snapshot({ truncated: true }),
    snapshot({ messages: [{ ...snapshot().messages[0], text: '', kind: 'CLOSURE' }] }),
    snapshot({ messages: [{ ...snapshot().messages[0], authorRole: 'SYSTEM' }] }),
    snapshot({ messages: [{ ...snapshot().messages[0], authorRole: 'USER' }] })];
  for (const source of variants) { const result = validate(review(), source); assert.equal(result.decision, 'needs_review'); assert.equal(result.instruction, null); }
});
test('IT explicit resolution is accepted, questions/hypotheses and later human failures are not', () => {
  assert.equal(validate(review(), snapshot({ messages: [{ ...snapshot().messages[0], authorRole: 'IT' }] })).resolution.confirmed, true);
  for (const text of ['Всё работает?', 'Проблема решена?', '«Проблема решена» — так написал бот.', 'Если всё работает, закройте обращение.', 'Проблема нерешена.', 'Решение: проверьте принтер.']) {
    assert.equal(validate(review(), snapshot({ messages: [{ ...snapshot().messages[0], text }] })).instruction, null);
  }
  const source = snapshot(); source.messages.push({ ...source.messages[0], id: 2, sequence: 2, text: 'Всё ещё не работает.' });
  assert.equal(validate(review(), source).resolution.confirmed, false);
});
test('exact source set, version, extra keys and invented evidence are rejected with fixed codes', () => {
  for (const item of [review({ ticketId: 2 }), review({ sourceVersion: 'b'.repeat(64) }), review({ approved: true }),
    review({ resolution: { confirmed: true, evidenceMessageIds: [999] } })]) assert.throws(() => validate(item), /^Error: HELP_LEARNING_/);
  assert.throws(() => validateReviews({ schemaVersion: 1, reviews: [] }, [snapshot()]), { code: 'HELP_LEARNING_REVIEW_SET_MISMATCH' });
});
test('output screening rejects credential, endpoint, shell and SQL payloads rather than storing them', () => {
  for (const text of ['password=fixture-private', 'qa@example.org', 'https://fixture.invalid', 'sudo reboot', 'SELECT name FROM users', '```sh\ncommand\n```']) {
    assert.throws(() => validate(review({ summary: text })), { code: 'HELP_LEARNING_UNSAFE_OUTPUT' });
  }
  const safe = renderReviewOutput([validate()]); assert.equal(JSON.parse(safe).audience, 'IT_REVIEW_ONLY'); assert.equal(safe.includes('approved'), false);
});
test('unverified update/rewrite targets are downgraded; no_change cannot smuggle an instruction', () => {
  assert.equal(validate(review({ decision: 'update' })).decision, 'needs_review');
  assert.equal(validate(review({ decision: 'rewrite', instruction: { ...review().instruction, targetDocumentId: 'document-1', baseRevision: 2 } })).decision, 'needs_review');
  assert.throws(() => validate(review({ decision: 'no_change' })), { code: 'HELP_LEARNING_INVALID_REVIEW' });
});
