import { getCustomerPurchaseHistory, parsePurchaseHistory, purchaseHistoryQuerySchema } from '../src/modules/clientOrders/customerPurchaseHistory';
import { getOnecLpAppCounterpartyCard } from '../src/modules/onec/onec.lpApp.client';
jest.mock('../src/modules/onec/onec.lpApp.client', () => ({ getOnecLpAppCounterpartyCard: jest.fn() }));
jest.mock('../src/lib/redis', () => ({ cacheGet: jest.fn(async () => null), cacheSet: jest.fn(async () => undefined) }));
const context = { counterpartyGuid: '299c99f7-593e-11ef-8325-1c98ec138053', organizationGuid: 'dd57a5c7-0b23-11e8-8817-001e676f7f9b' };
const snapshot = { ...context, version: 'customer-purchases-v1', coverageFrom: '2026-03-31', asOf: '2026-10-09T18:00:00', items: [
  { productGuid: '575589f9-9b27-11ee-82cd-1c98ec138053', lastPurchasedDate: '2026-10-08' },
] };

it('validates context, version and complete unique calendar-date rows', () => {
  expect(parsePurchaseHistory(snapshot, context)).toMatchObject(snapshot);
  expect(parsePurchaseHistory({ ...snapshot, items: [] }, context).items).toEqual([]);
  for (const raw of [{}, { ...snapshot, version: 'old' }, { ...snapshot, organizationGuid: context.counterpartyGuid },
    { ...snapshot, items: [...snapshot.items, ...snapshot.items] },
    { ...snapshot, items: [{ ...snapshot.items[0], lastPurchasedDate: '2026-02-30' }] },
    { ...snapshot, items: [{ ...snapshot.items[0], lastPurchasedDate: '2026-03-30' }] },
    { ...snapshot, items: [{ ...snapshot.items[0], lastPurchasedDate: '2026-10-10' }] }]) {
    expect(() => parsePurchaseHistory(raw, context)).toThrow();
  }
  expect(purchaseHistoryQuerySchema.safeParse({ counterpartyGuid: context.counterpartyGuid }).success).toBe(false);
});

it('coalesces concurrent reads and caches by user and exact customer/organization context', async () => {
  jest.mocked(getOnecLpAppCounterpartyCard).mockResolvedValue(snapshot);
  const [a, b] = await Promise.all([getCustomerPurchaseHistory(context, 1), getCustomerPurchaseHistory(context, 1)]);
  expect(a).toEqual(b);
  expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(1);
  await getCustomerPurchaseHistory(context, 1);
  expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(1);
  await getCustomerPurchaseHistory(context, 2);
  expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(2);
  const other = { ...context, organizationGuid: context.counterpartyGuid };
  jest.mocked(getOnecLpAppCounterpartyCard).mockResolvedValue({ ...snapshot, ...other });
  await getCustomerPurchaseHistory(other, 1);
  expect(getOnecLpAppCounterpartyCard).toHaveBeenLastCalledWith({ ...other, mode: 'purchase-history' });
});
