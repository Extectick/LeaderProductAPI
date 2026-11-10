import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type HelpTimingStage = 'knowledge' | 'model' | 'compaction' | 'onec' | 'application' | 'history' | 'file' | 'upload';
type Stage = { calls: number; thrownErrors: number; totalMs: number; maxMs: number };
type Job = { id: string; createdAt: Date; nextAt: Date; attempts: number };
type Timing = { id: string; origin: number; wall: number; age: number; delay: number; attempt: number;
  stages: Partial<Record<HelpTimingStage, Stage>>; firstDraftProducedMs?: number; firstDraftPersistedMs?: number };
const storage = new AsyncLocalStorage<Timing>();
const milliseconds = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** Per-attempt only. No prompts, tool arguments, results or identity are stored. */
export function withHelpPerformance<T>(job: Job, operation: () => Promise<T>): Promise<T> {
  const wall = Date.now();
  return storage.run({ id: job.id, origin: performance.now(), wall,
    age: milliseconds(wall - new Date(job.createdAt).getTime()),
    delay: milliseconds(wall - new Date(job.nextAt).getTime()),
    attempt: job.attempts, stages: {} }, operation);
}

export async function timeHelpStage<T>(stage: HelpTimingStage, operation: () => Promise<T>): Promise<T> {
  const timing = storage.getStore();
  if (!timing) return operation();
  const start = performance.now(); let thrownErrors = false;
  try { return await operation(); }
  catch (error) { thrownErrors = true; throw error; }
  finally {
    const duration = milliseconds(performance.now() - start);
    const current = timing.stages[stage] ||= { calls: 0, thrownErrors: 0, totalMs: 0, maxMs: 0 };
    current.calls++; current.thrownErrors += Number(thrownErrors); current.totalMs += duration;
    current.maxMs = Math.max(current.maxMs, duration);
  }
}

export function markHelpFirstDraft() {
  const timing = storage.getStore();
  if (timing) timing.firstDraftProducedMs ??= milliseconds(performance.now() - timing.origin);
}

export function markHelpFirstDraftPersisted() {
  const timing = storage.getStore();
  if (timing) timing.firstDraftPersistedMs ??= milliseconds(performance.now() - timing.origin);
}

export function helpPerformanceSnapshot(jobId: string) {
  const timing = storage.getStore();
  if (!timing || timing.id !== jobId) return undefined;
  const attemptElapsedMs = milliseconds(performance.now() - timing.origin);
  return { version: 1, attempt: timing.attempt, attemptStartedAt: timing.wall,
    jobAgeAtStartMs: timing.age, readyDelayMs: timing.delay, attemptElapsedMs,
    jobElapsedMs: timing.age + attemptElapsedMs,
    ...(timing.firstDraftProducedMs === undefined ? {} : { firstDraftProducedMs: timing.firstDraftProducedMs }),
    ...(timing.firstDraftPersistedMs === undefined ? {} : { firstDraftPersistedMs: timing.firstDraftPersistedMs }),
    stages: Object.fromEntries(Object.entries(timing.stages).map(([key, value]) => [key, { ...value }])) };
}
