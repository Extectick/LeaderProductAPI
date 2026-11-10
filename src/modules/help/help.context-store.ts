import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prisma/client';
import {helpMessageAuthor,type HelpMessageAuthor} from './help.chat-context';

export type HelpContextMessage = {
  id: number; sequence: number; role: 'user' | 'assistant'; text: string;
  author?:HelpMessageAuthor;
  attachments: Array<{ id: string; name: string; kind: string; mimeType: string; size: number }>;
};
export type HelpContextSummary = {
  version: 1; model: string; coveredThrough: number; fingerprint: string; omittedBefore?: number;
  items: Array<{ kind: 'goal' | 'constraint' | 'decision' | 'reported_result' | 'open_question'; text: string; messageIds: number[] }>;
};
type ContextDb = Prisma.TransactionClient | typeof prisma;
export class HelpContextError extends Error {
  constructor(public readonly code: 'HELP_CONTEXT_CHANGED' | 'HELP_CONTEXT_INVALID' | 'HELP_CONTEXT_FORBIDDEN', public readonly status = 409) {
    super(code); this.name = 'HelpContextError';
  }
}
const positive = z.number().int().min(1).max(2147483647);
const summarySchema = z.object({
  version: z.literal(1), model: z.string().trim().min(1).max(120), coveredThrough: positive,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  omittedBefore: z.number().int().min(0).max(2147483647).optional(),
  items: z.array(z.object({
    kind: z.enum(['goal', 'constraint', 'decision', 'reported_result', 'open_question']),
    text: z.string().trim().min(1).max(600), messageIds: z.array(positive).min(1).max(20),
  }).strict()).min(1).max(64),
}).strict();

export function parseHelpContextSummary(value: unknown): HelpContextSummary | undefined {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data).length > 64000) return;
  if (new Set(parsed.data.items.flatMap(item => item.messageIds)).size > 512) return;
  return parsed.data;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validScope(ticketId: number, ownerId: number, throughSequence: number) {
  if (![ticketId, ownerId, throughSequence].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) throw new HelpContextError('HELP_CONTEXT_INVALID');
}
function historyWhere(ticketId: number, ownerId: number, throughSequence: number): Prisma.HelpMessageWhereInput {
  return { ticketId, kind: 'TEXT', sequence: { lte: throughSequence }, OR: [
    { authorId: ownerId }, { authorId: null, authorRole: 'SYSTEM' }, {authorId:{not:null},authorRole:'IT'},
  ] };
}
async function assertAccess(db: ContextDb, ticketId: number, ownerId: number) {
  // Lazy import avoids the Help service → worker → context-store module cycle.
  const { helpActor, requireHelpTicket } = await import('./help.service');
  const actor = await helpActor(ownerId);
  const ticket = await requireHelpTicket(db, ticketId, actor, false);
  if (ticket.ownerId !== ownerId || ticket.status !== 'OPEN' || ticket.itRequested || ticket.members.some(m => m.role === 'IT')) {
    throw new HelpContextError('HELP_CONTEXT_FORBIDDEN', 403);
  }
}

/** Hash at the database boundary: the application receives neither an unlimited
 * transcript nor object keys. Identity, edits and attachment changes invalidate it. */
export async function helpContextFingerprint(db: ContextDb, ticketId: number, ownerId: number, throughSequence: number): Promise<{ fingerprint: string; totalMessages: number }> {
  validScope(ticketId, ownerId, throughSequence);
  const rows = await db.$queryRaw<Array<{ fingerprint: string; totalMessages: number }>>`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(
      jsonb_build_array(m."id", m."sequence", m."authorId", m."authorRole",
        EXTRACT(EPOCH FROM m."editedAt"), encode(sha256(convert_to(m."text", 'UTF8')), 'hex'),
        COALESCE((SELECT jsonb_agg(jsonb_build_array(a."id", a."name", a."kind", a."mimeType", a."size", a."sha256")
          ORDER BY a."position", a."createdAt", a."id") FROM "HelpAttachment" a
          WHERE a."messageId" = m."id" AND a."ownerId" = ${ownerId}), '[]'::jsonb))::text,
      E'\n' ORDER BY m."sequence"), ''), 'UTF8')), 'hex') AS "fingerprint", COUNT(*)::int AS "totalMessages"
    FROM "HelpMessage" m
    WHERE m."ticketId" = ${ticketId} AND m."kind" = 'TEXT' AND m."sequence" <= ${throughSequence}
      AND (m."authorId" = ${ownerId} OR (m."authorId" IS NULL AND m."authorRole" = 'SYSTEM') OR (m."authorId" IS NOT NULL AND m."authorRole" = 'IT'))
  `;
  const row = rows[0];
  if (!row || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !Number.isSafeInteger(row.totalMessages) || row.totalMessages < 0) {
    throw new HelpContextError('HELP_CONTEXT_INVALID');
  }
  return row;
}

