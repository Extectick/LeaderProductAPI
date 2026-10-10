import { z } from 'zod';
import { getOnecLpAppCounterpartyCard } from '../onec/onec.lpApp.client';
import { readThroughClientOrdersCache } from './clientOrders.cache';

export const purchaseHistoryQuerySchema = z.object({
  counterpartyGuid: z.string().uuid().transform(value => value.toLowerCase()),
  organizationGuid: z.string().uuid().transform(value => value.toLowerCase()),
});
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const snapshotSchema = purchaseHistoryQuerySchema.extend({
  version: z.literal('customer-purchases-v1'),
  coverageFrom: calendarDate,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
  items: z.array(z.object({
    productGuid: z.string().uuid().transform(value => value.toLowerCase()),
    lastPurchasedDate: calendarDate,
  })).max(20000),
});

export function parsePurchaseHistory(raw: unknown, context: z.infer<typeof purchaseHistoryQuerySchema>) {
  // Do not interpret a response from an old extension (the full card) as empty
  // purchase history. An unsupported source must leave the last snapshot intact.
  const data = snapshotSchema.parse(raw);
  if (data.counterpartyGuid !== context.counterpartyGuid || data.organizationGuid !== context.organizationGuid) {
    throw new Error('Purchase history context mismatch');
  }
  const known = new Set<string>();
  for (const item of data.items) {
    if (known.has(item.productGuid) || item.lastPurchasedDate < data.coverageFrom || item.lastPurchasedDate > data.asOf.slice(0, 10)) {
      throw new Error('Invalid purchase history snapshot');
    }
    known.add(item.productGuid);
  }
  return { ...data, fetchedAt: new Date().toISOString() };
}

export async function getCustomerPurchaseHistory(context: z.infer<typeof purchaseHistoryQuerySchema>, userId: number) {
  return readThroughClientOrdersCache('customer-purchases-v1', { ...context, userId }, 300,
    async () => parsePurchaseHistory(await getOnecLpAppCounterpartyCard({ ...context, mode: 'purchase-history' }), context));
}
