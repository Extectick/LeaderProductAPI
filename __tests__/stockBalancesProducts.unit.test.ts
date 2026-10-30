import express from 'express';
import request from 'supertest';
import prisma from '../src/prisma/client';
import router, { listStockProducts, listWarehouseBalances, listSeriesBalances, stockProductsQuery, stockScope, stockMetrics, managerStockAvailability } from '../src/routes/stockBalancesProducts';
import { getOnecLpAppStock } from '../src/modules/onec/onec.lpApp.client';
import { getLiveProductsByGuids } from '../src/modules/clientOrders/clientOrders.onecLive';
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({ getLiveProductsByGuids: jest.fn() }));
jest.mock('../src/modules/onec/onec.lpApp.client', () => ({ getOnecLpAppStock: jest.fn() }));
jest.mock('../src/modules/clientOrders/stockWarehouseGroups', () => ({ enrichStockWarehouseGroups: jest.fn(async rows => rows) }));
import { enrichProductsWithImages } from '../src/modules/clientOrders/clientOrders.productImages';
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  product: { findMany: jest.fn() }, stockBalance: { findMany: jest.fn() }, priceType: { findMany: jest.fn() }, productPrice: { findMany: jest.fn() },
  warehouse: { findMany: jest.fn() }, organization: { findMany: jest.fn() }, $queryRaw: jest.fn(),
  employeeProfile: { findUnique: jest.fn() }, managerStockReservation: { groupBy: jest.fn() },
} }));
jest.mock('../src/modules/clientOrders/clientOrders.productImages', () => ({ enrichProductsWithImages: jest.fn(async rows => rows) }));
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => req.headers.authorization ? next() : res.sendStatus(401),
  authorizePermissions: () => (req: any, res: any, next: any) => req.headers['x-test-permission'] === 'yes' ? next() : res.sendStatus(403),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/middleware/serviceAccess', () => ({ authorizeServiceAccess: () => (_req: any, _res: any, next: any) => next() }));
