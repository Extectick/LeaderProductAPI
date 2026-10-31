// Actual Help transactions and PostgreSQL; mock only the external OpenAI HTTP boundary.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
assert.equal(process.env.KNOWLEDGE_EVAL_CONFIRM, 'isolated');
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/LeaderAPI_help_openai_test');
const fromBuild = file => require(require('node:path').resolve('dist', file));
const { default: prisma, pool } = fromBuild('prisma/client');
const { knowledgeConfig } = fromBuild('modules/knowledge/knowledge.config');
const help = fromBuild('modules/help/help.service');
const ai = fromBuild('modules/help/help.assistant');
let requests = 0;
let respond = async () => { throw Error('Unexpected HTTP request'); };
global.fetch = async (url, options) => { assert.equal(url, 'https://api.openai.com/v1/responses'); requests++; return respond(options); };
const response = (decision = 'answer', source_ids = ['S1']) => new Response(JSON.stringify({ id: 'resp_isolated', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ decision, message: 'Проверьте бумагу в принтере.', source_ids }) }] }],
  usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 } }));
async function main() {
  Object.assign(process.env, { HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture-model', OPENAI_API_KEY: 'fixture-key' });
  delete process.env.OPENAI_API_KEY_FILE;
  const config = knowledgeConfig();
  const source = await prisma.knowledgeSource.create({ data: { key: config.key, name: 'Isolated', configFingerprint: config.fingerprint, lastSuccessAt: new Date() } });
  const document = await prisma.knowledgeDocument.create({ data: { sourceId: source.id, remoteId: 'printer', path: 'Материалы компании/Принтер.md', title: 'Принтер Кронос', section: 'COMPANY', etag: 'v1', size: 100, mimeType: 'text/plain', seenScanId: 'qa', currentRevision: 1, publishedRevision: 1, allEmployees: true,
    versions: { create: { revision: 1, etag: 'v1', path: 'Материалы компании/Принтер.md', status: 'READY', text: 'Принтер Кронос не печатает. Проверьте бумагу.', chunks: { create: { ordinal: 0, text: 'Принтер Кронос не печатает. Проверьте бумагу.' } } } } } });
  const role = await prisma.role.create({ data: { name: 'admin' } });
  await prisma.service.create({ data: { key: 'help', name: 'Помощь', defaultVisible: true, defaultEnabled: true } });
  const owner = await prisma.user.create({ data: { roleId: role.id, firstName: 'Isolated', isActive: true, profileStatus: 'ACTIVE', currentProfileType: 'EMPLOYEE' } });
  const actor = await help.helpActor(owner.id);
  const create = async (text = 'Принтер Кронос не печатает') => {
    const ticketId = await help.createHelpTicket(actor, { text, clientMessageId: randomUUID(), clientTicketId: randomUUID() });
    const job = await prisma.helpAssistantJob.findFirstOrThrow({ where: { ticketId } });
    await prisma.helpAssistantJob.update({ where: { id: job.id }, data: { step: 3, nextAt: new Date(0) } }); return job;
  };
  const execute = async (job, shutdown) => {
    await prisma.helpAssistantJob.update({ where: { id: job.id }, data: { nextAt: new Date(0) } });
    const lease = await ai.claimHelpAssistantJob(); assert.equal(lease.id, job.id);
    return ai.processHelpAssistantJob(job.id, lease.leaseToken, undefined, shutdown);
  };
  const get = job => prisma.helpAssistantJob.findUniqueOrThrow({ where: { id: job.id } });
  const message = job => prisma.helpMessage.findUniqueOrThrow({ where: { id: job.messageId } });
  respond = async options => {
    const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.tools, undefined);
    assert(JSON.parse(body.input[0].content).sources[0].excerpt.includes('Кронос')); return response();
  };
  const success = await create(); assert(await execute(success));
  assert.equal((await get(success)).status, 'COMPLETED');
  const final = await message(success);
  assert.equal(final.assistantState.answerMode, 'openai'); assert.equal(final.assistantState.sources[0].documentId, document.id);
  assert.equal(final.assistantState.generation.usage.totalTokens, 168);
  assert.equal(await prisma.helpEvent.count({ where: { messageId: success.messageId, type: 'MESSAGE_CREATED' } }), 1);
  assert(await prisma.helpNotification.count({ where: { messageId: success.messageId } }) > 0);

  const beforeMissing = requests; const missing = await create('Телепортация космического корабля'); assert(await execute(missing));
  assert.equal(requests, beforeMissing); assert.equal((await message(missing)).assistantState.handoffReason, 'no_knowledge');

  const retry = await create(); respond = async () => new Response('{}', { status: 429, headers: { 'retry-after': '17' } });
  const start = Date.now(); assert.equal(await execute(retry), false); let retried = await get(retry);
  assert.equal(retried.status, 'QUEUED'); assert(retried.nextAt.getTime() >= start + 17000);
  respond = async () => response(); assert(await execute(retry));
  assert.equal(await prisma.helpEvent.count({ where: { messageId: retry.messageId, type: 'MESSAGE_CREATED' } }), 1);

  const capped = await create(); respond = async () => new Response('{}', { status: 503 });
  for (let i = 0; i < 3; i++) assert.equal(await execute(capped), false);
  assert.equal((await get(capped)).status, 'ERROR');
  const invalid = await create(); respond = async () => response('answer', ['S99']); assert.equal(await execute(invalid), false);
  assert.equal((await get(invalid)).status, 'ERROR'); assert.equal((await message(invalid)).kind, 'ASSISTANT_PROGRESS');

  const noKey = await create(); const beforeKey = requests; delete process.env.OPENAI_API_KEY;
  assert.equal(await execute(noKey), false); assert.equal(requests, beforeKey); assert.equal((await get(noKey)).errorCode, 'HELP_OPENAI_NOT_CONFIGURED');
  process.env.OPENAI_API_KEY = 'fixture-key';

  const clarify = await create(); respond = async () => response('clarify', []); assert(await execute(clarify));
  assert.equal((await message(clarify)).assistantState.generation.decision, 'clarify');
  assert.equal((await prisma.helpTicket.findUniqueOrThrow({ where: { id: clarify.ticketId } })).itRequested, false);
  const handoff = await create(); respond = async () => response('handoff', []); assert(await execute(handoff));
  assert.equal((await message(handoff)).assistantState.handoffReason, 'model_handoff');
  assert.equal(await prisma.helpEvent.count({ where: { ticketId: handoff.ticketId, type: 'IT_REQUESTED' } }), 1);

  // A real correction writes SUPERSEDED; the heartbeat must abort the already-running HTTP call.
  const correction = await create(); let seenAbort = false;
  respond = options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { seenAbort = true; reject(Error('aborted')); }, { once: true });
    help.sendHelpMessage(correction.ticketId, actor, { text: 'Уточнение: бумага застряла в принтере Кронос', clientMessageId: randomUUID() }).catch(reject);
  });
  assert.equal(await execute(correction), false); assert(seenAbort); assert.equal((await get(correction)).status, 'SUPERSEDED');
  assert.equal(await prisma.helpEvent.count({ where: { messageId: correction.messageId, type: 'MESSAGE_CREATED' } }), 0);
  await help.helpTransaction(correction.ticketId, tx => ai.cancelHelpAssistant(tx, correction.ticketId));

  const stopping = await create(); const shutdown = new AbortController();
  respond = options => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('shutdown')), { once: true }); shutdown.abort();
  });
  assert.equal(await execute(stopping, shutdown.signal), false); assert.equal((await get(stopping)).status, 'QUEUED');
  respond = async () => response(); assert(await execute(stopping)); assert.equal((await get(stopping)).status, 'COMPLETED');

  // Even an un-cited clarification is revalidated against every source disclosed to the model.
  const changed = await create();
  respond = async () => { await prisma.knowledgeDocument.update({ where: { id: document.id }, data: { publishedRevision: null } }); return response('clarify', []); };
  assert.equal(await execute(changed), false); assert.equal((await get(changed)).errorCode, 'HELP_KNOWLEDGE_CHANGED');
  assert.equal(await prisma.helpEvent.count({ where: { messageId: changed.messageId, type: 'MESSAGE_CREATED' } }), 0);
  console.log(JSON.stringify({ mockedOpenAIOnly: true, paidRequests: 0, completedWithSources: true, eventOutboxOnce: true,
    noKnowledgeNoRequest: true, retryAfterHonored: true, attemptsCapped: true, invalidCitationRejected: true,
    keyMissingNoRequest: true, clarifyWithoutHandoff: true, modelHandoff: true, correctionAbortsHTTP: true, shutdownResumes: true, allSourcesRevalidated: true }));
}
main().catch(error => { console.error({ code: error.code || '', message: error.message, stack: error.stack }); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
