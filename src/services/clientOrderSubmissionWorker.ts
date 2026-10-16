import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma, { pool } from '../prisma/client';
import { ClientOrdersError, putClientOrderByClientId } from '../modules/clientOrders/clientOrders.service';
import { clientOrderMutationSchema } from '../modules/clientOrders/clientOrders.schemas';
import { clientOrderPayloadHash } from '../modules/clientOrders/acceptedClientOperation';
import { OrderIntegrityError } from '../modules/orders/orderIntegrity';
import { submissionPayloadHash } from '../modules/clientOrders/clientOrderSubmissions';
import { ErrorCodes } from '../utils/apiResponse';
import { materializeLegacyOrderSubmission } from '../modules/clientOrders/legacyOrderSubmission';
import { withBackgroundOnecRequests } from '../modules/onec/onec.lpApp.client';

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let wakeup: NodeJS.Timeout | null = null;
let lastCompactionAt = 0;
const LEASE_MS = 5 * 60_000;
const retryDelay = (attempts: number) => Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));

export function submissionFailure(error: unknown) {
  const known = error instanceof ClientOrdersError || error instanceof OrderIntegrityError;
  const status = known ? error.status : 503;
  const details = error instanceof OrderIntegrityError ? error.details : error instanceof ClientOrdersError ? error.details : null;
  const code = (details as any)?.kind ?? (error instanceof ClientOrdersError ? error.code : 'PROCESSING_UNAVAILABLE');
  const retryable = [0, 408, 425, 429, 500, 502, 503, 504].includes(status) || code === 'ORDER_EXPORT_IN_PROGRESS';
  const review = ['PRICE_REVIEW_REQUIRED', 'STOCK_SHORTAGE', 'ORDER_CHANGE_REVIEW_REQUIRED', 'REFERENCE_STALE'].includes(code);
  return { state: retryable ? 'RETRY' : review ? 'NEEDS_REVIEW' : 'REJECTED', code,
    message: retryable ? 'Документ сохранён в API. Обработка временно недоступна; сервер повторит попытку автоматически.' : known ? error.message : 'Обработка временно недоступна. Сервер повторит попытку.',
    details: details ? JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue : Prisma.DbNull };
}

/** Network work never holds an SQL transaction. A session lock fences expired leases. */
export async function processClientOrderSubmission(id: string) {
  const observed = await prisma.clientOrderSubmission.findUnique({ where: { id } });
  if (!observed) return;
  const connection = await pool.connect();
  const key = `submission-worker:${observed.userId}:${observed.clientOrderId}`;
  let locked = false;
  const leaseToken = randomUUID();
  let claimed = false;
  try {
    locked = (await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key])).rows[0]?.locked === true;
    if (!locked) return;
    const now = new Date();
    const claim = await prisma.clientOrderSubmission.updateMany({ where: { id, OR: [
      { state: { in: ['ACCEPTED', 'RETRY'] }, nextAttemptAt: { lte: now } },
      // Holding the per-client session lock proves the former executor is gone.
      { state: 'PROCESSING', leaseToken: observed.leaseToken },
    ] }, data: { state: 'PROCESSING', leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } } });
    if (claim.count !== 1) return;
    claimed = true;
    if (submissionPayloadHash(observed.payload) !== observed.payloadHash) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Сохранённый пакет документа не прошёл проверку целостности');
    }
    const user = await prisma.user.findUnique({ where: { id: observed.userId }, select: { isActive: true, deletedAt: true } });
    if (!user?.isActive || user.deletedAt) {
      await prisma.clientOrderSubmission.updateMany({ where: { id, leaseToken }, data: {
        state: 'REJECTED', errorCode: 'ACCOUNT_DISABLED', errorMessage: 'Пользователь больше не имеет доступа', leaseToken: null, leaseUntil: null,
      } });
      return;
    }
    const body = clientOrderMutationSchema.parse(observed.payload);
    if (observed.clientOrderId.startsWith('legacy-server:')) {
      const order = await withBackgroundOnecRequests(() => materializeLegacyOrderSubmission(observed.userId, observed.payload, body));
      await prisma.clientOrderSubmission.updateMany({ where: { id, leaseToken }, data: {
        state: 'QUEUED', orderGuid: order.guid, leaseToken: null, leaseUntil: null,
        errorCode: null, errorMessage: null, errorDetails: Prisma.DbNull,
      } });
      return;
    }
    // Reuses all existing commercial checks, ownership, revision and posting protections.
    try { await withBackgroundOnecRequests(() => putClientOrderByClientId(observed.userId, observed.clientOrderId, body, { storedResultOnly: true })); }
    catch (error) {
      // A detail read/connection can fail AFTER the mutation committed. Prove the
      // exact submitted input in PostgreSQL before classifying it as a failure.
      const committed = await prisma.order.findFirst({ where: { createdByUserId: observed.userId,
        clientOrderId: observed.clientOrderId, clientRevision: observed.clientRevision,
        clientPayloadHash: clientOrderPayloadHash(body), submitRequestedAt: { not: null },
        status: { in: ['QUEUED', 'SENT_TO_1C', 'CONFIRMED'] }, syncState: { in: ['QUEUED', 'SYNCED'] } }, select: { guid: true } });
      if (!committed?.guid) throw error;
    }
    const order = await prisma.order.findFirst({ where: { createdByUserId: observed.userId,
      clientOrderId: observed.clientOrderId, clientRevision: observed.clientRevision,
      clientPayloadHash: clientOrderPayloadHash(body), submitRequestedAt: { not: null },
      status: { in: ['QUEUED', 'SENT_TO_1C', 'CONFIRMED'] } }, select: { guid: true } });
    if (!order?.guid) throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Принятая операция не совпадает с текущей версией заказа');
    await prisma.clientOrderSubmission.updateMany({ where: { id, leaseToken }, data: {
      state: 'QUEUED', orderGuid: order.guid, leaseToken: null, leaseUntil: null,
      errorCode: null, errorMessage: null, errorDetails: Prisma.DbNull,
    } });
  } catch (error) {
    if (!claimed) throw error;
    const failure = submissionFailure(error);
    console.warn('[order-inbox] processing result', { submissionId: id, state: failure.state, code: failure.code });
    await prisma.clientOrderSubmission.updateMany({ where: { id, leaseToken }, data: {
      state: failure.state, errorCode: failure.code, errorMessage: failure.message, errorDetails: failure.details,
      nextAttemptAt: new Date(Date.now() + retryDelay(observed.attempts + 1)), leaseToken: null, leaseUntil: null,
    } });
  } finally {
    try {
      if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      connection.release();
    } catch { connection.release(true); }
  }
}

