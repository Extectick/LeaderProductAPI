import prisma from '../../prisma/client';
import { ORDER_PICKER_RECEIPT_PRICE_TYPE_GUID } from './receiptPriceSource';
import { getLiveProductsByGuids } from './clientOrders.onecLive';
import { CLIENT_ORDERS_CACHE_TTL, readThroughClientOrdersCache } from './clientOrders.cache';

export type IncomingCost = { price: number; currency: string; source: 'RECEIPT_PRICE'; updatedAt: Date | null };

/** Use the picker's current receiptPrice, in storage units, with its short cache TTL. */
export async function withIncomingCosts<T extends { guid: string }>(items: T[]): Promise<Array<T & { incomingCost: IncomingCost | null }>> {
  if (!items.length) return [];
  const at = new Date();
  const rows = await prisma.productPrice.findMany({
    where: { isActive: true, product: { guid: { in: [...new Set(items.map(item => item.guid))] } },
      priceType: { guid: ORDER_PICKER_RECEIPT_PRICE_TYPE_GUID, isActive: true },
      AND: [{ OR: [{startDate:null},{startDate:{lte:at}}] },{ OR: [{endDate:null},{endDate:{gte:at}}] }] },
    orderBy: [{productId:'asc'},{startDate:{sort:'desc',nulls:'last'}},{sourceUpdatedAt:{sort:'desc',nulls:'last'}},{createdAt:'desc'},{id:'desc'}],
    distinct: ['productId'], select: { product: { select: { guid: true } }, price: true, currency: true, sourceUpdatedAt: true, updatedAt: true },
  });
  const costs = new Map<string, IncomingCost | null>();
  for (const row of rows) {
    const price = Number(row.price);
    costs.set(row.product.guid, Number.isFinite(price) && price > 0
      ? { price, currency: row.currency || 'RUB', source: 'RECEIPT_PRICE', updatedAt: row.sourceUpdatedAt ?? row.updatedAt } : null);
  }

  // Order materialization is not a price synchronization schedule. Refresh stale
  // copies as well as missing ones, so a new supplier price does not require a
  // manager to create another order before it appears in the stock browser.
  const freshAfter = at.getTime() - CLIENT_ORDERS_CACHE_TTL.productsBatch * 1000;
  const refreshGuids = [...new Set(items.map(item => item.guid))].filter(guid => {
    const cost = costs.get(guid);
    return !cost || !cost.updatedAt || cost.updatedAt.getTime() < freshAfter;
  }).sort();
  if (refreshGuids.length) {
    try {
      const result = await readThroughClientOrdersCache(
        'stock-incoming-costs', { productGuids: refreshGuids }, CLIENT_ORDERS_CACHE_TTL.productsBatch,
        async () => ({
          items: await getLiveProductsByGuids({ productGuids: refreshGuids }, { skipMissingDetails: true }),
          checkedAt: new Date().toISOString(),
        })
      );
      const requested = new Set(refreshGuids);
      // A successful fresh read can revoke a previously known cost, too.
      for (const guid of requested) costs.set(guid, null);
      for (const product of result.items) {
        if (!requested.has(product.guid) || !product.isActive) continue;
        const price = Number(product.receiptPrice);
        if (!Number.isFinite(price) || price <= 0) continue;
        costs.set(product.guid, { price, currency: product.currency || 'RUB', source: 'RECEIPT_PRICE',
          updatedAt: new Date(result.checkedAt) });
      }
    } catch {
      // Stock browsing and known source timestamps remain available while 1C is
      // offline. Missing prices stay unavailable, never another source or zero.
    }
  }
  return items.map(item => ({ ...item, incomingCost: costs.get(item.guid) ?? null }));
}
