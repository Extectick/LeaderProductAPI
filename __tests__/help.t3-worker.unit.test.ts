jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpAssistantJob: { findUnique: jest.fn() } } }));
jest.mock('../src/modules/help/help.service', () => ({ HelpError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }, helpActor: jest.fn(), helpTransaction: jest.fn(), publishHelpEvent: jest.fn() }));
jest.mock('../src/modules/help/help.t3', () => ({ prepareHelpT3Answer: jest.fn() }));
jest.mock('../src/modules/help/help.assistant-lease', () => ({ withHelpAssistantLease: jest.fn((_id, _token, work) => work(new AbortController().signal)) }));
import prisma from '../src/prisma/client';
import { helpAssistantConfiguration, processHelpAssistantJob } from '../src/modules/help/help.assistant';
import { helpTransaction, publishHelpEvent } from '../src/modules/help/help.service';
import { prepareHelpT3Answer } from '../src/modules/help/help.t3';
import { HelpT3Error } from '../src/modules/help/help.t3-exchange';
const original = { ...process.env };
const job = { id: 'job', provider: 't3', ticketId: 3, ownerId: 7, leaseToken: 'lease', leaseUntil: new Date(Date.now() + 90000), status: 'RUNNING', step: 3, messageId: 25, context: [{ text: 'QA' }], createdAt: new Date(), attempts: 1 };
let db: any;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...original, NODE_ENV: 'development', HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 't3', HELP_T3_DEV_ENABLED: 'true', HELP_T3_WEBHOOK_URL_FILE: '/unused-unit-file' };
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue(job);
  db = { helpAssistantJob: { findUnique: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn().mockResolvedValue({ ...job, step: 4 }) },
    helpTicket: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 3, status: 'OPEN', itRequested: false, members: [] }), update: jest.fn() }, helpMessage: { update: jest.fn() } };
  (helpTransaction as jest.Mock).mockImplementation((_id, work) => work(db));
  (publishHelpEvent as jest.Mock).mockResolvedValue({ id: 100 });
  (prepareHelpT3Answer as jest.Mock).mockResolvedValue({ mode: 't3', text: 'Какая ошибка?', sources: [] });
});
afterAll(() => { process.env = original; });

test('T3 reuses the existing fenced final message/event path', async () => {
  expect(helpAssistantConfiguration()).toMatchObject({ enabled: true, provider: 't3' });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(true);
  expect(prepareHelpT3Answer).toHaveBeenCalledWith({ id: 'job', ticketId: 3, ownerId: 7, leaseToken: 'lease' }, job.context, expect.any(AbortSignal));
  expect(db.helpMessage.update).toHaveBeenCalledWith({ where: { id: 25 }, data: { text: 'Какая ошибка?', kind: 'TEXT' } });
  expect(publishHelpEvent).toHaveBeenCalledWith(db, 3, null, 'MESSAGE_CREATED', 25);
});
test.each(['SUPERSEDED', 'STOPPED', 'COMPLETED'])('late T3 response does not publish after %s', async status => {
  db.helpAssistantJob.findUnique.mockResolvedValue({ ...job, status, leaseToken: null });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalled(); expect(publishHelpEvent).not.toHaveBeenCalled();
});
test('another worker lease fences the old response', async () => {
  db.helpAssistantJob.findUnique.mockResolvedValue({ ...job, leaseToken: 'new-lease' });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalled();
});
test.each(['model_handoff', 'user_requested', 'no_knowledge', 'source_unavailable'])('AI %s only offers IT and never queues or notifies specialists', async handoffReason => {
  (prepareHelpT3Answer as jest.Mock).mockResolvedValue({ mode: 't3', text: 'Можно вызвать специалиста.', sources: [], handoffReason });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(true);
  expect(db.helpTicket.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { updatedAt: expect.any(Date) } });
  expect(publishHelpEvent).not.toHaveBeenCalledWith(db, 3, 7, 'IT_REQUESTED');
  expect(db.helpMessage.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assistantState: expect.objectContaining({ action: { type: 'request_it' }, handoffReason }) } }));
});
test.each(['bunny', 'simulator', 'openai'])('switch to T3 blocks an already queued %s response', async provider => {
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue({ ...job, provider });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(prepareHelpT3Answer).not.toHaveBeenCalled();
  expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR', errorCode: 'HELP_AI_PROVIDER_UNAVAILABLE' }) }));
});
test('rollback to Bunny prevents a queued T3 request from dispatching', async () => {
  process.env.HELP_AI_PROVIDER = 'bunny';
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(prepareHelpT3Answer).not.toHaveBeenCalled(); expect(db.helpMessage.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'TEXT' }) }));
});
test('rollback while model is running prevents publication', async () => {
  (prepareHelpT3Answer as jest.Mock).mockImplementation(async () => {
    process.env.HELP_AI_PROVIDER = 'bunny'; return { mode: 't3', text: 'Late answer', sources: [] };
  });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalled();
});
test('disabling opt-in while model is running prevents publication', async () => {
  (prepareHelpT3Answer as jest.Mock).mockImplementation(async () => {
    process.env.HELP_T3_DEV_ENABLED = 'false'; return { mode: 't3', text: 'Late answer', sources: [] };
  });
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpMessage.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'TEXT' }) }));
});
test.each([[1, true, 'QUEUED'], [2, true, 'ERROR'], [1, false, 'ERROR']])('attempt %s retryable %s produces %s', async (attempts, retryable, status) => {
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockResolvedValue({ ...job, attempts });
  db.helpAssistantJob.findUnique.mockResolvedValue({ ...job, attempts });
  (prepareHelpT3Answer as jest.Mock).mockRejectedValue(new HelpT3Error('HELP_T3_TIMEOUT', retryable as boolean));
  await expect(processHelpAssistantJob('job', 'lease')).resolves.toBe(false);
  expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status, errorCode: 'HELP_T3_TIMEOUT' }) }));
});
