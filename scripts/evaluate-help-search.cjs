// Requires a dedicated empty test DB and compiled dist. Never loads .env or sends messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
assert.equal(process.env.KNOWLEDGE_EVAL_CONFIRM, 'isolated');
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/LeaderAPI_help_openai_test');
const { default: prisma, pool } = require('../dist/prisma/client');
const { knowledgeConfig } = require('../dist/modules/knowledge/knowledge.config');
const { searchKnowledge } = require('../dist/modules/knowledge/knowledge.service');
const knowledge = require('../dist/modules/help/help.knowledge');
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/knowledge-quality.corpus.json'), 'utf8'));
const suite = JSON.parse(fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/knowledge-quality.questions.json'), 'utf8'));
async function main() {
  const config = knowledgeConfig(); assert.equal(config.key, 'search-quality-isolated');
  assert.equal(await prisma.knowledgeSource.count(), 0, 'Use an empty isolated test database');
  const source = await prisma.knowledgeSource.create({ data: { key: config.key, name: 'Synthetic search QA', configFingerprint: config.fingerprint, lastSuccessAt: new Date() } });
  const ids = new Map(); const forbidden = new Set();
  for (const item of corpus.documents) {
    const id = randomUUID(); ids.set(id, item.key);
    if (item.section || item.restricted || item.revoked || item.deleted || item.outdated) forbidden.add(item.key);
    await prisma.knowledgeDocument.create({ data: { id, sourceId: source.id, remoteId: item.key, path: `Материалы компании/${item.title}.md`, title: item.title,
      section: item.section || 'COMPANY', etag: 'qa', size: 0, mimeType: 'text/plain', seenScanId: 'qa',
      currentRevision: item.outdated ? 2 : 1, publishedRevision: item.revoked || item.section || item.deleted || item.outdated ? null : 1,
      allEmployees: !item.restricted, deletedAt: item.deleted ? new Date() : null,
      versions: { create: { revision: 1, etag: 'qa', path: item.title, status: 'READY', text: item.text,
        chunks: { create: { ordinal: 0, text: item.title + '\n' + item.text } } } } } });
  }
  const actor = { userId: -1, canManage: false, departmentIds: [] };
  const baseline = process.argv.includes('--baseline'); const cases = [];
  for (const test of suite.cases) {
    const start = performance.now(); const context = [{ text: test.question }];
    let hits;
    if (baseline || !knowledge.searchHelpKnowledge) {
      const query = knowledge.helpKnowledgeQuery(context);
      hits = query ? knowledge.selectHelpKnowledge(await searchKnowledge(query, actor, 20, true)) : [];
    } else hits = await knowledge.searchHelpKnowledge(context, actor);
    const returned = [...new Set(hits.map(hit => ids.get(hit.documentId)))];
    const rank = returned.findIndex(key => test.expected.includes(key)) + 1;
    cases.push({ id: test.id, tag: test.tag, expected: test.expected, returned, rank,
      passed: test.expected.length ? rank > 0 && rank <= 3 : returned.length === 0,
      forbiddenLeaks: returned.filter(key => forbidden.has(key)).length, ms: Math.round((performance.now() - start) * 100) / 100 });
  }
  const positive = cases.filter(item => item.expected.length); const negative = cases.filter(item => !item.expected.length);
  const metrics = { recallAt3: positive.filter(item => item.passed).length / positive.length,
    mrr: positive.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / positive.length,
    noAnswerAccuracy: negative.filter(item => item.passed).length / negative.length,
    forbiddenLeaks: cases.reduce((sum, item) => sum + item.forbiddenLeaks, 0) };
  const passed = metrics.recallAt3 >= suite.thresholds.recallAt3 && metrics.mrr >= suite.thresholds.mrr &&
    metrics.noAnswerAccuracy >= suite.thresholds.noAnswerAccuracy && metrics.forbiddenLeaks === suite.thresholds.forbiddenLeaks;
  const report = { corpusVersion: corpus.version, suiteVersion: suite.version, mode: baseline ? 'legacy-baseline' : 'current',
    createdAt: new Date().toISOString(), syntheticOnly: true, metrics, thresholds: suite.thresholds, passed, cases };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex >= 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (!baseline) assert(passed, 'Search quality gates failed; see report');
}
main().catch(error => { console.error({ code: error.code || '', message: error.message }); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
