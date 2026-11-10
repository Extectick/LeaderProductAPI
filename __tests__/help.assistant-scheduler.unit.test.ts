jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  $queryRaw: jest.fn(), helpAssistantJob: { findUnique: jest.fn() },
} }));
jest.mock('../src/modules/help/help.service', () => ({
  HelpError: class extends Error {}, helpActor: jest.fn(), helpTransaction: jest.fn(), publishHelpEvent: jest.fn(),
}));
jest.mock('../src/modules/help/help.openai-answer', () => ({ prepareHelpOpenAIAnswer: jest.fn() }));
jest.mock('../src/modules/help/help.assistant-lease', () => ({
  withHelpAssistantLease: jest.fn((_id, _token, work, shutdown) => work(shutdown)),
}));
import prisma from '../src/prisma/client';
import { helpTransaction } from '../src/modules/help/help.service';
import { prepareHelpOpenAIAnswer } from '../src/modules/help/help.openai-answer';
import { startHelpAssistantWorker } from '../src/modules/help/help.assistant';

const original = { ...process.env };
const claim = prisma.$queryRaw as jest.Mock;
const prepare = prepareHelpOpenAIAnswer as jest.Mock;
const answer = { text: 'Fixture answer', sources: [], mode: 'openai' };
let finish: Array<(value: any) => void>, stop: (() => Promise<void>) | undefined;

beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); finish = []; stop = undefined;
  process.env = { ...original, NODE_ENV: 'test', HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 'openai',
    KNOWLEDGE_ENABLED: 'true', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture', OPENAI_API_KEY: 'fixture' };
  delete process.env.HELP_AI_WORKER_CONCURRENCY;
  (helpTransaction as jest.Mock).mockResolvedValue(false);
});
afterEach(async () => {
  const stopping = stop?.();
  finish.forEach(resolve => resolve(answer));
  await stopping;
  jest.useRealTimers(); process.env = { ...original };
});

function queueJobs(count = 3) {
  const jobs = new Map<string, unknown>(); let next = 0;
  claim.mockImplementation(async (_sql, leaseToken) => {
    if (next >= count) return [];
    const ticketId = ++next, id = `job-${ticketId}`;
    jobs.set(id, { id, ticketId, ownerId: ticketId, leaseToken, status: 'RUNNING', provider: 'openai',
      step: 0, messageId: ticketId, context: [], createdAt: new Date(), attempts: 1 });
    return [{ id }];
  });
  (prisma.helpAssistantJob.findUnique as jest.Mock).mockImplementation(async ({ where }) => jobs.get(where.id));
  prepare.mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
}

test('configured concurrency two holds the third job until a slot completes and the next poll arrives', async () => {
  process.env.HELP_AI_WORKER_CONCURRENCY = '2';
  queueJobs(); stop = startHelpAssistantWorker();
  await jest.advanceTimersByTimeAsync(250);
  expect(prepare).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1000);
  expect(claim).toHaveBeenCalledTimes(2);
  finish[0](answer); await jest.advanceTimersByTimeAsync(0);
  expect(prepare).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(250);
  expect(prepare).toHaveBeenCalledTimes(3);
});

test('shutdown aborts both provider signals and drains every active job before returning', async () => {
  process.env.HELP_AI_WORKER_CONCURRENCY = '2';
  queueJobs(); stop = startHelpAssistantWorker();
  await jest.advanceTimersByTimeAsync(250);
  const signals = prepare.mock.calls.map(call => call[3] as AbortSignal);
  expect(signals).toHaveLength(2);
  let drained = false; const stopping = stop().then(() => { drained = true; });
  expect(signals.every(signal => signal.aborted)).toBe(true);
  finish[0](answer); await jest.advanceTimersByTimeAsync(0);
  expect(drained).toBe(false);
  finish[1](answer); await stopping;
  expect(drained).toBe(true);
  await jest.advanceTimersByTimeAsync(2000);
  expect(claim).toHaveBeenCalledTimes(2); expect(jest.getTimerCount()).toBe(0);
});

test('concurrency one preserves serial processing', async () => {
  process.env.HELP_AI_WORKER_CONCURRENCY = '1';
  queueJobs(); stop = startHelpAssistantWorker();
  await jest.advanceTimersByTimeAsync(1000);
  expect(prepare).toHaveBeenCalledTimes(1); expect(claim).toHaveBeenCalledTimes(1);
  finish[0](answer); await jest.advanceTimersByTimeAsync(250);
  expect(prepare).toHaveBeenCalledTimes(2);
});

test.each(['1', '2', '3', '4', undefined, '', '0', '5', '-1', '1.5', '2.0', '02', '2e0', ' 4 ', 'NaN', 'Infinity'])
('pending claims count toward the strict concurrency bound (%s)', async value => {
  if (value === undefined) delete process.env.HELP_AI_WORKER_CONCURRENCY;
  else process.env.HELP_AI_WORKER_CONCURRENCY = value;
  claim.mockImplementation(() => new Promise(resolve => { finish.push(() => resolve([])); }));
  stop = startHelpAssistantWorker();
  await jest.advanceTimersByTimeAsync(1250);
  const expected = value && /^[1-4]$/.test(value) ? Number(value) : 1;
  expect(claim).toHaveBeenCalledTimes(expected);
});

test('an empty queue keeps one claim per 250 ms regardless of available slots', async () => {
  process.env.HELP_AI_WORKER_CONCURRENCY = '4'; claim.mockResolvedValue([]);
  stop = startHelpAssistantWorker();
  await jest.advanceTimersByTimeAsync(999);
  expect(claim).toHaveBeenCalledTimes(4);
  await jest.advanceTimersByTimeAsync(1000);
  expect(claim).toHaveBeenCalledTimes(8); expect(prepare).not.toHaveBeenCalled();
});
