import prisma from '../../prisma/client';

export type IncomingCost = { price: number; currency: string; source: 'RECEIPT_PRICE'; updatedAt: Date | null };
const namedToken = (value: string | null) => (value || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

/** Same current, common ЦенаПоступления used by order picking. Never a warehouse valuation or selling price. */
export async function withIncomingCosts<T extends { guid: string }>(items: T[]): Promise<Array<T & { incomingCost: IncomingCost | null }>> {
  if (!items.length) return [];
  const at = new Date();
  const types = await prisma.priceType.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } });
  const ids = types.filter(type => [namedToken(type.code),namedToken(type.name)].includes('ценапоступления')).map(type => type.id);
  if (!ids.length) return items.map(item => ({ ...item, incomingCost: null }));
  const rows = await prisma.productPrice.findMany({
    where: { isActive: true, product: { guid: { in: [...new Set(items.map(item => item.guid))] } }, priceTypeId: { in: ids },
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
  return items.map(item => ({ ...item, incomingCost: costs.get(item.guid) ?? null }));
}
