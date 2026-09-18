import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';

/** Shared by legacy PUT and client-id PUT. No transport/status fields in content identity. */
export function stableOrderJson(value: any): string {
  const normalize = (v: any): any => {
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Prisma.Decimal.isDecimal(v)) return v.toString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])]));
    return v;
  };
  return JSON.stringify(normalize(value));
}

export function orderContentSnapshot(order: any) {
  const result: Record<string, any> = {};
  for (const name of ['organization', 'counterparty', 'agreement', 'contract', 'warehouse', 'deliveryAddress', 'priceType']) {
    result[name] = order[name]?.guid ?? null;
  }
  for (const name of ['comment', 'deliveryDate', 'paymentForm', 'deliveryMethod', 'currency', 'generalDiscountPercent', 'invoiceRequested']) {
    result[name] = order[name] ?? null;
  }
  result.items = (order.items ?? []).map((i: any) => ({
    lineGuid: i.lineGuid ?? i.id,
    productGuid: i.product?.guid,
    productName: i.product?.name,
    packageGuid: i.package?.guid ?? null,
    quantity: String(i.quantity), quantityBase: String(i.quantityBase ?? i.quantity),
    price: String(i.price), basePrice: i.basePrice == null ? null : String(i.basePrice),
    manualPrice: i.manualPrice == null ? null : String(i.manualPrice),
    priceTypeGuid: i.priceType?.guid ?? null,
    isManualPrice: Boolean(i.isManualPrice), isCancelled: Boolean(i.isCancelled),
    discountPercent: i.discountPercent == null ? null : String(i.discountPercent),
    comment: i.comment ?? null, cancelReason: i.cancelReason ?? null,
  })).sort((a: any, b: any) => String(a.lineGuid).localeCompare(String(b.lineGuid)));
  return result;
}

export function orderContentToken(order: any): string {
  const snapshot = orderContentSnapshot(order);
  // Renaming nomenclature is not an edit of the order.
  snapshot.items = snapshot.items.map(({ productName: _name, ...line }: any) => line);
  return createHash('sha256').update(stableOrderJson(snapshot)).digest('hex');
}

export type OrderReduction = { lineGuid: string; productName: string; reason: string; before: number; after: number | null };
export function findOrderReductions(order: any, items: any[]): OrderReduction[] {
  const next = new Map(items.map(i => [String(i.lineGuid ?? '').toLowerCase(), i]));
  return (order.items ?? []).flatMap((old: any) => {
    const lineGuid = String(old.lineGuid ?? old.id);
    const item = next.get(lineGuid.toLowerCase());
    const before = Number(old.quantity);
    const base = { lineGuid, productName: old.product?.name ?? lineGuid, before, after: item ? Number(item.quantity) : null };
    if (!item) return [{ ...base, reason: 'Удаление строки' }];
    if (item.productGuid !== old.product?.guid || (item.packageGuid || null) !== (old.package?.guid || null)) {
      return [{ ...base, reason: 'Замена товара или упаковки' }];
    }
    if (!old.isCancelled && item.isCancelled) return [{ ...base, reason: 'Отмена строки' }];
    if (Number(item.quantity) < before) return [{ ...base, reason: 'Уменьшение количества' }];
    return [];
  });
}

export class OrderIntegrityError extends Error {
  readonly status = 409;
  constructor(message: string, readonly details: Record<string, any>) { super(message); }
}

export function orderMutationDigest(body: any) {
  const { integrity: _i, clientRevision: _r, revision: _s, intent: _t, saveReason: _reason, ...payload } = body;
  return createHash('sha256').update(stableOrderJson(payload)).digest('hex');
}

function signature(value: string): string {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) throw new OrderIntegrityError('Подтверждение изменений недоступно. Обратитесь к администратору.', { kind: 'ORDER_CONFIRMATION_UNAVAILABLE' });
  return createHmac('sha256', secret).update(`order-change-v1:${value}`).digest('hex');
}

export function assertOrderIntegrity(order: any, body: any, userId: number, now = Date.now()) {
  const contentToken = orderContentToken(order);
  const expected = body.integrity?.baseContentToken;
  if (expected && expected !== contentToken) {
    throw new OrderIntegrityError('Заказ уже изменился. Откройте актуальную версию и согласуйте изменения; ваши правки не отправлены.', { kind: 'ORDER_CONTENT_CONFLICT' });
  }
  const changes = findOrderReductions(order, body.items);
  if (!changes.length) return;
  const bound = `${userId}:${order.id}:${order.revision}:${contentToken}:${orderMutationDigest(body)}`;
  const confirmation = String(body.integrity?.confirmationToken ?? '');
  const [expires, mac] = confirmation.split('.');
  const validTime = Number(expires) > now && Number(expires) <= now + 10 * 60_000;
  if (expected === contentToken && validTime && /^[a-f0-9]{64}$/.test(mac ?? '')) {
    const actual = signature(`${bound}:${expires}`);
    if (timingSafeEqual(Buffer.from(actual), Buffer.from(mac))) return;
  }
  const expiresAt = now + 10 * 60_000;
  const confirmationToken = `${expiresAt}.${signature(`${bound}:${expiresAt}`)}`;
  throw new OrderIntegrityError(
    'Изменение уменьшает состав заказа. Требуется явное подтверждение. В старой версии приложения обновите приложение или измените заказ в 1С.',
    { kind: 'ORDER_CHANGE_REVIEW_REQUIRED', baseContentToken: contentToken, confirmationToken, changes }
  );
}

/** A row lock serializes writers; the advisory lock also excludes an HTTP export in progress. */
export async function lockOrderMutation(tx: Prisma.TransactionClient, guid: string, allowPending = false) {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`order-integrity:${guid}`}, 0)) AS locked`;
  if (!rows[0]?.locked) throw new OrderIntegrityError('Заказ сейчас отправляется в 1С. Дождитесь результата перед изменением.', { kind: 'ORDER_EXPORT_IN_PROGRESS' });
  await tx.$queryRaw`SELECT id FROM "Order" WHERE guid=${guid} FOR UPDATE`;
  if (!allowPending) {
    const pending = await tx.order.findFirst({ where: { guid, syncState: { in: ['QUEUED', 'CANCEL_REQUESTED'] } }, select: { id: true, revision: true } });
    if (pending && await tx.orderEvent.findFirst({ where: { orderId: pending.id, revision: pending.revision, eventType: 'ORDER_EXPORT_PACKET' }, select: { id: true } })) {
      throw new OrderIntegrityError('Результат отправки ещё не подтверждён. API повторит тот же пакет; изменение заказа сейчас заблокировано.', { kind: 'ORDER_EXPORT_UNRESOLVED' });
    }
  }
}
