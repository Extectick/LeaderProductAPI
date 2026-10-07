import { applyCounterpartyAddresses } from '../src/modules/onec/onec.deliveryAddresses';
import { counterpartiesBatchSchema } from '../src/modules/onec/onec.schemas';

const tx = { deliveryAddress: { upsert: jest.fn(), create: jest.fn(), updateMany: jest.fn() } };
const date = new Date('2026-10-07T06:00:00Z');
const item = { guid: 'client', name: 'Client', addressesComplete: true,
  addresses: [{ guid: 'partner:address', name: 'Delivery', fullAddress: 'Street 1', comment: '10–18', kindName: 'Адрес доставки 2' }] };
beforeEach(() => jest.clearAllMocks());

test('preserves 1C address identifiers and metadata, scoped to each counterparty', async () => {
  await applyCounterpartyAddresses(tx as any, 'cp1', item, date);
  await applyCounterpartyAddresses(tx as any, 'cp2', item, date);
  expect(tx.deliveryAddress.upsert.mock.calls.map(([arg]) => arg.where)).toEqual([
    { counterpartyId_guid: { counterpartyId: 'cp1', guid: 'partner:address' } },
    { counterpartyId_guid: { counterpartyId: 'cp2', guid: 'partner:address' } },
  ]);
  expect(tx.deliveryAddress.upsert.mock.calls[0][0].create).toMatchObject({ comment: '10–18', kindName: 'Адрес доставки 2' });
  expect(tx.deliveryAddress.updateMany.mock.calls[0][0].where).toEqual({ counterpartyId: 'cp1', isActive: true,
    OR: [{ guid: null }, { guid: { notIn: ['partner:address'] } }] });
});

test('an authoritative empty list deactivates addresses, without deleting referenced rows', async () => {
  await applyCounterpartyAddresses(tx as any, 'cp', { ...item, addresses: [] }, date);
  expect(tx.deliveryAddress.upsert).not.toHaveBeenCalled();
  expect(tx.deliveryAddress.updateMany).toHaveBeenCalledWith({ where: { counterpartyId: 'cp', isActive: true },
    data: { isActive: false, isDefault: false, sourceUpdatedAt: date, lastSyncedAt: date } });
});

test('legacy omitted, empty and partial lists do not invalidate other addresses', async () => {
  for (const addresses of [undefined, [], item.addresses]) {
    await applyCounterpartyAddresses(tx as any, 'cp', { ...item, addressesComplete: undefined, addresses }, date);
  }
  expect(tx.deliveryAddress.updateMany).not.toHaveBeenCalled();
});

test('malformed complete snapshots are rejected before changing anything', async () => {
  for (const addresses of [undefined, [{ fullAddress: 'Street' }]]) {
    await expect(applyCounterpartyAddresses(tx as any, 'cp', { ...item, addresses }, date)).rejects.toThrow('Incomplete');
    expect(counterpartiesBatchSchema.safeParse({ secret: 'test', items: [{ ...item, addresses }] }).success).toBe(false);
  }
  expect(tx.deliveryAddress.upsert).not.toHaveBeenCalled();
  expect(tx.deliveryAddress.updateMany).not.toHaveBeenCalled();
});

test('the exchange schema accepts complete, empty and legacy address snapshots', () => {
  for (const row of [item, { ...item, addresses: [] }, { guid: 'client', name: 'Client' }]) {
    expect(counterpartiesBatchSchema.safeParse({ secret: 'test', items: [row] }).success).toBe(true);
  }
});

test('a deleted counterparty cannot reactivate an address', async () => {
  await applyCounterpartyAddresses(tx as any, 'cp', { ...item, isActive: false }, date);
  expect(tx.deliveryAddress.upsert.mock.calls[0][0].update.isActive).toBe(false);
});

test('a failed upsert does not run stale-address removal', async () => {
  tx.deliveryAddress.upsert.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(applyCounterpartyAddresses(tx as any, 'cp', item, date)).rejects.toThrow('database unavailable');
  expect(tx.deliveryAddress.updateMany).not.toHaveBeenCalled();
});
