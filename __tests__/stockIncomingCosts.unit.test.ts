import prisma from '../src/prisma/client';
import { withIncomingCosts } from '../src/modules/clientOrders/stockIncomingCosts';
import { ORDER_PICKER_RECEIPT_PRICE_TYPE_GUID } from '../src/modules/clientOrders/receiptPriceSource';
import { getLiveProductsByGuids } from '../src/modules/clientOrders/clientOrders.onecLive';
import { readThroughClientOrdersCache } from '../src/modules/clientOrders/clientOrders.cache';

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: { productPrice: { findMany: jest.fn() } },
}));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({ getLiveProductsByGuids: jest.fn() }));
jest.mock('../src/modules/clientOrders/clientOrders.cache', () => ({
  CLIENT_ORDERS_CACHE_TTL: { productsBatch: 15 },
  readThroughClientOrdersCache: jest.fn((_scope, _key, _ttl, load) => load()),
}));

const syncedAt = new Date('2026-10-30T03:46:08.384Z');
const priceRow = (price: unknown = '2065.0000') => ({
  product: { guid: 'rice' }, price, currency: 'RUB', sourceUpdatedAt: syncedAt, updatedAt: syncedAt,
});

beforeEach(() => {
  jest.useFakeTimers({ now: syncedAt.getTime() + 1000 });
  jest.clearAllMocks();
  jest.mocked(prisma.productPrice.findMany).mockReset();
  jest.mocked(getLiveProductsByGuids).mockReset().mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

it('uses the order-picker source even when another price type has the same name and a later start date', async () => {
  // Actual Hansey case: the technical current-cost cache has an epoch start;
  // the unrelated 1C price type has a September start and must not outrank it.
  const candidates = [
    { ...priceRow('2173.6000'), startDate: new Date('2026-09-30T00:00:02Z'),
      priceType: { guid: 'b30b2b35-7de5-11e4-a03f-001e676f7f9b', name: 'ЦенаПоступления', isActive: true } },
    { ...priceRow(), startDate: new Date(0),
      priceType: { guid: ORDER_PICKER_RECEIPT_PRICE_TYPE_GUID, name: 'ЦенаПоступления', isActive: true } },
  ];
  jest.mocked(prisma.productPrice.findMany).mockImplementation((query: any) =>
    Promise.resolve(candidates.filter(row => row.priceType.guid === query.where.priceType.guid
      && row.priceType.isActive === query.where.priceType.isActive)) as any);

  const result = await withIncomingCosts([{ guid: 'rice', name: 'Hansey 25 кг' }]);
  expect(result[0]).toMatchObject({ name: 'Hansey 25 кг', incomingCost: {
    price: 2065, currency: 'RUB', source: 'RECEIPT_PRICE', updatedAt: syncedAt,
  } });
  expect(getLiveProductsByGuids).not.toHaveBeenCalled();
});

it('loads one bounded batch for a page and preserves duplicate and unpriced items', async () => {
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([priceRow()] as any);
  const result = await withIncomingCosts([{ guid: 'rice' }, { guid: 'missing' }, { guid: 'rice' }]);
  expect(result.map(row => row.incomingCost?.price ?? null)).toEqual([2065, null, 2065]);
  expect(prisma.productPrice.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.productPrice.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      isActive: true,
      product: { guid: { in: ['rice', 'missing'] } },
      priceType: { guid: ORDER_PICKER_RECEIPT_PRICE_TYPE_GUID, isActive: true },
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: expect.any(Date) } }] },
        { OR: [{ endDate: null }, { endDate: { gte: expect.any(Date) } }] },
      ],
    }),
    distinct: ['productId'],
  }));
  expect(getLiveProductsByGuids).toHaveBeenCalledWith({ productGuids: ['missing'] }, { skipMissingDetails: true });
});

it.each([0, -1, 'NaN', 'Infinity'])('does not turn an unavailable cost (%s) into a usable price', async price => {
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([priceRow(price)] as any);
  expect((await withIncomingCosts([{ guid: 'rice' }]))[0].incomingCost).toBeNull();
});

