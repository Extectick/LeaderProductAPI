'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createStore } = require('./store.cjs');
const { isPlainObject } = require('./privacy.cjs');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function readFile(filename, maxBytes) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) fail('HELP_LEARNING_INVALID_ARTIFACT');
    // The file can grow after fstat (for example, a test still writing a log).
    // Read at most the limit plus one byte rather than allocating its new size.
    const buffer = Buffer.allocUnsafe(maxBytes + 1); let size = 0;
    while (size <= maxBytes) { const count = fs.readSync(fd, buffer, size, maxBytes + 1 - size, null); if (!count) break; size += count; }
    if (size > maxBytes) fail('HELP_LEARNING_INVALID_ARTIFACT'); return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function readEvidence(filename) {
  let manifest;
  try { manifest = JSON.parse(readFile(filename, 65536).toString('utf8')); } catch { fail('HELP_LEARNING_INVALID_MANIFEST'); }
  if (!isPlainObject(manifest) || Object.keys(manifest).sort().join(',') !== 'evidence,schemaVersion' || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.evidence) || manifest.evidence.length < 1 || manifest.evidence.length > 16) fail('HELP_LEARNING_INVALID_MANIFEST');
  return manifest.evidence.map(item => {
    if (!isPlainObject(item) || Object.keys(item).sort().join(',') !== 'artifact,kind,observedAt,outcome,ref,sha256' ||
      typeof item.artifact !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.artifact) || item.artifact.includes('..') ||
      typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('HELP_LEARNING_INVALID_MANIFEST');
    let digest;
    try { digest = createHash('sha256').update(readFile(path.join(path.dirname(filename), item.artifact), 2 * 1024 * 1024)).digest('hex'); }
    catch { fail('HELP_LEARNING_INVALID_ARTIFACT'); }
    if (digest !== item.sha256) fail('HELP_LEARNING_ARTIFACT_MISMATCH');
    const { artifact, ...proof } = item; return proof;
  });
}
function parseArguments(argv) {
  const [command, ...args] = argv;
  const allowed = { list: ['state-dir', 'status', 'limit'], transitions: ['state-dir', 'issue', 'limit'],
    transition: ['state-dir', 'issue', 'to', 'expect', 'operator', 'rationale', 'evidence', 'reason'], export: ['state-dir', 'limit'] };
  if (!Object.hasOwn(allowed, command) || args.length % 2) fail('HELP_LEARNING_INVALID_ARGUMENTS');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, '');
    if (args[index] !== '--' + key || !allowed[command].includes(key) || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith('--')) fail('HELP_LEARNING_INVALID_ARGUMENTS');
    options[key] = args[index + 1];
  }
  if (!options['state-dir']) fail('HELP_LEARNING_INVALID_ARGUMENTS');
  if (options.limit !== undefined && !/^[1-9]\d{0,3}$/.test(options.limit)) fail('HELP_LEARNING_INVALID_LIMIT');
  if (options.limit !== undefined && Number(options.limit) > 1000) fail('HELP_LEARNING_INVALID_LIMIT');
  if (command === 'transition' && ['issue', 'to', 'expect', 'operator', 'rationale', 'evidence'].some(key => !options[key])) fail('HELP_LEARNING_INVALID_ARGUMENTS');
  return { command, options };
}
function privateExport(stateDir, journal) {
  const directory = path.join(path.resolve(stateDir), 'issue-queue');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) fail('HELP_LEARNING_INVALID_STATE_DIR');
  fs.chmodSync(directory, 0o700);
  const destination = path.join(directory, 'journal.json');
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) fail('HELP_LEARNING_INVALID_STATE_FILE');
  const temporary = path.join(directory, `.journal-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, destination); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function run(argv) {
  const { command, options } = parseArguments(argv), store = createStore(options['state-dir']);
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  try {
    if (command === 'list') return { schemaVersion: 1, audience: 'IT_REVIEW_ONLY', issues: store.listIssues({ limit, ...(options.status ? { status: options.status } : {}) }) };
    if (command === 'transitions') return { schemaVersion: 1, transitions: store.listTransitions({ limit, ...(options.issue ? { issueId: options.issue } : {}) }) };
    if (command === 'transition') return store.transitionIssue(options.issue, { toStatus: options.to, expectedStatus: options.expect, operator: options.operator,
      rationale: options.rationale, evidence: readEvidence(path.resolve(options.evidence)), ...(options.reason ? { resolutionReason: options.reason } : {}) });
    const issues = store.listIssues({ limit }), transitions = store.listTransitions({ limit: 1000 });
    privateExport(options['state-dir'], { schemaVersion: 1, audience: 'IT_REVIEW_ONLY', issues, transitions });
    return { ok: true, exportedIssues: issues.length, exportedTransitions: transitions.length, ...store.status() };
  } finally { store.close(); }
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + '\n'); }
  catch (error) { const code = /^HELP_LEARNING_[A-Z_]+$/.test(error?.code || '') ? error.code : 'HELP_LEARNING_TRIAGE_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, code }) + '\n'); process.exitCode = 1; }
}
module.exports = { run, readEvidence };
