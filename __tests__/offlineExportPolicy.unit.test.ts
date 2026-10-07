jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({
  ClientOrdersError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
}));
jest.mock('../src/prisma/client', () => {
  const model = () => ({ findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), upsert: jest.fn(), update: jest.fn(), deleteMany: jest.fn() });
  return { __esModule: true, default: Object.fromEntries([
    'offlineExportPolicy', 'employeeProfile', 'counterparty', 'clientAgreement', 'clientContract',
    'deliveryAddress', 'priceType', 'sellingPrice', 'stockBalance', 'managerStockReservation',
    'organization', 'warehouse', 'offlineDatasetState', 'offlineDatasetChange', 'product',
    'catalogState', 'catalogChange', 'productImage', 'productPrice', 'offlineDatasetRow',
  ].map(key => [key, model()])) };
});
import prisma from '../src/prisma/client';
import { buildOfflinePolicy, priceTypeClosure, scopedEpoch, threeMonthsBefore, offlineExportPolicySchema } from '../src/modules/clientOrders/offlineExportPolicy';
import { getOfflineSnapshot, getOfflineChanges, itemsForEntity, itemKey } from '../src/modules/clientOrders/offlineClientOrders.service';
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
const source = (entity: Parameters<typeof itemsForEntity>[0], extra = {}) => itemsForEntity(entity, id(50), buildOfflinePolicy({ ...payload, ...extra }, today));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(new Date('2026-09-17T06:00:00Z'));
  jest.clearAllMocks();
  for (const model of Object.values(db).filter((item: any) => item?.findMany) as any[]) {
    model.findMany.mockResolvedValue([]); model.count.mockResolvedValue(0);
  }
  db.offlineExportPolicy.findUnique.mockResolvedValue({ payload });
  db.employeeProfile.findUnique.mockResolvedValue({ onecUserGuid: id(50) });
  db.offlineDatasetState.upsert.mockResolvedValue(state);
  db.catalogState.upsert.mockResolvedValue(state);
  db.clientAgreement.findMany.mockResolvedValue([{ priceType: { guid: id(10) } }]);
  db.$transaction = jest.fn(async (fn) => fn(db));
  db.offlineDatasetState.findUnique.mockResolvedValue({ ...state, scopeKey: `client-orders-v3:${id(50)}` });
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
  await source('counterparties');
  const where = db.counterparty.findMany.mock.calls[0][0].where;
  expect(where.OR).toContainEqual({ managerGuid: id(50) });
  expect(where.OR).toContainEqual({ contracts: { some: { managerGuid: id(50), isActive: true, status: 'Действует' } } });
  expect(where.OR).toContainEqual({ agreements: { some: { managerGuid: id(50), isActive: true, status: 'Действует' } } });
});

test('delivery addresses stay manager-scoped and shared partner addresses have distinct cursors', async () => {
  db.counterparty.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
  db.deliveryAddress.findMany.mockResolvedValue([
    { guid: 'partner:address', fullAddress: 'Street 1', comment: '10–18', counterparty: { guid: 'c1' } },
    { guid: 'partner:address', fullAddress: 'Street 1', counterparty: { guid: 'c2' } },
    { guid: 'partner:other', fullAddress: 'Street 2', counterparty: { guid: 'c2' } },
  ]);
  const addresses = await source('delivery-addresses');
  const materialized = addresses.map(item => ({ itemKey: itemKey('delivery-addresses', item), payload: item }));
  db.offlineDatasetRow.findMany.mockImplementation(async ({ where, take }: any) => materialized.filter(row => !where.itemKey || row.itemKey > where.itemKey.gt).slice(0, take));
  const first = await getOfflineSnapshot(7, 'delivery-addresses', { limit: 1 });
  const second = await getOfflineSnapshot(7, 'delivery-addresses', { limit: 1, cursor: first.nextCursor });
  const third = await getOfflineSnapshot(7, 'delivery-addresses', { limit: 1, cursor: second.nextCursor });
  expect(first.nextCursor).not.toBe(second.nextCursor);
  expect(first.items[0]).toMatchObject({ comment: '10–18', counterparty: { guid: 'c1' } });
  expect(second.items[0]).toMatchObject({ counterparty: { guid: 'c2' } });
  expect(third.hasMore).toBe(false);
  expect(db.deliveryAddress.findMany.mock.calls[0][0].where).toMatchObject({
    isActive: true, counterpartyId: { in: ['c1', 'c2'] }, guid: { not: null },
  });
  expect(db.offlineDatasetRow.findMany.mock.calls[0][0].where.scopeKey).toBe(`client-orders-v3:${id(50)}`);
  expect(db.employeeProfile.findUnique).toHaveBeenCalledWith({ where: { userId: 7 }, select: { onecUserGuid: true } });
});
test('price projection uses product and dependency filters', async () => {
  await source('selling-prices');
  const page = db.sellingPrice.findMany.mock.calls[0][0].where;
  expect(page.product.guid.in).toEqual([id(1)]);
  expect(page.priceType.guid.in).toEqual([id(10), id(11), id(12)]);
});
test('own reserves use the same allowed goods/warehouse/organization filter', async () => {
  db.offlineExportPolicy.findUnique.mockResolvedValue({ payload: { ...payload, stockOrganizationGuid: id(30) } });
  await source('manager-stock', { stockOrganizationGuid: id(30) });
  const where = db.managerStockReservation.findMany.mock.calls[0][0].where;
  expect(where.managerGuid).toBe(id(50));
  expect(where.product.guid.in).toEqual([id(1)]);
  expect(where.warehouse.guid.in).toEqual([id(31)]);
  expect(where.OR).toContainEqual({ organizationId: null });
});
test('stock uses the authoritative technical key, exposes warehouse-wide quantity and preserves delta identity', async () => {
  db.offlineExportPolicy.findUnique.mockResolvedValue({ payload: { ...payload, stockOrganizationGuid: id(30) } });
  const syncKey = `${id(1)}|${id(31)}|${id(30)}|`;
  db.stockBalance.findMany.mockResolvedValue([{ syncKey, productId: 'p1', quantity: 9, reserved: 6, available: 3, product: { guid: id(1) }, warehouse: { guid: id(31) }, organization: { guid: id(30) } }]);
  const items = await source('stock', { stockOrganizationGuid: id(30) });
  expect(db.stockBalance.findMany.mock.calls[0][0].where.OR).toEqual([{ organization: { is: { guid: id(30) } } }]);
  expect(items[0]).toMatchObject({ syncKey, organization: null, available: 3 });
  const phoneKey = `${id(1)}|${id(31)}||`;
  expect(itemKey('stock', items[0])).toBe(phoneKey);
  db.offlineDatasetChange.findMany.mockResolvedValue([{ revision: 5n, itemKey: phoneKey, operation: 'DELETE' }]);
  const changes = await getOfflineChanges(7, 'stock', { limit: 100, afterRevision: 4n, epoch: state.epoch });
  expect(changes.changes[0]).toMatchObject({ itemKey: phoneKey, operation: 'DELETE', item: null });
});
test('old scope epoch requires full replacement, not a delta retaining extra rows', async () => {
  await expect(getOfflineChanges(7, 'stock', { afterRevision: 0n, limit: 100, epoch: 'legacy-epoch' })).rejects.toMatchObject({ status: 409 });
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
