import { createHash } from 'node:crypto';
import { Prisma, type ClientOrderSubmission } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prisma/client';
import { clientOrderMutationSchema } from './clientOrders.schemas';

export const SUBMISSION_RECEIPT_VERSION = 'client-order-inbox-v1';
export const submissionItemSchema = z.object({
  clientOrderId: z.string().trim().min(8).max(128).refine(id => !id.startsWith('legacy') || /^legacy-server:[0-9a-f-]{36}$/i.test(id), 'Требуется сверка старого документа'),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()).refine(p => Buffer.byteLength(JSON.stringify(p), 'utf8') <= 512 * 1024, 'Слишком большой документ'),
});
export const submissionsBatchSchema = z.object({ items: z.array(z.unknown()).min(1).max(10) });
export const submissionsStatusSchema = z.object({ ids: z.array(z.string().min(8).max(128)).min(1).max(100) });

/** JSON transport canonicalization; identical code-point key ordering on phone/API. */
export function submissionCanonicalJson(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])])) : v;
  return JSON.stringify(stable(JSON.parse(JSON.stringify(value))));
}
export function submissionPayloadHash(payload: unknown) {
  return createHash('sha256').update(submissionCanonicalJson(payload), 'utf8').digest('hex');
}

export class SubmissionConflict extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

export function submissionReceipt(row: ClientOrderSubmission) {
  return { receiptVersion: SUBMISSION_RECEIPT_VERSION, accepted: true as const, submissionId: row.id,
    userId: row.userId, clientOrderId: row.clientOrderId, clientRevision: row.clientRevision,
    intent: 'SUBMIT' as const, payloadHash: row.payloadHash, acceptedAt: row.acceptedAt.toISOString(),
    state: row.state, orderGuid: row.orderGuid, errorCode: row.errorCode, errorMessage: row.errorMessage,
    errorDetails: row.errorDetails };
}

/** Only syntax, authorization (middleware), hashing and PostgreSQL. Never 1C. */
export async function acceptClientOrderSubmission(userId: number, input: unknown) {
  const item = submissionItemSchema.parse(input);
  const body = clientOrderMutationSchema.parse(item.payload);
  if (body.intent !== 'SUBMIT') throw new SubmissionConflict('NOT_SUBMITTED', 'Черновик не поставлен пользователем в очередь');
  const payloadHash = submissionPayloadHash(item.payload);
  if (payloadHash !== item.payloadHash) throw new SubmissionConflict('PAYLOAD_HASH_MISMATCH', 'Пакет документа изменился при отправке');
  if (item.clientOrderId.startsWith('legacy-server:') && (item.payload.legacyServerGuid !== item.clientOrderId.slice('legacy-server:'.length)
    || !Number.isInteger(item.payload.legacyServerRevision) || Number(item.payload.legacyServerRevision) < 1)) {
    throw new SubmissionConflict('LEGACY_TARGET_MISMATCH', 'Не подтверждены идентификатор и версия исходного заказа');
  }
  const row = await prisma.$transaction(async tx => {
    await tx.$queryRaw`WITH inbox_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${`submission:${userId}:${item.clientOrderId}`}, 0))
    ) SELECT 1::integer AS locked FROM inbox_lock`;
    if (item.clientOrderId.startsWith('legacy-server:') && !await tx.order.findFirst({ where: {
      guid: String(item.payload.legacyServerGuid), createdByUserId: userId, source: 'MANAGER_APP',
    }, select: { id: true } })) throw new SubmissionConflict('LEGACY_ORDER_NOT_FOUND', 'Исходный заказ не найден у этого пользователя');
    const previous = await tx.clientOrderSubmission.findFirst({ where: { userId, clientOrderId: item.clientOrderId },
      orderBy: { clientRevision: 'desc' } });
    if (previous && body.clientRevision < previous.clientRevision) {
      throw new SubmissionConflict('STALE_CLIENT_REVISION', 'На сервере уже принята более новая версия документа');
    }
    if (previous?.clientRevision === body.clientRevision) {
      if (previous.payloadHash !== payloadHash) throw new SubmissionConflict('REVISION_PAYLOAD_CONFLICT', 'Одна версия документа содержит разные данные');
      return previous;
    }
    if (previous && ['ACCEPTED', 'PROCESSING', 'RETRY'].includes(previous.state)) {
      throw new SubmissionConflict('PREVIOUS_OPERATION_PENDING', 'Предыдущая версия документа ещё обрабатывается', true);
    }
    return tx.clientOrderSubmission.create({ data: { userId, clientOrderId: item.clientOrderId,
      clientRevision: body.clientRevision, payloadHash, payload: JSON.parse(JSON.stringify(item.payload)) as Prisma.InputJsonValue } });
  });
  return submissionReceipt(row);
}

export async function acceptClientOrderSubmissionBatch(userId: number, inputs: unknown[]) {
  const results = [];
  // Small bounded batch, separate commits: one invalid document cannot roll back its neighbours.
  for (const input of inputs) {
    try { results.push(await acceptClientOrderSubmission(userId, input)); }
    catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof SubmissionConflict)) throw error;
      const raw = input as any;
      results.push({ accepted: false as const, userId, clientOrderId: typeof raw?.clientOrderId === 'string' ? raw.clientOrderId : null,
        clientRevision: raw?.payload?.clientRevision ?? null, payloadHash: raw?.payloadHash ?? null,
        errorCode: error instanceof SubmissionConflict ? error.code : 'VALIDATION_ERROR',
        errorMessage: error instanceof SubmissionConflict ? error.message : 'Проверьте заполнение документа',
        retryable: error instanceof SubmissionConflict && error.retryable });
    }
  }
  return { receiptVersion: SUBMISSION_RECEIPT_VERSION, results };
}

/** User-scoped, DB-only polling. Never call live 1C on a receipt/status endpoint. */
export async function getClientOrderSubmissionStatuses(userId: number, ids: string[]) {
  const rows = await prisma.clientOrderSubmission.findMany({ where: { userId, id: { in: ids } }, take: 100 });
  return { receiptVersion: SUBMISSION_RECEIPT_VERSION, results: rows.map(submissionReceipt) };
}

/** Bind a canonical DB-only read to the exact immutable operation, not to fields
 * which 1C may legitimately enrich after accepting that operation. */
export async function getClientOrderSubmissionOrder<T extends { guid: string | null; createdByUser?: { id: number } | null }>(
  userId: number, id: string, readOrder: (guid: string, userId: number) => Promise<T>,
) {
  const row = await prisma.clientOrderSubmission.findFirst({ where: { id, userId, state: 'QUEUED' } });
  if (!row?.orderGuid) return null;
  const order = await readOrder(row.orderGuid, userId);
  if (order.guid !== row.orderGuid || order.createdByUser?.id !== userId) return null;
  return { ...order, acceptedSubmission: submissionReceipt(row) };
}
