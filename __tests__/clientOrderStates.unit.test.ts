jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  order: { findMany: jest.fn() }, clientOrderSubmission: { findMany: jest.fn() },
} }));
import prisma from '../src/prisma/client';
import { getClientOrderStates, clientOrderStatesSchema } from '../src/modules/clientOrders/clientOrderStates';
import { submissionPayloadHash } from '../src/modules/clientOrders/clientOrderSubmissions';
import { clientOrderPayloadHash } from '../src/modules/clientOrders/acceptedClientOperation';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';

const payload = { clientRevision: 1, intent: 'SUBMIT', organizationGuid: 'org', counterpartyGuid: 'customer',
  items: [{ lineGuid: 'line-12345678', productGuid: 'product', quantity: 1, basePrice: 1350 }] };
const order = { guid: 'order-guid', clientOrderId: 'client-id', clientRevision: 1, createdByUserId: 98,
  source: 'MANAGER_APP', revision: 5, status: 'CONFIRMED', syncState: 'SYNCED', number1c: 'ИПУТ-011129',
  isPostedIn1c: true, hasRealization: true, totalAmount: 1350, lastExportError: null, last1cError: null,
  cancelRequestedAt: null, clientPayloadHash: clientOrderPayloadHash(clientOrderMutationSchema.parse(payload)), _count: { items: 2 } };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(prisma.order.findMany).mockResolvedValue([order] as any);
  jest.mocked(prisma.clientOrderSubmission.findMany).mockResolvedValue([{ userId: 98, orderGuid: order.guid,
    clientOrderId: order.clientOrderId, clientRevision: 1, state: 'QUEUED', payload, payloadHash: submissionPayloadHash(payload) }] as any);
});
it('returns canonical SYNCED state, not the historical QUEUED receipt', async () => {
  const result = await getClientOrderStates(98, ['client-id'], ['client-id']);
  expect(result.items[0]).toMatchObject({ status: 'CONFIRMED', syncState: 'SYNCED', isPostedIn1c: true,
    number1c: 'ИПУТ-011129', itemsCount: 2, acceptedClientOperation: { clientRevision: 1, intent: 'SUBMIT' } });
  expect(result.items[0]).not.toHaveProperty('clientPayloadHash');
  expect(result.items[0]).not.toHaveProperty('items');
});
it('scopes both reads to authenticated owner and deduplicates identifiers', async () => {
  await getClientOrderStates(98, ['client-id', 'client-id', 'order-guid'], ['client-id']);
  expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, where: {
    createdByUserId: 98, source: 'MANAGER_APP', OR: [{ guid: { in: ['client-id', 'order-guid'] } },
      { clientOrderId: { in: ['client-id', 'order-guid'] } }],
  } }));
  expect(prisma.clientOrderSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 98 }) }));
});
it('never guesses proof for missing, rejected or corrupt receipts', async () => {
  jest.mocked(prisma.clientOrderSubmission.findMany).mockResolvedValue([]);
  expect((await getClientOrderStates(98, ['client-id'], ['client-id'])).items[0].acceptedClientOperation).toBeNull();
});
it('does not load historical payloads for ordinary status polling', async () => {
  await getClientOrderStates(98, ['client-id']);
  expect(prisma.clientOrderSubmission.findMany).not.toHaveBeenCalled();
});
it('returns nothing for unknown/foreign orders without a receipt read', async () => {
  jest.mocked(prisma.order.findMany).mockResolvedValue([]);
  expect(await getClientOrderStates(98, ['unknown-id'])).toEqual({ items: [] });
  expect(prisma.clientOrderSubmission.findMany).not.toHaveBeenCalled();
});
it.each([{ identifiers: [] }, { identifiers: Array(51).fill('client-id') }, { identifiers: ['client-id'], userId: 1 }])('rejects invalid or unbounded input', body => {
  expect(clientOrderStatesSchema.safeParse(body).success).toBe(false);
});
