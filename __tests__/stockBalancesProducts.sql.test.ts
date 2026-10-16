import { Client } from 'pg';
import prisma from '../src/prisma/client';
import { listStockProducts, listWarehouseBalances, stockProductsQuery } from '../src/routes/stockBalancesProducts';
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { product: { findMany: jest.fn() }, $queryRaw: jest.fn() } }));
jest.mock('../src/modules/clientOrders/clientOrders.productImages', () => ({ enrichProductsWithImages: async (rows: unknown) => rows }));
// Only disposable TEMP tables in the explicitly isolated local test database.
const db = new Client({ host: '127.0.0.1', port: 54329, database: 'LeaderAPI_test', user: 'postgres', password: 'postgres' });
beforeAll(async () => {
  await db.connect();
  await db.query(`CREATE TEMP TABLE "Warehouse" (id text, guid text);
    CREATE TEMP TABLE "Product" (id text, guid text);
    INSERT INTO "Product" VALUES ('p1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    CREATE TEMP TABLE "Organization" (id text, guid text);
    CREATE TEMP TABLE "StockBalance" ("productId" text, "warehouseId" text, "organizationId" text,
      quantity numeric, reserved numeric, "inStock" numeric, available numeric, shipping numeric,
      "clientReserved" numeric, "managerReserved" numeric, "lastSyncedAt" timestamp, "updatedAt" timestamp);
    INSERT INTO "Warehouse" VALUES ('w1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('w2','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    INSERT INTO "Organization" VALUES ('o1','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    INSERT INTO "StockBalance" VALUES
      ('p1','w1','o1',10,2,NULL,NULL,1,1,1,'2026-10-13','2026-10-12'),
      ('p1','w1','o1',3.5,1,3.5,0,0,1,0,NULL,'2026-10-11'),
      ('p1','w2',NULL,100,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-10-10'),
      ('p2','w1','o1',999,0,999,999,0,0,0,NULL,'2026-10-10');`);
  await db.query(`ALTER TABLE "Warehouse" ADD COLUMN name text; UPDATE "Warehouse" SET name=id;
    INSERT INTO "Organization" VALUES ('o2','dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    INSERT INTO "StockBalance" VALUES ('p1','w1','o2',2,1,2,1,0,1,0,NULL,'2026-10-10');`);
  jest.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'p1', guid: 'product', name: 'Тест' }] as any);
  (prisma.$queryRaw as jest.Mock).mockImplementation(async (sql: any) => (await db.query(sql.text, sql.values)).rows);
});
afterAll(async () => { await db.end(); });
it('executes the actual parameterized aggregation with warehouse, organization and nullable fallback semantics', async () => {
  const scoped = await listStockProducts(stockProductsQuery.parse({ warehouseGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', organizationGuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));
  expect(scoped.items[0]).toMatchObject({ quantity: 13.5, inStock: 13.5, available: 8, reserved: 3, shipping: 1 });
  const all = await listStockProducts(stockProductsQuery.parse({}));
  expect(all.items[0]).toMatchObject({ quantity: 115.5, available: 109 });
  const multi = await listStockProducts(stockProductsQuery.parse({ warehouseGuids: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb,aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  expect(multi.items[0]).toMatchObject({ quantity: 115.5, available: 109 });
  expect(new Date(all.items[0].updatedAt!).getTime()).toBe(new Date(2026, 9, 13).getTime());
});
it('adds two organizations into one warehouse row, never duplicates the warehouse total', async () => {
  const result = await listWarehouseBalances('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', stockProductsQuery.parse({ groupByWarehouse: '1' }));
  expect(result.items).toHaveLength(2);
  expect(result.items[0]).toMatchObject({ inStock: 15.5, reserved: 4, available: 9 });
});
