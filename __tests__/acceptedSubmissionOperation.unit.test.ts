import { createHash } from 'node:crypto';
import { clientOrderPayloadHash, proveAcceptedSubmissionOperation } from '../src/modules/clientOrders/acceptedClientOperation';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';

const body = () => ({ organizationGuid: 'org', counterpartyGuid: 'customer', clientRevision: 34, intent: 'SUBMIT',
  deliveryDate: '2026-10-22', currency: 'RUB', invoiceRequested: false, offlineReview: { pricePolicy: 'KEEP_DRAFT' },
  integrity: { baseContentToken: 'a'.repeat(64) }, geoEvents: [{ clientEventId: 'geo-event-123',
    type: 'SUBMITTED', status: 'UNAVAILABLE', capturedAt: '2026-10-20T00:00:00Z' }],
  items: [{ lineGuid: 'line', productGuid: 'product', quantity: 48, basePrice: 110, manualPrice: null }] });
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
const hash = (v: any) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const order = () => ({ guid: 'api-guid', createdByUserId: 99, clientOrderId: 'client-id', clientRevision: 34,
  clientPayloadHash: clientOrderPayloadHash(clientOrderMutationSchema.parse(body())), source: 'MANAGER_APP',
  syncState: 'SYNCED', status: 'CONFIRMED', isPostedIn1c: true, number1c: 'НОУТ-127007',
  lastExportError: null, last1cError: null, cancelRequestedAt: null });
const receipt = () => ({ userId: 99, clientOrderId: 'client-id', clientRevision: 34, orderGuid: 'api-guid',
  state: 'QUEUED', payloadHash: hash(body()), payload: body() });

it('proves the exact immutable receipt for a posted formerly rejected draft without an amendment audit', () => {
  expect(proveAcceptedSubmissionOperation(order(), receipt(), 99)).toMatchObject({ clientRevision: 34,
    intent: 'SUBMIT', payload: { deliveryDate: expect.any(Date), items: body().items } });
});
it('omits locations, integrity tokens and transport/price-review choices', () => {
  const proof = proveAcceptedSubmissionOperation(order(), receipt(), 99)!;
  for (const field of ['geoEvents', 'integrity', 'offlineReview', 'saveReason', 'clientRevision', 'intent']) {
    expect(proof.payload).not.toHaveProperty(field);
  }
});
it.each([
  { state: 'NEEDS_REVIEW' }, { state: 'REJECTED' }, { state: 'PROCESSING' }, { state: 'ACCEPTED' },
  { userId: 98 }, { orderGuid: 'another' }, { orderGuid: null }, { clientOrderId: 'another' },
  { clientRevision: 33 }, { clientRevision: 35 }, { payloadHash: 'wrong' }, { payload: null },
])('rejects incomplete, foreign, stale, or corrupt receipt: %j', patch => {
  expect(proveAcceptedSubmissionOperation(order(), { ...receipt(), ...patch } as any, 99)).toBeNull();
});
it.each([
  { createdByUserId: 98 }, { guid: null }, { source: 'MARKETPLACE_CLIENT' }, { syncState: 'QUEUED' },
  { status: 'DRAFT' }, { isPostedIn1c: false }, { number1c: null }, { lastExportError: 'error' },
  { last1cError: 'error' }, { cancelRequestedAt: new Date() }, { clientRevision: 33 }, { clientPayloadHash: 'wrong' },
])('requires a complete matching posted API order: %j', patch => {
  expect(proveAcceptedSubmissionOperation({ ...order(), ...patch }, receipt(), 99)).toBeNull();
});
it('does not accept another user or a missing receipt', () => {
  expect(proveAcceptedSubmissionOperation(order(), receipt(), 98)).toBeNull();
  expect(proveAcceptedSubmissionOperation(order(), null, 99)).toBeNull();
});
it.each([{ intent: 'SAVE' }, { clientRevision: 33 }, { comment: 'Different accepted input' },
  { items: [{ ...body().items[0], quantity: 47 }] }])('rejects a valid transport hash of different input: %j', patch => {
  const payload = { ...body(), ...patch };
  expect(proveAcceptedSubmissionOperation(order(), { ...receipt(), payload, payloadHash: hash(payload) } as any, 99)).toBeNull();
});
