import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getOnecLpAppStock } from '../onec/onec.lpApp.client';

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// These are 1C wall-clock values. Do not convert them to UTC and move a document to another date.
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).refine(value => {
  const date = new Date(`${value}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value;
});
const documentType = z.string().regex(/^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё_0-9]{0,150}$/);
export const stockMovementsQuery = z.object({
  direction: z.enum(['receipt', 'expense']),
  warehouseGuids: z.string().transform(value => [...new Set(value.split(',').map(g => g.toLowerCase()))].sort())
    .pipe(z.array(guid).min(1).max(100)).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().min(1).max(3000).optional(),
});
type Query = z.infer<typeof stockMovementsQuery>;
const keySchema = z.object({ period: localTime, type: documentType, guid, warehouse: guid, characteristic: guid });
const cursorSchema = z.object({ version: z.literal(1), scope: z.string(), expires: z.number().int(), snapshotAt: localTime, key: keySchema });
const docSchema = z.object({ type: documentType, typeName: z.string().max(300), guid, number: z.string().max(100), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const rowSchema = z.object({
  id: z.string().max(700), direction: z.enum(['receipt', 'expense']), operationKind: z.string().max(300), document: docSchema,
  movementAt: localTime, warehouse: z.object({ guid, name: z.string().max(300) }), characteristic: z.string().max(500),
  quantity: z.number().finite().positive(), baseDocuments: z.array(docSchema).max(100), counterparty: z.string().max(1000),
  writeOffArticles: z.array(z.string().max(500)).max(100), price: z.number().finite().nonnegative().nullable(), amount: z.number().finite().nullable(),
  currency: z.string().max(100), costBasis: z.literal('VAT_INCLUDED'), costStatus: z.enum(['CALCULATED', 'PRELIMINARY', 'UNAVAILABLE', 'DOCUMENT']), costReason: z.string().max(1000),
}).superRefine((row, ctx) => {
  if (row.costStatus === 'UNAVAILABLE' && (row.price !== null || row.amount !== null)) ctx.addIssue({ code: 'custom', message: 'Unavailable cost must be null' });
});
const responseSchema = z.object({ version: z.literal('stock-movements-v1'), items: z.array(rowSchema).max(50), hasMore: z.boolean(), snapshotAt: localTime, nextKey: keySchema.nullable() });

export class InvalidStockCursor extends Error {}
function secret() {
  const value = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Stock cursor signing secret is not configured');
  return value;
}
function signature(body: string) { return createHmac('sha256', secret()).update(`stock-movements-v1:${body}`).digest(); }
function scope(productGuid: string, query: Query, userId?: number) {
  return JSON.stringify([userId ?? null, productGuid.toLowerCase(), query.direction, query.warehouseGuids ?? []]);
}
function readCursor(value: string, expectedScope: string) {
  try {
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error();
    const actual = Buffer.from(parts[1], 'base64url');
    const expected = signature(parts[0]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    if (cursor.scope !== expectedScope || cursor.expires < Date.now()) throw new Error();
    return cursor;
  } catch { throw new InvalidStockCursor('Список изменился. Потяните вниз для обновления.'); }
}
function signCursor(cursor: z.infer<typeof cursorSchema>) {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${signature(body).toString('base64url')}`;
}

export async function listStockMovements(productGuid: string, query: Query, userId?: number) {
  const expectedScope = scope(productGuid, query, userId);
  const cursor = query.cursor ? readCursor(query.cursor, expectedScope) : null;
  const payload = responseSchema.parse(await getOnecLpAppStock({
    view: 'movements', productGuid, direction: query.direction, warehouseGuids: query.warehouseGuids?.join(','), limit: query.limit,
    ...(cursor ? { snapshotAt: cursor.snapshotAt, beforePeriod: cursor.key.period, beforeType: cursor.key.type,
      beforeGuid: cursor.key.guid, beforeWarehouse: cursor.key.warehouse, beforeCharacteristic: cursor.key.characteristic } : {}),
  }));
  if (payload.items.length > query.limit || payload.hasMore !== (payload.nextKey !== null)
      || (payload.hasMore && !payload.items.length) || (cursor && payload.snapshotAt !== cursor.snapshotAt)
      || payload.items.some(row => row.direction !== query.direction || (query.warehouseGuids && !query.warehouseGuids.includes(row.warehouse.guid.toLowerCase())))
      || new Set(payload.items.map(row => row.id)).size !== payload.items.length) throw new Error('Inconsistent 1C movement page');
  const last = payload.items[payload.items.length - 1];
  if (payload.nextKey && (!last || payload.nextKey.period !== last.movementAt || payload.nextKey.guid !== last.document.guid
      || payload.nextKey.type !== last.document.type || payload.nextKey.warehouse !== last.warehouse.guid)) throw new Error('Inconsistent 1C movement cursor');
  return { items: payload.items, hasMore: payload.hasMore, snapshotAt: payload.snapshotAt,
    nextCursor: payload.nextKey ? signCursor({ version: 1, scope: expectedScope, expires: cursor?.expires ?? Date.now() + 60 * 60 * 1000,
      snapshotAt: payload.snapshotAt, key: payload.nextKey }) : null,
    offset: 0, nextOffset: payload.items.length };
}
