import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { connectRedis, getRedis } from '../../lib/redis';
import prisma from '../../prisma/client';
import type { HelpKnowledgeSource } from './help.knowledge';

export class HelpT3Error extends Error {
  constructor(public readonly code: string, public readonly retryable = false, public readonly retryAfterMs = 0) {
    super(code); this.name = 'HelpT3Error';
  }
}
export function t3Configuration() {
  return {
    enabled: process.env.NODE_ENV === 'development' && process.env.HELP_T3_DEV_ENABLED === 'true' &&
      !!process.env.HELP_T3_WEBHOOK_URL_FILE?.trim(),
    timeoutMs: 300000,
    maxAttempts: 2,
  };
}
export const t3Active = () => process.env.HELP_AI_ENABLED === 'true' && process.env.HELP_AI_PROVIDER === 't3' && t3Configuration().enabled;
export const t3ResultSchema = z.object({
  decision: z.enum(['answer', 'clarify', 'handoff']),
  message: z.string().trim().min(1).max(12000),
  source_ids: z.array(z.string().regex(/^S[123]$/)).max(3).refine(ids => new Set(ids).size === ids.length),
}).strict();
export type T3Result = z.infer<typeof t3ResultSchema>;
export type T3Context = {
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  sources: Array<{ id: string; title: string; revision: number; excerpt: string }>;
};
export type T3Job = { id: string; ticketId: number; ownerId: number; leaseToken: string };
type Pending = { tokenHash: string; job: T3Job; context: T3Context; validationSources: HelpKnowledgeSource[] };
export type T3Store = Pick<ReturnType<typeof getRedis>, 'get' | 'set' | 'del'>;
const key = (id: string, result = false) => `${process.env.REDIS_KEY_PREFIX || 'app:'}help:t3:${id}${result ? ':result' : ''}`;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new HelpT3Error('HELP_T3_REQUEST_UNAVAILABLE');

export function validateT3Result(raw: unknown, context: T3Context): T3Result {
  const parsed = t3ResultSchema.safeParse(raw);
  if (!parsed.success) throw new HelpT3Error('HELP_T3_INVALID_RESPONSE');
  if (parsed.data.source_ids.some(id => !context.sources.some(source => source.id === id))) {
    throw new HelpT3Error('HELP_T3_INVALID_CITATIONS');
  }
  if (context.sources.length && parsed.data.decision === 'answer' && !parsed.data.source_ids.length) throw new HelpT3Error('HELP_T3_INVALID_CITATIONS');
  return parsed.data;
}

/** Only this live lease can disclose context or accept a result. Never give T3 a user JWT. */
export async function authorizeT3Request(id: string, token: string, providedStore?: T3Store) {
  if (!t3Active() || !z.string().uuid().safeParse(id).success || !/^[a-f0-9]{64}$/.test(token)) throw unavailable();
  const store = providedStore || getRedis();
  const raw = await store.get(key(id));
  if (!raw) throw unavailable();
  const pending = JSON.parse(raw) as Pending;
  if (!timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(pending.tokenHash, 'hex'))) throw unavailable();
  const job = await prisma.helpAssistantJob.findUnique({ where: { id: pending.job.id }, include: { ticket: { include: { members: true } } } });
  if (!job || job.provider !== 't3' || job.status !== 'RUNNING' || job.leaseToken !== pending.job.leaseToken ||
      !job.leaseUntil || job.leaseUntil.getTime() <= Date.now() || job.ticketId !== pending.job.ticketId || job.ownerId !== pending.job.ownerId ||
      job.ticket.status !== 'OPEN' || job.ticket.itRequested || job.ticket.members.some(member => member.role === 'IT')) throw unavailable();
  const { helpActor } = await import('./help.service');
  await helpActor(job.ownerId);
  const { validateHelpKnowledgeSources } = await import('./help.knowledge');
  await prisma.$transaction(tx => validateHelpKnowledgeSources(tx, pending.validationSources, job.ownerId));
  return pending;
}

export async function readT3Request(id: string, token: string) {
  return (await authorizeT3Request(id, token)).context;
}
export async function completeT3Request(id: string, token: string, raw: unknown, providedStore?: T3Store) {
  if (!t3Active()) throw unavailable();
  const store = providedStore || getRedis();
  const pending = await authorizeT3Request(id, token, store);
  const result = validateT3Result(raw, pending.context);
  // First valid result wins. A retry cannot replace it. The worker owns the final DB transaction.
  const saved = await store.set(key(id, true), JSON.stringify(result), { EX: 360, NX: true });
  return saved === 'OK';
}

function webhookURL() {
  try {
    const url = new URL(readFileSync(process.env.HELP_T3_WEBHOOK_URL_FILE!, 'utf8').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new HelpT3Error('HELP_T3_NOT_CONFIGURED'); }
}

/** The PostgreSQL Help job remains durable; this short-lived exchange is specific to one lease attempt. */
export async function requestT3Answer(job: T3Job, context: T3Context, validationSources: HelpKnowledgeSource[], signal: AbortSignal,
  transport: typeof fetch = fetch, providedStore?: T3Store, wait: (signal: AbortSignal) => Promise<unknown> = signal => pause(1000, undefined, { signal })) {
  if (!t3Active()) throw new HelpT3Error('HELP_T3_NOT_CONFIGURED');
  if (!context.messages.some(message => message.role === 'user' && message.text.trim())) throw new HelpT3Error('HELP_T3_EMPTY_CONTEXT');
  const url = webhookURL();
  // Dedicated Help workers do not run the API's Redis bootstrap.
  const store = providedStore || await connectRedis();
  if (!store) throw new HelpT3Error('HELP_T3_REDIS_UNAVAILABLE', true);
  const id = randomUUID(), token = randomBytes(32).toString('hex');
  const timeout = AbortSignal.timeout(t3Configuration().timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    combined.throwIfAborted();
    await store.set(key(id), JSON.stringify({ tokenHash: hash(token), job, context, validationSources } satisfies Pending), { EX: 360, NX: true });
    const response = await transport(url, { method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, requestId: id, capability: token }) });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new HelpT3Error(`HELP_T3_HTTP_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
    while (true) {
      combined.throwIfAborted();
      if (!t3Active()) throw new HelpT3Error('HELP_T3_NOT_CONFIGURED');
      const raw = await store.get(key(id, true));
      if (raw) return { ...validateT3Result(JSON.parse(raw), context), responseId: id };
      await wait(combined);
    }
  } catch (error) {
    if (signal.aborted) throw new HelpT3Error('HELP_T3_CANCELLED', true);
    if (timeout.aborted) throw new HelpT3Error('HELP_T3_TIMEOUT', true);
    if (error instanceof HelpT3Error) throw error;
    // Network errors may contain the secret webhook URL: expose only a stable code.
    throw new HelpT3Error('HELP_T3_NETWORK', true);
  } finally {
    await store.del([key(id), key(id, true)]).catch(() => {});
  }
}
