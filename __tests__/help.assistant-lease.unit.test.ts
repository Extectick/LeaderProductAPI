jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpAssistantJob: { updateMany: jest.fn() } } }));
import prisma from '../src/prisma/client';
import { withHelpAssistantLease } from '../src/modules/help/help.assistant-lease';
const update = prisma.helpAssistantJob.updateMany as jest.Mock;
beforeEach(() => { jest.useFakeTimers(); update.mockReset(); });
afterEach(() => jest.useRealTimers());
test('renews only a live owned lease and stops timers after completion', async () => {
  update.mockResolvedValue({ count: 1 });
  await expect(withHelpAssistantLease('job', 'token', async signal => { expect(signal.aborted).toBe(false); return 7; })).resolves.toBe(7);
  expect(update.mock.calls[0][0].where).toMatchObject({ id: 'job', leaseToken: 'token', status: 'RUNNING', ticket: { status: 'OPEN', itRequested: false } });
  expect(jest.getTimerCount()).toBe(0);
});
test.each([0, -1])('lost lease or database failure aborts in-flight provider work (%s)', async mode => {
  update.mockResolvedValueOnce({ count: 1 });
  if (mode === 0) update.mockResolvedValue({ count: 0 }); else update.mockRejectedValue(Error('db unavailable'));
  const result = withHelpAssistantLease('job', 'token', signal => new Promise(resolve => signal.addEventListener('abort', () => resolve('cancelled'))));
  await jest.advanceTimersByTimeAsync(2100);
  await expect(result).resolves.toBe('cancelled'); expect(jest.getTimerCount()).toBe(0);
});