async function referencesExist(db: ContextDb, ticketId: number, ownerId: number, summary: HelpContextSummary) {
  const ids = [...new Set(summary.items.flatMap(item => item.messageIds))];
  if (!ids.length) return true;
  const rows = await db.helpMessage.findMany({ where: { ...historyWhere(ticketId, ownerId, summary.coveredThrough), id: { in: ids } }, select: { id: true } });
  return new Set(rows.map(row => row.id)).size === ids.length && rows.every(row => ids.includes(row.id));
}

/** PostgreSQL remains the original history. The private summary is a cache,
 * discarded after a changed source and never promoted to trusted instructions. */
export async function loadHelpConversation(ticketId: number, ownerId: number, throughSequence: number, signal: AbortSignal, seed?:unknown): Promise<{
  messages: HelpContextMessage[]; summary?: HelpContextSummary; summaryCoveredMessages?:number; totalMessages: number; omittedBefore: number; fingerprint:string;
}> {
  validScope(ticketId, ownerId, throughSequence); signal.throwIfAborted();
  await assertAccess(prisma, ticketId, ownerId); signal.throwIfAborted();
  const where = historyWhere(ticketId, ownerId, throughSequence);
  const select = { id: true, sequence: true, authorId: true,authorRole:true,assistantJob:{select:{id:true}}, text: true,
    attachments: { where: { ownerId }, orderBy: { position: 'asc' as const }, select: { id: true, name: true, kind: true, mimeType: true, size: true } },
  };
  const initial = await helpContextFingerprint(prisma, ticketId, ownerId, throughSequence); signal.throwIfAborted();
  const [recent, first, jobs] = await Promise.all([
    prisma.helpMessage.findMany({ where, orderBy: { sequence: 'desc' }, take: 400, select }),
    prisma.helpMessage.findFirst({ where: { ...where, authorId: ownerId }, orderBy: { sequence: 'asc' }, select }),
    prisma.helpAssistantJob.findMany({ where: { ticketId, ownerId, provider: 'openai', status: 'COMPLETED' }, orderBy: { createdAt: 'desc' }, take: 5, select: { context: true } }),
  ]);
  signal.throwIfAborted();
  let summary: HelpContextSummary | undefined;
  let summaryCoveredMessages=0;
  for (const job of [...(object(seed)?[{context:seed}]:[]),...jobs]) {
    const candidate = parseHelpContextSummary(object(job.context) ? job.context.helpContextSummary : undefined);
    if (!candidate || candidate.coveredThrough > throughSequence) continue;
    const fingerprint = candidate.coveredThrough === throughSequence ? initial : await helpContextFingerprint(prisma, ticketId, ownerId, candidate.coveredThrough);
    signal.throwIfAborted();
    if (fingerprint.fingerprint === candidate.fingerprint) {
      const validReferences = await referencesExist(prisma, ticketId, ownerId, candidate);
      signal.throwIfAborted();
      if (validReferences) { summary = candidate; summaryCoveredMessages=fingerprint.totalMessages; break; }
    }
    signal.throwIfAborted();
  }
  const messages = [...new Map([...recent, ...(first ? [first] : [])].map(m => [m.id, m])).values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(m => ({ id: m.id, sequence: m.sequence, role: m.authorId !== null ? 'user' as const : 'assistant' as const,author:helpMessageAuthor(m,ownerId), text: m.text,
      attachments: m.attachments.map(a => ({id:a.id,name:a.name,kind:a.kind,mimeType:a.mimeType,size:a.size})) }));
  // An edit during preparation must never combine a stale summary with new rows.
  const final = await helpContextFingerprint(prisma, ticketId, ownerId, throughSequence); signal.throwIfAborted();
  if (initial.fingerprint !== final.fingerprint) throw new HelpContextError('HELP_CONTEXT_CHANGED');
  await assertAccess(prisma, ticketId, ownerId); signal.throwIfAborted();
  return { messages, ...(summary ? {summary,summaryCoveredMessages} : {}), totalMessages: initial.totalMessages, omittedBefore: Math.max(0, initial.totalMessages - messages.length),fingerprint:initial.fingerprint };
}

/** Called only after the caller's lease/ticket/source fences, within the SAME
 * final transaction. No summary or source payload enters public assistantState. */
export async function saveHelpContextSummary(db: ContextDb, job: { id: string; ticketId: number; ownerId: number; context: unknown }, value: HelpContextSummary): Promise<void> {
  const summary = parseHelpContextSummary(value);
  if (!summary) throw new HelpContextError('HELP_CONTEXT_INVALID');
  validScope(job.ticketId, job.ownerId, summary.coveredThrough);
  await assertAccess(db, job.ticketId, job.ownerId);
  const fingerprint = await helpContextFingerprint(db, job.ticketId, job.ownerId, summary.coveredThrough);
  if (fingerprint.fingerprint !== summary.fingerprint || !await referencesExist(db, job.ticketId, job.ownerId, summary)) throw new HelpContextError('HELP_CONTEXT_CHANGED');
  const previous = object(job.context) && Object.prototype.hasOwnProperty.call(job.context, 'inputs') ? job.context : undefined;
  const context = { ...(previous || {}), inputs: previous ? previous.inputs : job.context, helpContextSummary: summary };
  await db.helpAssistantJob.update({ where: { id: job.id }, data: { context: context as Prisma.InputJsonValue } });
}