const app = express().use(router);
const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(() => { jest.clearAllMocks(); jest.mocked(getLiveProductsByGuids).mockResolvedValue([]); jest.mocked(prisma.priceType.findMany).mockResolvedValue([]); jest.mocked(prisma.productPrice.findMany).mockResolvedValue([]); });
it('never converts an oversubscribed personal reserve into physical stock', () => {
  expect(managerStockAvailability(stockMetrics({ quantity: 3, reserved: 25, available: 0 }), 25)).toBe(3);
  expect(managerStockAvailability(stockMetrics({ quantity: 9, reserved: 6, available: 3 }), 6)).toBe(9);
  expect(managerStockAvailability(stockMetrics({ quantity: 13, reserved: 25, shipping: 10, available: 0 }), 25)).toBe(3);
});
it('validates bounds, GUIDs and search types instead of allowing unbounded scans', () => {
  expect(stockProductsQuery.parse({}).limit).toBe(30);
  for (const value of [{ limit: 101 }, { offset: -1 }, { offset: 'bad' }, { search: ['a'] }, { search: 'a'.repeat(201) }, { warehouseGuid: 'bad' }]) {
    expect(stockProductsQuery.safeParse(value).success).toBe(false);
  }
  expect(stockScope(stockProductsQuery.parse({ warehouseGuid: guid, organizationGuid: guid }))).toEqual({ warehouse: { guid }, organization: { guid } });
});
it('preserves zero and legacy null stock semantics', () => {
  expect(stockMetrics({ quantity: '10.5', reserved: '2.25' })).toMatchObject({ inStock: 10.5, available: 8.25 });
  expect(stockMetrics({ quantity: 10, available: 0, inStock: 0 })).toMatchObject({ available: 0, inStock: 0 });
});
it('accepts multiple warehouses, deduplicates scope and rejects malformed or oversized lists', () => {
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  expect(stockScope(stockProductsQuery.parse({ warehouseGuids: `${guid},${second},${guid}` }))).toEqual({ warehouse: { guid: { in: [guid, second] } } });
  for (const warehouseGuids of ['', `${guid},bad`, Array(101).fill(guid).join(',')]) {
    expect(stockProductsQuery.safeParse({ warehouseGuids }).success).toBe(false);
  }
});
it('fetches at most limit+1 products and aggregates only returned IDs without lazy 1C calls', async () => {
  jest.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'p1', guid, name: 'Угорь' }, { id: 'p2', guid: 'next' }] as any);
  jest.mocked(prisma.$queryRaw).mockResolvedValue([{ productId: 'p1', quantity: '12', available: '3', updatedAt: new Date() }]);
  const result = await listStockProducts(stockProductsQuery.parse({ limit: 1, offset: 5, search: 'Угорь 2033', warehouseGuid: guid }));
  expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 2, orderBy: [{ name: 'asc' }, { id: 'asc' }] }));
  const sql = jest.mocked(prisma.$queryRaw).mock.calls[0][0] as any;
  expect(sql.values).toEqual(['p1', guid]);
  expect(result).toMatchObject({ hasMore: true, nextOffset: 6, items: [{ guid, available: 3 }] });
  expect(enrichProductsWithImages).toHaveBeenCalledWith(expect.any(Array), { lazySyncMissing: false });
});
it('skips aggregate and image work on an empty product page', async () => {
  jest.mocked(prisma.product.findMany).mockResolvedValue([]);
  const result = await listStockProducts(stockProductsQuery.parse({}));
  expect(result.items).toEqual([]); expect(result.hasMore).toBe(false); expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
it('requires authentication and permission on every new endpoint', async () => {
  for (const path of ['/filters', '/products', `/products/${guid}/balances`, `/products/${guid}/movements`]) {
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set('Authorization', 'test')).status).toBe(403);
  }
  expect(prisma.product.findMany).not.toHaveBeenCalled();
});
it('rejects invalid parameters without touching the database', async () => {
  expect((await request(app).get('/products?limit=10000').set('Authorization', 'test').set('x-test-permission', 'yes')).status).toBe(400);
  expect(prisma.product.findMany).not.toHaveBeenCalled();
});
it('bounds series details and preserves nullable organization and unit-independent metrics', async () => {
  jest.mocked(prisma.stockBalance.findMany).mockResolvedValue([{ id: 's1', quantity: '5', reserved: '2', updatedAt: new Date(), warehouse: { guid, name: 'Омск' }, organization: null }, { id: 's2' }] as any);
  const response = await request(app).get(`/products/${guid}/balances?limit=1`).set('Authorization', 'test').set('x-test-permission', 'yes');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ hasMore: true, nextOffset: 1, items: [{ id: 's1', available: 3, organization: null }] });
  expect(prisma.stockBalance.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: { product: { guid } } }));
});
it('uses only the authenticated manager personal reserve and keeps legacy free stock intact', async () => {
  jest.mocked(prisma.employeeProfile.findUnique).mockResolvedValue({ onecUserGuid: 'manager-1' } as any);
  jest.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'p1', guid, name: 'Товар' }] as any);
  jest.mocked(prisma.$queryRaw).mockResolvedValue([{ productId: 'p1', quantity: 10, reserved: 7, available: 3 }]);
  jest.mocked(prisma.managerStockReservation.groupBy).mockResolvedValue([{ productId: 'p1', warehouseId: 'w1', _sum: { reserved: 6 } }] as any);
  const result = await listStockProducts(stockProductsQuery.parse({}), 42);
  expect(result.items[0]).toMatchObject({ available: 3, myReserved: 6, availableForManager: 9 });
  expect(prisma.employeeProfile.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 42 } }));
  expect(prisma.managerStockReservation.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ managerGuid: 'manager-1' }) }));
});
it('groups warehouse totals without organizations and never calls 1C for the default view', async () => {
  jest.mocked(prisma.$queryRaw).mockResolvedValue([{ warehouseId: 'w1', guid, name: 'Омск', quantity: 12, reserved: 2, available: 10 }]);
  const result = await listWarehouseBalances(guid, stockProductsQuery.parse({ groupByWarehouse: '1' }));
  expect(result.items[0]).toMatchObject({ id: guid, warehouse: { name: 'Омск' }, inStock: 12, reserved: 2, myReserved: 0 });
  expect(result.items[0]).not.toHaveProperty('organization'); expect(getOnecLpAppStock).not.toHaveBeenCalled();
});
it('reads series live on each request without persistence and rejects legacy non-series responses', async () => {
  jest.mocked(prisma.employeeProfile.findUnique).mockResolvedValue({ onecUserGuid: 'manager-1' } as any);
  const response = { version: 'stock-series-v1', hasMore: false, items: [{ id: 'series', warehouse: { guid, name: 'Омск' },
    seriesGuid: guid, seriesNumber: '123', expiresAt: '2027-01-01', productionDate: null, inStock: 7, reserved: 1, myReserved: 1, available: 7 }] };
  jest.mocked(getOnecLpAppStock).mockResolvedValue(response as any);
  const query = stockProductsQuery.parse({ bySeries: '1', warehouseGuids: guid });
  for (let i = 0; i < 2; i++) expect((await listSeriesBalances(guid, query, 42)).items[0]).toMatchObject({ inStock: 7, available: 6, availableForManager: 7 });
  expect(getOnecLpAppStock).toHaveBeenCalledTimes(2);
  expect(getOnecLpAppStock).toHaveBeenCalledWith(expect.objectContaining({ managerGuid: 'manager-1', bySeries: '1' }));
  jest.mocked(getOnecLpAppStock).mockResolvedValue({ items: [] } as any);
  await expect(listSeriesBalances(guid, query, 42)).rejects.toThrow();
});