it('does not substitute a same-named price when the canonical source is absent or inactive', async () => {
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([]);
  expect((await withIncomingCosts([{ guid: 'rice' }]))[0].incomingCost).toBeNull();
  expect(prisma.productPrice.findMany).toHaveBeenCalledTimes(1);
});

it('fills never-materialized products from the picker receiptPrice, not its selling price, in one cached batch', async () => {
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([]);
  jest.mocked(getLiveProductsByGuids).mockResolvedValue([
    { guid: 'rice', isActive: true, receiptPrice: 2065, basePrice: 3000, currency: 'RUB' },
    { guid: 'missing', isActive: true, receiptPrice: null, basePrice: 2173.6, currency: 'RUB' },
    { guid: 'inactive', isActive: false, receiptPrice: 100, currency: 'RUB' },
    { guid: 'unrequested', isActive: true, receiptPrice: 200, currency: 'RUB' },
  ] as any);
  const result = await withIncomingCosts([{ guid: 'rice' }, { guid: 'missing' }, { guid: 'inactive' }, { guid: 'rice' }]);
  expect(result.map(item => item.incomingCost?.price ?? null)).toEqual([2065, null, null, 2065]);
  expect(getLiveProductsByGuids).toHaveBeenCalledTimes(1);
  expect(readThroughClientOrdersCache).toHaveBeenCalledWith('stock-incoming-costs',
    { productGuids: ['inactive', 'missing', 'rice'] }, 15, expect.any(Function));
});

it('keeps known costs and stock rows when the missing-cost batch fails', async () => {
  jest.setSystemTime(syncedAt.getTime() + 60_000);
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([priceRow()] as any);
  jest.mocked(getLiveProductsByGuids).mockRejectedValue(new Error('1C unavailable'));
  expect(await withIncomingCosts([{ guid: 'rice', quantity: 20 }, { guid: 'missing', quantity: 7 }]))
    .toMatchObject([{ quantity: 20, incomingCost: { price: 2065 } }, { quantity: 7, incomingCost: null }]);
});

it('refreshes an old materialized cost without waiting for another order to be created', async () => {
  jest.setSystemTime(syncedAt.getTime() + 60_000);
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([priceRow()] as any);
  jest.mocked(getLiveProductsByGuids).mockResolvedValue([
    { guid: 'rice', isActive: true, receiptPrice: 2040, basePrice: 3000, currency: 'RUB' },
  ] as any);
  const [rice] = await withIncomingCosts([{ guid: 'rice' }]);
  expect(rice.incomingCost).toMatchObject({ price: 2040, updatedAt: new Date() });
  expect(getLiveProductsByGuids).toHaveBeenCalledTimes(1);
});

it.each([0, null])('does not resurrect an old cost after 1C confirms an unavailable current cost (%s)', async price => {
  jest.setSystemTime(syncedAt.getTime() + 60_000);
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([priceRow()] as any);
  jest.mocked(getLiveProductsByGuids).mockResolvedValue([
    { guid: 'rice', isActive: true, receiptPrice: price, basePrice: 3000, currency: 'RUB' },
  ] as any);
  expect((await withIncomingCosts([{ guid: 'rice' }]))[0].incomingCost).toBeNull();
});

it('retains source freshness and the existing default currency', async () => {
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([
    { ...priceRow(), currency: null, sourceUpdatedAt: null },
  ] as any);
  expect((await withIncomingCosts([{ guid: 'rice' }]))[0].incomingCost)
    .toMatchObject({ price: 2065, currency: 'RUB', updatedAt: syncedAt });
});

it('does not query for an empty page', async () => {
  expect(await withIncomingCosts([])).toEqual([]);
  expect(prisma.productPrice.findMany).not.toHaveBeenCalled();
  expect(getLiveProductsByGuids).not.toHaveBeenCalled();
});
