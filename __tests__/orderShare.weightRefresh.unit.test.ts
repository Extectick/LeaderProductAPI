jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { orderShareLink: { updateMany: jest.fn(async () => ({ count: 1 })) } } }));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({ getLiveProductsByGuids: jest.fn() }));
import prisma from '../src/prisma/client';
import { getLiveProductsByGuids } from '../src/modules/clientOrders/clientOrders.onecLive';
import { refreshShareWeights, scheduleShareWeightRefresh } from '../src/modules/orderShare/orderShare.weightRefresh';
import { orderWeightKey, orderLineWeightKg } from '../src/modules/orderShare/orderShare.weights';
const piece = { guid: 'piece', symbol: 'шт' };
const item = { product: { guid: 'sauce', name: 'Соус', baseUnit: piece }, unit: piece, quantity: 3, price: 353 };
const order = { items: [item] };
const link = { id: 'weight-test', ownerId: 1, orderGuid: 'order', counterpartyGuid: 'customer', tokenHash: 'secret-hash', version: 'before', snapshot: {} } as any;
const write = jest.mocked(prisma.orderShareLink.updateMany);
const load = jest.mocked(getLiveProductsByGuids);
beforeEach(() => { jest.clearAllMocks(); delete process.env.ORDER_SHARE_WEIGHT_REFRESH_DISABLED; load.mockResolvedValue([{ guid: 'sauce', weight: 0.815, baseUnit: piece, packages: [] }] as any); });
test('refresh is one bounded reference-only batch and stores kg per unit with a fenced CAS', async () => {
  await refreshShareWeights(link, order);
  expect(load).toHaveBeenCalledWith({ productGuids: ['sauce'] }, { skipMissingDetails: true });
  const saved = write.mock.calls[0][0] as any;
  expect(saved.where).toMatchObject({ id: link.id, ownerId: 1, tokenHash: link.tokenHash, version: 'before', revokedAt: null });
  expect(saved.data.snapshot._weightReferences).toEqual({ [orderWeightKey(item)]: '0.815' });
  expect(orderLineWeightKg(item, saved.data.snapshot._weightReferences)).toBe('2.445');
  expect(saved.data.snapshot._weightCursor).toBe(0);
  await refreshShareWeights({ ...link, snapshot: saved.data.snapshot }, { items: [{ ...item, quantity: 5 }] });
  expect(load).toHaveBeenCalledTimes(1); // Changing quantity requires no new reference fetch.
});
test('an unavailable 1C does not erase the last known weight', async () => {
  load.mockRejectedValue(new Error('temporary 1C outage'));
  await expect(refreshShareWeights(link, order)).rejects.toThrow('temporary');
  expect(write).not.toHaveBeenCalled();
});
test('clears an explicitly removed weight, but preserves a missing/inactive reference snapshot', async () => {
  const cached = { ...link, snapshot: { _weightReferences: { [orderWeightKey(item)]: '0.815', obsolete: '999' } } };
  load.mockResolvedValueOnce([{ guid: 'sauce', weight: null, baseUnit: piece, packages: [] }] as any);
  await refreshShareWeights(cached, order);
  expect((write.mock.calls[0][0].data as any).snapshot._weightReferences).toEqual({});
  load.mockResolvedValueOnce([]);
  await refreshShareWeights(cached, order);
  expect((write.mock.calls[1][0].data as any).snapshot._weightReferences).toEqual({ [orderWeightKey(item)]: '0.815' });
});
test('large orders page through batches rather than fan out hundreds of 1C detail requests', async () => {
  const many = { items: Array.from({ length: 120 }, (_, index) => ({ ...item, product: { ...item.product, guid: String(index).padStart(3, '0') } })) };
  load.mockResolvedValue([]);
  await refreshShareWeights(link, many);
  const saved = (write.mock.calls[0][0].data as any).snapshot;
  expect(load.mock.calls[0][0].productGuids).toHaveLength(50);
  expect(saved._weightCursor).toBe(50);
  await refreshShareWeights({ ...link, snapshot: saved }, many);
  expect(load.mock.calls[1][0].productGuids[0]).toBe('050');
});
test('coalesces concurrent viewers, returns immediately, and retains a one-minute retry budget', async () => {
  let release!: () => void;
  load.mockImplementation(() => new Promise(resolve => { release = () => resolve([]); }));
  expect(scheduleShareWeightRefresh({ ...link, id: 'coalesced' }, order)).toBeUndefined();
  scheduleShareWeightRefresh({ ...link, id: 'coalesced' }, order);
  expect(load).toHaveBeenCalledTimes(1);
  release(); await new Promise(resolve => setImmediate(resolve));
  scheduleShareWeightRefresh({ ...link, id: 'coalesced' }, order);
  expect(load).toHaveBeenCalledTimes(1);
});
