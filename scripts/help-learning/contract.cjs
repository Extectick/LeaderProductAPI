'use strict';
const { containsSensitiveText, isPlainObject, sanitizeSnapshot } = require('./privacy.cjs');
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const refs = array(integer, 40);
const reviewSchema = object({
  ticketId: integer, sourceVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  decision: { type: 'string', enum: ['no_change', 'needs_review', 'create', 'update', 'rewrite'] },
  summary: string(1200), issues: array(object({ code: { ...string(64), pattern: '^[A-Z][A-Z0-9_]*$' }, evidenceMessageIds: refs, description: string(1600) }), 12),
  resolution: object({ confirmed: { type: 'boolean' }, evidenceMessageIds: refs }),
  instruction: nullable(object({ title: string(180), body: string(12000), targetDocumentId: nullable({ ...string(128), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' }), baseRevision: nullable(integer) })),
  regressionTests: array(object({ question: string(1000), expectedBehavior: string(1600), evidenceMessageIds: refs }), 8),
});
const reviewOutputSchema = object({ schemaVersion: { type: 'integer', const: 1 }, reviews: array(reviewSchema, 20) });
function fail(code = 'HELP_LEARNING_INVALID_REVIEW') { const error = new Error(code); error.code = code; throw error; }
function shape(value, schema) {
  if (schema.anyOf) {
    if (!schema.anyOf.some(option => { try { shape(value, option); return true; } catch { return false; } })) fail();
    return;
  }
  if (schema.const !== undefined && value !== schema.const || schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === 'null') { if (value !== null) fail(); }
  else if (schema.type === 'object') {
    if (!isPlainObject(value) || Object.keys(value).length !== schema.required.length || schema.required.some(key => !Object.hasOwn(value, key))) fail();
    for (const key of schema.required) shape(value[key], schema.properties[key]);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail();
    value.forEach(item => shape(item, schema.items));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) fail();
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail();
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail();
}
const EXECUTABLE = /(?:```|\b(?:sudo|curl|wget|powershell|cmd\.exe|bash\s+-|sh\s+-|ssh\s+|docker\s+exec|rm\s+-|eval\s*\(|child_process|process\.env)\b|(?:^|[\n`])\s*(?:[$>#]\s*)?(?:rm|cat|ls|chmod|chown|cp|mv|tee|printf|echo|python3?|node|npm|npx|psql|sqlite3|git|ssh|curl|wget)\s|\b(?:SELECT\s+.{0,160}\s+FROM|DELETE\s+FROM|INSERT\s+INTO|DROP\s+(?:TABLE|DATABASE)|UPDATE\s+.{0,80}\s+SET)\b|javascript:|<\/?[a-z][^>]*>|!?\[[^\]]*\]\s*\(|&&|\|\s*(?:sh|bash)\b)/iu;
function screen(text) { if (containsSensitiveText(text) || EXECUTABLE.test(text)) fail('HELP_LEARNING_UNSAFE_OUTPUT'); }
function screenReview(review) {
  [review.summary, ...review.issues.flatMap(issue => [issue.code, issue.description]), ...(review.instruction ? [review.instruction.title, review.instruction.body, ...(review.instruction.targetDocumentId ? [review.instruction.targetDocumentId] : [])] : []),
    ...review.regressionTests.flatMap(test => [test.question, test.expectedBehavior])].forEach(screen);
}
const POSITIVE = /(?:(?:помогл[оаи]|заработал[оаи]?|исправлен[аоы]?|устран[её]н[аоы]?|реш[её]н[аоы]?)(?![а-яё])|(?:вс[её]|теперь|снова)\s+работает|работает\s+(?:правильно|нормально)|вс[её]\s+(?:хорошо|в\s+порядке)|\b(?:resolved|fixed|works\s+now|working\s+now)\b)/iu;
const NEGATIVE = /(?:не\s*(?:помог|работ|исправ|реш|устран)|не\s+удалось|вс[её]\s+ещ[её]|проблема\s+оста[её]тся|\b(?:not\s+(?:fixed|resolved|working)|doesn.t\s+work|still\s+(?:broken|failing))\b)/iu;
const UNCERTAIN = /(?:["'«»„“”‘’]|(?:^|[^\p{L}])(?:бот|помощник|цитат[а-яё]*|написал[аи]?|сказал[аи]?)(?=[^\p{L}]|$)|\?|(?:^|\s)(?:если|должно|попробуйте|проверьте|возможно|наверное)(?:\s|[,.:])|\b(?:should|if|maybe)\b)/iu;
function validateReviews(value, snapshots) {
  shape(value, reviewOutputSchema);
  if (!Array.isArray(snapshots) || snapshots.length > 20) fail();
  const source = new Map(snapshots.map(snapshot => { const safe = sanitizeSnapshot(snapshot); return [safe.ticketId, safe]; }));
  if (source.size !== snapshots.length || value.reviews.length !== source.size) fail('HELP_LEARNING_REVIEW_SET_MISMATCH');
  const seen = new Set();
  return value.reviews.map(raw => {
    screenReview(raw);
    const snapshot = source.get(raw.ticketId);
    if (!snapshot || seen.has(raw.ticketId) || raw.sourceVersion !== snapshot.sourceVersion) fail('HELP_LEARNING_REVIEW_SET_MISMATCH');
    seen.add(raw.ticketId);
    const messages = new Map(snapshot.messages.map(message => [message.id, message]));
    const cited = [...raw.resolution.evidenceMessageIds, ...raw.issues.flatMap(issue => issue.evidenceMessageIds), ...raw.regressionTests.flatMap(test => test.evidenceMessageIds)];
    if (cited.some(id => !messages.has(id))) fail('HELP_LEARNING_INVALID_EVIDENCE');
    const human = message => ['OWNER', 'IT'].includes(message.authorRole);
    const evidence = raw.resolution.evidenceMessageIds.map(id => messages.get(id)).filter(message => human(message) && POSITIVE.test(message.text) && !NEGATIVE.test(message.text) && !UNCERTAIN.test(message.text));
    const lastPositive = Math.max(-1, ...evidence.map(message => message.sequence));
    const contradicted = snapshot.messages.some(message => human(message) && message.sequence > lastPositive && NEGATIVE.test(message.text));
    const confirmed = raw.resolution.confirmed && snapshot.status === 'CLOSED' && !!snapshot.closedAt && !snapshot.truncated && evidence.length > 0 && !contradicted;
    const review = structuredClone(raw);
    review.resolution.confirmed = confirmed;
    if (['create', 'update', 'rewrite'].includes(review.decision)) {
      const targetValid = review.instruction && (review.decision === 'create'
        ? review.instruction.targetDocumentId === null && review.instruction.baseRevision === null
        // Published article content/ACL is intentionally not in this source.
        // A model-supplied document id/revision cannot verify its own target.
        : false);
      if (snapshot.status !== 'CLOSED' || !snapshot.closedAt || snapshot.truncated || !confirmed || !targetValid) {
        review.decision = 'needs_review'; review.instruction = null;
      }
    } else if (review.instruction !== null) fail();
    return review;
  });
}
function renderReviewOutput(value) {
  const output = Array.isArray(value) ? { schemaVersion: 1, reviews: value } : value;
  shape(output, reviewOutputSchema); output.reviews.forEach(screenReview);
  return JSON.stringify({ schemaVersion: 1, audience: 'IT_REVIEW_ONLY', reviews: output.reviews }, null, 2) + '\n';
}
module.exports = { reviewOutputSchema, validateReviews, renderReviewOutput };
