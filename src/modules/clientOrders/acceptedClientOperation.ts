import { createHash } from 'node:crypto';
import { clientOrderMutationSchema } from './clientOrders.schemas';

function stableJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableJsonValue(item)]));
  return value;
}

// Keep identical to the mobile write idempotency hash, including transport metadata.
export function clientOrderPayloadHash(body: Record<string, unknown>) {
  const { clientRevision: _revision, intent: _intent, integrity: _integrity, ...payload } = body;
  return createHash('sha256').update(JSON.stringify(stableJsonValue(payload))).digest('hex');
}

type Event = { revision: number; payload: unknown } | null;
type Order = { clientOrderId: string | null; clientRevision: number | null; clientPayloadHash: string | null;
  source: string; syncState: string; status: string; isPostedIn1c: boolean; number1c: string | null;
  lastExportError: string | null; last1cError: string | null; cancelRequestedAt: Date | null };

/** Historical submitted input is evidence; a number, newer revision or current 1C prices alone are not. */
export function proveAcceptedClientOperation(order: Order, mutation: Event, submitted: Event, change: Event) {
  if (order.source !== 'MANAGER_APP' || order.syncState !== 'SYNCED' || order.status !== 'CONFIRMED'
    || !order.isPostedIn1c || !order.number1c || order.lastExportError || order.last1cError || order.cancelRequestedAt
    || !order.clientRevision || !order.clientPayloadHash || !mutation || !submitted || !change) return null;
  const match = (event: Event) => {
    const payload = event?.payload as Record<string, unknown> | null;
    return payload?.clientOrderId === order.clientOrderId && payload?.clientRevision === order.clientRevision;
  };
  if (!match(mutation) || !match(submitted) || mutation.revision !== submitted.revision
    || change.revision + 1 !== mutation.revision) return null;
  const candidate = clientOrderMutationSchema.safeParse((change.payload as { proposed?: unknown })?.proposed);
  if (!candidate.success || candidate.data.intent !== 'SUBMIT' || candidate.data.clientRevision !== order.clientRevision
    || clientOrderPayloadHash(candidate.data) !== order.clientPayloadHash) return null;
  // Never return location, confirmation tokens, price-review or transport metadata to the UI.
  const { geoEvents: _geo, integrity: _integrity, offlineReview: _review, saveReason: _reason,
    clientRevision, intent, ...payload } = candidate.data;
  return { clientRevision, intent, payload };
}

type Submission = { userId: number; clientOrderId: string; clientRevision: number;
  orderGuid: string | null; state: string; payloadHash: string; payload: unknown } | null;

/** A previously rejected draft may be accepted without an amendment audit.
 * Its immutable receipt must prove the exact posted input; never reconstruct
 * that input from current 1C fields or rewrite a historical rejection. */
export function proveAcceptedSubmissionOperation(
  order: Order & { guid: string | null; createdByUserId: number | null }, receipt: Submission, userId: number,
) {
  if (order.createdByUserId !== userId || !order.guid || order.source !== 'MANAGER_APP'
    || order.syncState !== 'SYNCED' || order.status !== 'CONFIRMED' || !order.isPostedIn1c
    || !order.number1c || order.lastExportError || order.last1cError || order.cancelRequestedAt
    || !order.clientRevision || !order.clientPayloadHash || !receipt || receipt.state !== 'QUEUED'
    || receipt.userId !== userId || receipt.orderGuid !== order.guid
    || receipt.clientOrderId !== order.clientOrderId || receipt.clientRevision !== order.clientRevision) return null;
  if (!receipt.payload || typeof receipt.payload !== 'object' || Array.isArray(receipt.payload)) return null;
  // Keep transport hashing identical to submissionCanonicalJson (code-point
  // ordering), independently of the normalized mutation hash above.
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const transportHash = createHash('sha256').update(JSON.stringify(stable(receipt.payload))).digest('hex');
  if (transportHash !== receipt.payloadHash) return null;
  const candidate = clientOrderMutationSchema.safeParse(receipt.payload);
  if (!candidate.success || candidate.data.intent !== 'SUBMIT' || candidate.data.clientRevision !== order.clientRevision
    || clientOrderPayloadHash(candidate.data) !== order.clientPayloadHash) return null;
  const { geoEvents: _geo, integrity: _integrity, offlineReview: _review, saveReason: _reason,
    clientRevision, intent, ...payload } = candidate.data;
  return { clientRevision, intent, payload };
}
