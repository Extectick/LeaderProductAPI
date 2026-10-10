import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';

export function shareTokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
function encryptionKey() {
  const secret = process.env.ORDER_SHARE_SECRET || process.env.ACCESS_TOKEN_SECRET;
  if (!secret || secret.length < 24) throw new Error('Order sharing secret is not configured');
  return createHash('sha256').update(`order-share:v1:${secret}`).digest();
}
export function encryptShareToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decryptShareToken(value: string) {
  const data = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export const isShareToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const text = (value: unknown, max = 400) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const decimal = (value: unknown, fallback = 0) => {
  try { const d = new Prisma.Decimal(String(value ?? fallback)); return d.isFinite() ? d : new Prisma.Decimal(fallback); }
  catch { return new Prisma.Decimal(fallback); }
};
const iso = (value: unknown) => {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export type ShareSnapshot = ReturnType<typeof projectShareOrder>;
/** Explicit allowlist. Never spread the authenticated order DTO into a public response. */
export function projectShareOrder(order: any) {
  if (!Array.isArray(order.items) || !order.items.length || order.items.length > 1000) throw new Error('Заказ не содержит доступного списка товаров');
  const rows: any[] = order.items;
  const items = rows.filter((item: any) => !item.isCancelled).map((item: any, index: number) => {
    const quantity = decimal(item.quantity);
    const multiplier = decimal(item.package?.multiplier, 1);
    const unitPrice = decimal(item.price).mul(multiplier.gt(0) ? multiplier : 1);
    const amount = item.lineAmount == null ? quantity.mul(unitPrice) : decimal(item.lineAmount);
    if (!quantity.gt(0) || amount.lt(0) || !text(item.product?.name) || !text(item.product?.guid)) throw new Error('Заполните товары и количество перед отправкой ссылки');
    return {
      id: text(item.lineGuid || item.id || `line-${index}`, 100),
      productGuid: text(item.product.guid, 100), // Server-private image lookup; stripped by public presenter.
      name: text(item.product.name),
      quantity: quantity.toString(),
      unit: text(item.package?.name || item.unit?.symbol || item.unit?.name || (item.product?.isWeight ? 'кг' : 'шт.'), 100),
      unitPrice: unitPrice.toDecimalPlaces(4).toString(),
      amount: amount.toDecimalPlaces(2).toFixed(2),
    };
  });
  if (!items.length && order.status !== 'CANCELLED') throw new Error('В заказе нет действующих товаров');
  return {
    number: text(order.number1c || 'Черновик', 80),
    date: iso(order.date1c || order.createdAt),
    customer: text(order.counterparty?.name),
    counterpartyGuid: text(order.counterparty?.guid, 100), // Server-private binding, never public.
    deliveryDate: iso(order.deliveryDate),
    currency: /^[A-Z]{3}$/.test(order.currency) ? String(order.currency) : 'RUB',
    cancelled: order.status === 'CANCELLED',
    total: decimal(order.totalAmount ?? items.reduce((sum: Prisma.Decimal, item: any) => sum.add(item.amount), new Prisma.Decimal(0))).toDecimalPlaces(2).toFixed(2),
    items,
  };
}
export const shareVersion = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
