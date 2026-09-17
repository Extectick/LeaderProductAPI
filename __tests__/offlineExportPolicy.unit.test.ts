jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({
  ClientOrdersError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
}));
jest.mock('../src/prisma/client', () => {
  const model = () => ({ findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), upsert: jest.fn(), update: jest.fn(), deleteMany: jest.fn() });
  return { __esModule: true, default: Object.fromEntries([
    'offlineExportPolicy', 'employeeProfile', 'counterparty', 'clientAgreement', 'clientContract',
    'deliveryAddress', 'priceType', 'sellingPrice', 'stockBalance', 'managerStockReservation',
    'organization', 'warehouse', 'offlineDatasetState', 'offlineDatasetChange', 'product',
    'catalogState', 'catalogChange', 'productImage', 'productPrice',
  ].map(key => [key, model()])) };
});
import prisma from '../src/prisma/client';
import { buildOfflinePolicy, priceTypeClosure, scopedEpoch, threeMonthsBefore, offlineExportPolicySchema } from '../src/modules/clientOrders/offlineExportPolicy';
import { getOfflineSnapshot, getOfflineChanges, getOfflineManifest } from '../src/modules/clientOrders/offlineClientOrders.service';
import { getCatalogSnapshot, getCatalogChanges } from '../src/modules/catalog/catalog.service';

const db = prisma as any;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const today = '2026-09-17';
const payload = {
  asOfDate: today, products: [{ guid: id(1), lastMovementDate: '2026-06-17' }, { guid: id(2), lastMovementDate: '2026-06-16' }],
  priceTypes: [{ guid: id(10), dependencies: [id(11)] }, { guid: id(11), dependencies: [id(12)] }, { guid: id(12), dependencies: [id(10)] }],
  organizationGuids: [id(30)], warehouseGuids: [id(31)],
};
const state = { epoch: id(99), currentRevision: 5n, minAvailableRevision: 0n, schemaVersion: 1, lastSourceUpdateAt: null, lastFullReconcileAt: new Date() };

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(new Date('2026-09-17T06:00:00Z'));
  jest.clearAllMocks();
  for (const model of Object.values(db) as any[]) {
    model.findMany.mockResolvedValue([]); model.count.mockResolvedValue(0);
  }
  db.offlineExportPolicy.findUnique.mockResolvedValue({ payload });
  db.employeeProfile.findUnique.mockResolvedValue({ onecUserGuid: id(50) });
  db.offlineDatasetState.upsert.mockResolvedValue(state);
  db.catalogState.upsert.mockResolvedValue(state);
  db.clientAgreement.findMany.mockResolvedValue([{ priceType: { guid: id(10) } }]);
});
afterEach(() => jest.useRealTimers());

test('three calendar months clamp at month end, including leap years', () => {
  expect(threeMonthsBefore('2026-05-31')).toBe('2026-02-28');
  expect(threeMonthsBefore('2024-05-31')).toBe('2024-02-29');
  expect(threeMonthsBefore(today)).toBe('2026-06-17');
});
test('includes the boundary, excludes older/future movements and removes duplicates', () => {
  const policy = buildOfflinePolicy({ ...payload, products: [...payload.products, payload.products[0], { guid: id(3), lastMovementDate: '2026-09-18' }] }, today);
  expect(policy.productGuids).toEqual([id(1)]);
});
test('dependency closure is transitive, cycle-safe and excludes unrelated price types', () => {
  expect(priceTypeClosure([id(10)], payload.priceTypes)).toEqual([id(10), id(11), id(12)]);
  expect(priceTypeClosure([], payload.priceTypes)).toEqual([]);
});
test('epoch stays stable for identical data but changes at expiry without a 1C update', () => {
  const first = buildOfflinePolicy(payload, today);
  expect(scopedEpoch(state.epoch, first)).toBe(scopedEpoch(state.epoch, buildOfflinePolicy({ ...payload, products: [...payload.products].reverse() }, today)));
  expect(scopedEpoch(state.epoch, first)).not.toBe(scopedEpoch(state.epoch, buildOfflinePolicy(payload, '2026-09-18')));
  expect(scopedEpoch(state.epoch, null)).toBe(state.epoch);
  expect(scopedEpoch(state.epoch, first, id(50))).not.toBe(scopedEpoch(state.epoch, first, id(51)));
});
test('rejects invalid calendar dates and non-GUID identifiers', () => {
  expect(offlineExportPolicySchema.safeParse({ ...payload, asOfDate: '2026-02-30' }).success).toBe(false);
  expect(offlineExportPolicySchema.safeParse({ ...payload, warehouseGuids: ['bad'] }).success).toBe(false);
});
test('counterparties are scoped to authenticated manager and active contracts/agreements', async () => {
  await getOfflineSnapshot(7, 'counterparties', { limit: 100 });
  expect(db.employeeProfile.findUnique).toHaveBeenCalledWith({ where: { userId: 7 }, select: { onecUserGuid: true } });
  const where = db.counterparty.findMany.mock.calls[0][0].where;
  expect(where.OR).toContainEqual({ managerGuid: id(50) });
  expect(where.OR).toContainEqual({ contracts: { some: { managerGuid: id(50), isActive: true, status: 'Действует' } } });
  expect(where.OR).toContainEqual({ agreements: { some: { managerGuid: id(50), isActive: true, status: 'Действует' } } });
});
test('price snapshot and count use identical product and dependency filters', async () => {
  await getOfflineSnapshot(7, 'selling-prices', { limit: 100 });
  const count = db.sellingPrice.count.mock.calls[0][0].where;
  const page = db.sellingPrice.findMany.mock.calls[0][0].where;
  expect(page).toEqual(count);
  expect(page.product.guid.in).toEqual([id(1)]);
  expect(page.priceType.guid.in).toEqual([id(10), id(11), id(12)]);
});
test('own reserves use the same allowed goods/warehouse/organization filter', async () => {
  await getOfflineSnapshot(7, 'manager-stock', { limit: 100 });
  const where = db.managerStockReservation.findMany.mock.calls[0][0].where;
  expect(where.managerGuid).toBe(id(50));
  expect(where.product.guid.in).toEqual([id(1)]);
  expect(where.warehouse.guid.in).toEqual([id(31)]);
});
test('old scope epoch requires full replacement, not a delta retaining extra rows', async () => {
  await expect(getOfflineChanges(7, 'stock', { afterRevision: 0n, limit: 100, epoch: state.epoch })).rejects.toMatchObject({ status: 409 });
  expect(db.offlineDatasetChange.findMany).not.toHaveBeenCalled();
});
test('catalog snapshots intersect cursor and recent-movement scope', async () => {
  await getCatalogSnapshot({ limit: 100, cursor: id(0) });
  expect(db.product.findMany.mock.calls[0][0].where).toEqual({ isActive: true, guid: { in: [id(1)], gt: id(0) } });
});
test('catalog deltas delete out-of-scope products without deleting shared API records', async () => {
  db.catalogChange.findMany.mockResolvedValue([{ productGuid: id(2), revision: 5n }]);
  db.product.findMany.mockResolvedValue([{ guid: id(2), isActive: true }]);
  const result = await getCatalogChanges({ afterRevision: '4', limit: 100 });
  expect(result.changes).toEqual([{ revision: '5', productGuid: id(2), operation: 'DELETE', item: null }]);
  expect(db.product.deleteMany).not.toHaveBeenCalled();
});
