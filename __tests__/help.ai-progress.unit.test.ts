jest.mock('../src/modules/help/help.service', () => ({ helpTransaction: jest.fn(), publishHelpEvent: jest.fn() }));
jest.mock('../src/modules/help/help.knowledge',()=>({validateHelpKnowledgeSources:jest.fn()}));
jest.mock('../src/modules/onec-personal/service',()=>({validateOnecProofs:jest.fn()}));
import { helpTransaction, publishHelpEvent } from '../src/modules/help/help.service';
import { createHelpAIProgress, helpAIErrorMessage } from '../src/modules/help/help.ai-progress';
import {validateHelpKnowledgeSources} from '../src/modules/help/help.knowledge';
import {validateOnecProofs} from '../src/modules/onec-personal/service';
import {withHelpPerformance,helpPerformanceSnapshot} from '../src/modules/help/help.performance';
const original = { ...process.env };
const db = { $executeRaw:jest.fn(), helpAssistantJob: { findFirst: jest.fn() }, helpMessage: { findUniqueOrThrow: jest.fn(), update: jest.fn() } };
const job = { id: 'run', ticketId: 3, messageId: 9, leaseToken: 'token' };
beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(1000); jest.clearAllMocks(); process.env.HELP_AI_PROVIDER = 'openai';
  (helpTransaction as jest.Mock).mockImplementation((_ticket, fn) => fn(db));
  (publishHelpEvent as jest.Mock).mockResolvedValue({ id: 18 });
  db.helpAssistantJob.findFirst.mockResolvedValue(job);
  db.helpMessage.findUniqueOrThrow.mockResolvedValue({ assistantState: { runId: 'run', eventId: 1 } });
});
afterEach(() => { jest.useRealTimers(); process.env = { ...original }; });
test('coalesces updates while preserving text, lifecycle and final draft in one snapshot', async () => {
  const report = createHelpAIProgress(job, new AbortController().signal);
  await report({ activity: { id: 'a', kind: 'analysis', label: 'Анализ', status: 'running', text: 'Начало' } });
  await report({ activity: { id: 'a', kind: 'analysis', label: 'Анализ', status: 'running', text: 'Начало пояснения' }, draftText: 'Ответ' });
  expect(db.helpMessage.update).toHaveBeenCalledTimes(1);
  await report({ activity: { id: 'a', kind: 'analysis', label: 'Анализ', status: 'completed' }, flush: true });
  const state = db.helpMessage.update.mock.calls[1][0].data.assistantState;
  expect(state).toMatchObject({ runId: 'run', eventId: 18, draftText: 'Ответ', status: 'streaming', activities: [{ id: 'a', text: 'Начало пояснения', status: 'completed' }] });
  expect(db.helpAssistantJob.findFirst.mock.calls[0][0].where).toMatchObject({ leaseToken: 'token', status: 'RUNNING', ticket: { status: 'OPEN', itRequested: false, members: { none: { role: 'IT' } } } });
});
test('draft timing distinguishes production from an accepted fenced write',async()=>{
 await withHelpPerformance({...job,createdAt:new Date(0),nextAt:new Date(0),attempts:1},async()=>{
  const report=createHelpAIProgress(job,new AbortController().signal);
  await report({phase:'analysis',flush:true});
  await report({draftText:'buffered'});
  expect(helpPerformanceSnapshot(job.id)).toHaveProperty('firstDraftProducedMs');
  expect(helpPerformanceSnapshot(job.id)).not.toHaveProperty('firstDraftPersistedMs');
  db.helpAssistantJob.findFirst.mockResolvedValueOnce(null);
  await expect(report({flush:true})).rejects.toThrow('CANCELLED');
  expect(helpPerformanceSnapshot(job.id)).not.toHaveProperty('firstDraftPersistedMs');
  await report({flush:true});
  expect(helpPerformanceSnapshot(job.id)).toHaveProperty('firstDraftPersistedMs');
 });
});
test('a cancelled, superseded, expired or IT-owned job cannot publish late chunks', async () => {
  const report = createHelpAIProgress(job, new AbortController().signal);
  db.helpAssistantJob.findFirst.mockResolvedValue(null);
  await expect(report({ draftText: 'late', flush: true })).rejects.toThrow('CANCELLED');
  expect(db.helpMessage.update).not.toHaveBeenCalled(); expect(publishHelpEvent).not.toHaveBeenCalled();
});
test('abort and provider changes fence progress independently of heartbeat timing', async () => {
  const controller = new AbortController(), report = createHelpAIProgress(job, controller.signal);
  controller.abort(); await expect(report({ flush: true })).rejects.toThrow('CANCELLED');
  process.env.HELP_AI_PROVIDER = 't3';
  await expect(createHelpAIProgress(job, new AbortController().signal)({ flush: true })).rejects.toThrow('CANCELLED');
  expect(db.helpMessage.update).not.toHaveBeenCalled();
});
test('revoked knowledge is rechecked inside the progress transaction before any draft is disclosed',async()=>{
  const source={documentId:'d',versionId:'v',revision:1,title:'Instruction',path:'Company',sourceUrl:'/knowledge/d'};
  (validateHelpKnowledgeSources as jest.Mock).mockRejectedValueOnce(Error('HELP_KNOWLEDGE_CHANGED'));
  const report=createHelpAIProgress(job,new AbortController().signal);
  await expect(report({validationSources:[source],draftText:'private draft',flush:true})).rejects.toThrow('HELP_KNOWLEDGE_CHANGED');
  expect(publishHelpEvent).not.toHaveBeenCalled();expect(db.helpMessage.update).not.toHaveBeenCalled();
});
test('revoked personal 1C access fences streaming under the same lock as final publication',async()=>{
  const proofs=[{baseKey:'fixture',revision:2,binding:'fixture-binding'}];
  (validateOnecProofs as jest.Mock).mockRejectedValueOnce(Error('ONEC_AUTH_REQUIRED'));
  const report=createHelpAIProgress(job,new AbortController().signal);
  await expect(report({validationProofs:proofs,draftText:'personal data',flush:true})).rejects.toThrow('ONEC_AUTH_REQUIRED');
  expect(db.$executeRaw).toHaveBeenCalled();expect(publishHelpEvent).not.toHaveBeenCalled();
});
test('revoked application statistics access fences every persisted chunk inside its transaction',async()=>{
 const validate=jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('HELP_APP_STATS_FORBIDDEN'));
 const report=createHelpAIProgress(job,new AbortController().signal);
 await report({validateAppAccess:validate,draftText:'Проверяю статистику',flush:true});
 expect(validate).toHaveBeenCalledWith(db);jest.clearAllMocks();
 await expect(report({draftText:'Всего 102',flush:true})).rejects.toThrow('HELP_APP_STATS_FORBIDDEN');
 expect(publishHelpEvent).not.toHaveBeenCalled();expect(db.helpMessage.update).not.toHaveBeenCalled();
});

test('format failures, unverified sources and rate limits give distinct actionable messages', () => {
  expect(helpAIErrorMessage('HELP_OPENAI_INVALID_RESPONSE', true)).toContain('Повторяем запрос');
  expect(helpAIErrorMessage('HELP_OPENAI_INVALID_RESPONSE')).toContain('после повторных попыток');
  expect(helpAIErrorMessage('HELP_OPENAI_INVALID_CITATIONS')).toContain('источники');
  expect(helpAIErrorMessage('HELP_OPENAI_HTTP_429', true)).toContain('автоматически');
  expect(helpAIErrorMessage('HELP_OPENAI_HTTP_401')).toContain('администратором');
  expect(helpAIErrorMessage('HELP_OPENAI_NETWORK')).toContain('временно недоступен');
});
