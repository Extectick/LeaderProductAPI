jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpAssistantJob: { findUnique: jest.fn() } } }));
jest.mock('../src/modules/help/help.service', () => ({ HelpError: class extends Error {}, helpActor: jest.fn(), helpTransaction: jest.fn(), publishHelpEvent: jest.fn() }));
jest.mock('../src/modules/help/help.openai-answer', () => ({ prepareHelpOpenAIAnswer: jest.fn() }));
jest.mock('../src/modules/help/help.knowledge',()=>({validateHelpKnowledgeSources:jest.fn()}));
jest.mock('../src/modules/help/help.assistant-lease', () => ({ withHelpAssistantLease: jest.fn((_id, _token, work) => work(new AbortController().signal)) }));
import prisma from '../src/prisma/client';
import { processHelpAssistantJob } from '../src/modules/help/help.assistant';
import { helpTransaction, publishHelpEvent } from '../src/modules/help/help.service';
import { prepareHelpOpenAIAnswer } from '../src/modules/help/help.openai-answer';
import { HelpOpenAIError } from '../src/modules/help/help.openai';
const original = { ...process.env };
const job = { id: 'job', provider: 'openai', ticketId: 3, ownerId: 7, leaseToken: 'lease', leaseUntil: new Date(Date.now() + 90000), status: 'RUNNING', step: 3, messageId: 25, context: [], createdAt: new Date(), attempts: 1 };
let db: any;
beforeEach(() => {
  jest.clearAllMocks(); process.env = { ...original, HELP_AI_PROVIDER: 'openai', HELP_OPENAI_MAX_ATTEMPTS: '2' };
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue(job);
  db = { helpAssistantJob: { findUnique: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn().mockResolvedValue(job) }, helpMessage: { findUnique: jest.fn().mockResolvedValue({ assistantState: { activityVersion: 1, activities: [] } }), update: jest.fn() } };
  (helpTransaction as jest.Mock).mockImplementation((_id, fn) => fn(db));
  (publishHelpEvent as jest.Mock).mockResolvedValue({ id: 100 });
});
afterAll(() => { process.env = original; });

test.each([1, 2])('malformed output is retried up to the configured bound (attempt %s)', async attempts => {
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue({ ...job, attempts });
  db.helpAssistantJob.findUnique.mockResolvedValue({ ...job, attempts });
  const diagnostic = { stage: 'answer_schema' as const, issues: [{ path: 'decision', code: 'invalid_value' }] };
  (prepareHelpOpenAIAnswer as jest.Mock).mockRejectedValue(new HelpOpenAIError('HELP_OPENAI_INVALID_RESPONSE', true, 1000, diagnostic));
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: attempts === 1 ? 'QUEUED' : 'ERROR', completedAt: attempts === 1 ? null : expect.any(Date) }) }));
  const update = db.helpMessage.update.mock.calls.at(-1)[0].data.assistantState;
  expect(update).toMatchObject({ errorDiagnostic: diagnostic, draftText: '', phase: attempts === 1 ? 'retrying' : 'error' });
  expect(update.error).toContain(attempts === 1 ? 'Повторяем запрос' : 'после повторных попыток');
  expect(db.helpMessage.update.mock.calls.some(([x]: any) => x.data.kind === 'TEXT')).toBe(false);
});

test('invalid citations never enter the retry or final answer path', async () => {
  (prepareHelpOpenAIAnswer as jest.Mock).mockRejectedValue(new HelpOpenAIError('HELP_OPENAI_INVALID_CITATIONS'));
  await processHelpAssistantJob('job', 'lease');
  expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR' }) }));
  expect(db.helpMessage.update.mock.calls.at(-1)[0].data.assistantState.error).toContain('источники');
  expect(db.helpMessage.update.mock.calls.some(([x]: any) => x.data.kind === 'TEXT')).toBe(false);
});
test('revoked application statistics permission prevents final publication inside the job transaction',async()=>{
 const validateAppAccess=jest.fn().mockRejectedValue(Object.assign(new Error('HELP_APP_STATS_FORBIDDEN'),{code:'HELP_APP_STATS_FORBIDDEN'}));
 db.helpTicket={findUniqueOrThrow:jest.fn().mockResolvedValue({id:3,ownerId:7,status:'OPEN',itRequested:false,members:[]})};
 (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({text:'Всего 102',sources:[],mode:'openai',validateAppAccess});
 await expect(processHelpAssistantJob('job','lease')).resolves.toBe(false);
 expect(validateAppAccess).toHaveBeenCalledWith(db);
 expect(db.helpMessage.update.mock.calls.some(([x]:any)=>x.data.kind==='TEXT')).toBe(false);
 expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'ERROR',errorCode:'HELP_APP_STATS_FORBIDDEN'})}));
});
