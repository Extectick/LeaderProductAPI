jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn() } }));
import { performance } from 'node:perf_hooks';
import { withHelpPerformance, timeHelpStage, helpPerformanceSnapshot, markHelpFirstDraft } from '../src/modules/help/help.performance';
const clock = performance.now as jest.Mock;
const job = { id: 'a', createdAt: new Date(1000), nextAt: new Date(9000), attempts: 2 };
beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(10000); clock.mockReturnValue(100); });
afterEach(() => jest.restoreAllMocks());
test('separates accumulated job age from ready delay and current attempt', async () => {
  await withHelpPerformance(job, async () => {
    clock.mockReturnValue(150); markHelpFirstDraft();
    clock.mockReturnValue(170); markHelpFirstDraft();
    expect(helpPerformanceSnapshot('a')).toMatchObject({ version: 1, attempt: 2, jobAgeAtStartMs: 9000,
      readyDelayMs: 1000, attemptElapsedMs: 70, jobElapsedMs: 9070, firstDraftProducedMs: 50 });
    expect(helpPerformanceSnapshot('another-job')).toBeUndefined();
  });
  expect(helpPerformanceSnapshot('a')).toBeUndefined();
});
test('thrownErrors stages preserve the original error and snapshots cannot mutate accumulated samples', async () => {
  await withHelpPerformance(job, async () => {
    const error = new Error('private tool payload');
    await expect(timeHelpStage('onec', async () => { clock.mockReturnValue(180); throw error; })).rejects.toBe(error);
    const snapshot = helpPerformanceSnapshot('a')!;
    expect(snapshot.stages.onec).toEqual({ calls: 1, thrownErrors: 1, totalMs: 80, maxMs: 80 });
    snapshot.stages.onec!.calls = 100;
    await timeHelpStage('onec', async () => { clock.mockReturnValue(200); });
    expect(helpPerformanceSnapshot('a')!.stages.onec).toEqual({ calls: 2, thrownErrors: 1, totalMs: 100, maxMs: 80 });
    expect(JSON.stringify(helpPerformanceSnapshot('a'))).not.toContain('private');
  });
});
test('concurrent worker slots keep metrics separate and absence of telemetry never changes results', async () => {
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const first = withHelpPerformance(job, async () => { await paused; await timeHelpStage('history', async () => 1);
    expect(helpPerformanceSnapshot('a')!.stages).toHaveProperty('history');
    expect(helpPerformanceSnapshot('a')!.stages).not.toHaveProperty('model'); });
  await withHelpPerformance({ ...job, id: 'b' }, async () => {
    await timeHelpStage('model', async () => 2);
    expect(helpPerformanceSnapshot('b')!.stages).not.toHaveProperty('history');
    resume();
  });
  await first;
  expect(await timeHelpStage('model', async () => 'answer')).toBe('answer');
});
test('backwards wall clock cannot create negative durations; an unstreamed answer has no first draft', async () => {
  await withHelpPerformance({ ...job, createdAt: new Date(11000), nextAt: new Date(12000) }, async () => {
    clock.mockReturnValue(140);
    (Date.now as jest.Mock).mockReturnValue(100);
    expect(helpPerformanceSnapshot('a')).toMatchObject({ jobAgeAtStartMs: 0, readyDelayMs: 0, attemptElapsedMs: 40 });
    expect(helpPerformanceSnapshot('a')).not.toHaveProperty('firstDraftProducedMs');
  });
});
