import { clientOrderPayloadHash, proveAcceptedClientOperation } from '../src/modules/clientOrders/acceptedClientOperation';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';

const body = { organizationGuid: 'org', counterpartyGuid: 'customer', clientRevision: 2, intent: 'SUBMIT',
  currency: 'RUB', deliveryDate: '2026-10-14', invoiceRequested: false,
  items: [{ lineGuid: 'line', productGuid: 'product', quantity: 2, manualPrice: 210 }] };
const order = () => ({ clientOrderId: 'client-id', clientRevision: 2, clientPayloadHash: clientOrderPayloadHash(clientOrderMutationSchema.parse(body)),
source: 'MANAGER_APP', syncState: 'SYNCED', status: 'CONFIRMED', isPostedIn1c: true,
number1c: 'НОУТ-123876', lastExportError: null, last1cError: null, cancelRequestedAt: null });
const mutation = () => ({ revision: 2, payload: { clientOrderId: 'client-id', clientRevision: 2 } });
const change = () => ({ revision: 1, payload: { proposed: body } });

it('proves the original submitted input after 1C normalized manual prices and headers', () => {
  const proof = proveAcceptedClientOperation(order(), mutation(), mutation(), change());
  expect(proof).toMatchObject({ clientRevision: 2, intent: 'SUBMIT', payload: { currency: 'RUB', items: body.items } });
  expect(proof?.payload).not.toHaveProperty('integrity');
  expect(proof?.payload).not.toHaveProperty('geoEvents');
});
it.each([
  { syncState: 'QUEUED' }, { syncState: 'ERROR' }, { status: 'DRAFT' }, { isPostedIn1c: false },
  { clientRevision: 3 }, { clientPayloadHash: 'wrong' }, { source: 'MARKETPLACE_CLIENT' },
  { last1cError: 'error' }, { lastExportError: 'error' }, { cancelRequestedAt: new Date() }, { number1c: null },
])('does not prove an incomplete or different operation: %j', patch => {
  expect(proveAcceptedClientOperation({ ...order(), ...patch }, mutation(), mutation(), change())).toBeNull();
});
it.each(['mutation', 'submitted', 'change'])('requires the committed %s evidence', missing => {
  expect(proveAcceptedClientOperation(order(), missing === 'mutation' ? null : mutation(),
    missing === 'submitted' ? null : mutation(), missing === 'change' ? null : change())).toBeNull();
});
it('rejects an audit for another client identity, a different revision, or changed input', () => {
  expect(proveAcceptedClientOperation(order(), { ...mutation(), payload: { clientOrderId: 'other', clientRevision: 2 } }, mutation(), change())).toBeNull();
  expect(proveAcceptedClientOperation(order(), mutation(), { ...mutation(), revision: 3 }, change())).toBeNull();
  expect(proveAcceptedClientOperation(order(), mutation(), mutation(), { ...change(), revision: 2 })).toBeNull();
  expect(proveAcceptedClientOperation(order(), mutation(), mutation(), { revision: 1,
    payload: { proposed: { ...body, comment: 'Different' } } })).toBeNull();
});
it('keeps the existing idempotency hash semantics', () => {
  expect(clientOrderPayloadHash(body)).toBe(clientOrderPayloadHash({ ...body, clientRevision: 99, intent: 'SAVE', integrity: {} }));
  expect(clientOrderPayloadHash(body)).not.toBe(clientOrderPayloadHash({ ...body, saveReason: 'autosave' }));
});