export async function runClientOrderSubmissionsOnce() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const candidates = await prisma.clientOrderSubmission.findMany({ where: { OR: [
      { state: { in: ['ACCEPTED', 'RETRY'] }, nextAttemptAt: { lte: now } },
      { state: 'PROCESSING' },
    ] }, orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }], take: 20, select: { id: true } });
    // Bounded server concurrency, independent of phone/UI lifetime.
    for (let i = 0; i < candidates.length; i += 2) {
      const results = await Promise.allSettled(candidates.slice(i, i + 2).map(row => processClientOrderSubmission(row.id)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error('[order-inbox] claim failed', { submissionId: candidates[i + index].id, error: result.reason });
      });
    }
  } finally { running = false; }
}

export async function compactCompletedSubmissionPayloads() {
  // Keep receipt identities/hashes forever; retain the full raw input for seven
  // days after materialization. No active job or business-error packet is touched.
  return prisma.$executeRaw`UPDATE "ClientOrderSubmission" s SET payload='null'::jsonb
    WHERE s.state='QUEUED' AND s.payload <> 'null'::jsonb
      AND s."acceptedAt" < CURRENT_TIMESTAMP - INTERVAL '7 days'
      AND EXISTS (SELECT 1 FROM "Order" o WHERE o.guid=s."orderGuid"
        AND o."createdByUserId"=s."userId" AND ((o."clientOrderId"=s."clientOrderId"
        AND o."clientRevision">=s."clientRevision") OR s."clientOrderId"='legacy-server:' || o.guid))`;
}

function schedule() {
  if (!started) return;
  timer = setTimeout(async () => {
    try { await runClientOrderSubmissionsOnce(); } catch (error) { console.error('[order-inbox] scan failed', error); }
    if (Date.now() - lastCompactionAt > 86_400_000) {
      try { await compactCompletedSubmissionPayloads(); lastCompactionAt = Date.now(); }
      catch (error) { lastCompactionAt = Date.now() - 86_400_000 + 300_000; console.error('[order-inbox] compaction failed', error); }
    }
    schedule();
  }, 3_000);
}
export function startClientOrderSubmissionWorker() {
  if (started || process.env.CLIENT_ORDERS_SUBMISSION_WORKER_DISABLED === '1') return;
  started = true;
  wakeClientOrderSubmissionWorker();
  schedule();
}
export function wakeClientOrderSubmissionWorker() {
  if (!started || wakeup) return;
  wakeup = setTimeout(async () => {
    wakeup = null;
    try { await runClientOrderSubmissionsOnce(); } catch (error) { console.error('[order-inbox] wakeup failed', error); }
  }, 25);
}
export function stopClientOrderSubmissionWorker() {
  started = false;
  if (timer) clearTimeout(timer);
  if (wakeup) clearTimeout(wakeup);
  timer = wakeup = null;
}
