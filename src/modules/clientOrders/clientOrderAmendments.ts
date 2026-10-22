import { assertOrderIntegrity, OrderIntegrityError, orderContentToken } from '../orders/orderIntegrity';
import { resolveDraftDeliveryMethod } from './clientOrders.delivery';

const same = (left: unknown, right: unknown) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();

/** A decrease of an already accepted allocation does not require a new allocation.
 * Never ADD this allowance to free stock: upstream may already include own reserves. */
export function acceptedOrderQuantities(order: any, body: any): Map<string, number> {
  const quantities = new Map<string, number>();
  if (!order || order.source !== 'MANAGER_APP' || order.syncState !== 'SYNCED'
    || order.status !== 'CONFIRMED' || !order.number1c || order.isPostedIn1c !== true
    || order.hasRealization || order.cancelRequestedAt || order.lastExportError || order.last1cError
    || !same(order.organization?.guid, body.organizationGuid) || !same(order.warehouse?.guid, body.warehouseGuid)
    || !same(order.counterparty?.guid, body.counterpartyGuid)) return quantities;
  for (const line of order.items ?? []) {
    if (line.isCancelled || !line.product?.guid) continue;
    const quantity = Number(line.quantityBase ?? line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const key = String(line.product.guid).toLowerCase();
    quantities.set(key, (quantities.get(key) ?? 0) + quantity);
  }
  return quantities;
}

export function amendmentAvailableQuantity(available: number, accepted: number) {
  return Math.max(Number.isFinite(available) ? Math.max(0, available) : 0,
    Number.isFinite(accepted) ? Math.max(0, accepted) : 0);
}

export type AmendmentChange = { lineGuid?: string; productName: string; reason: string;
  before: string | number | null; after: string | number | null };

/** Explicit preview, not an automatic rebase. Confirmation is tied to this exact
 * proposal and current server version; every real write still checks the lock/token. */
export function previewOrderAmendment(order: any, body: any, userId: number, names: Map<string, string> = new Map()) {
  const changes: AmendmentChange[] = [];
  const name = (guid: unknown) => names.get(String(guid ?? '').toLowerCase()) ?? names.get(String(guid ?? ''));
  for (const [field, label] of Object.entries({ organization: 'Организация', counterparty: 'Клиент',
    agreement: 'Соглашение', contract: 'Договор', warehouse: 'Склад', deliveryAddress: 'Адрес', priceType: 'Вид цены' })) {
    if (!same(order[field]?.guid, body[`${field}Guid`])) changes.push({ productName: label, reason: 'Изменение реквизита',
      before: order[field]?.name ?? order[field]?.fullAddress ?? order[field]?.number ?? order[field]?.guid ?? null,
      after: name(body[`${field}Guid`]) ?? body[`${field}Guid`] ?? null });
  }
  for (const [field, label] of Object.entries({ deliveryDate: 'Дата отгрузки', deliveryMethod: 'Способ доставки',
    paymentForm: 'Форма оплаты', comment: 'Комментарий', currency: 'Валюта',
    generalDiscountPercent: 'Общая скидка', invoiceRequested: 'Запрос счёта' })) {
    const normalize = (value: any) => field === 'deliveryDate' && value ? new Date(value).toISOString()
      : field === 'currency' ? String(value || 'RUB')
      : field === 'paymentForm' ? (!value || ['Любая', 'Безналичная'].includes(value) ? 'Любая' : String(value))
      : field === 'deliveryMethod' ? String(resolveDraftDeliveryMethod(value, order.deliveryMethod, order.number1c) ?? '')
      : field === 'generalDiscountPercent' ? String(Number(value ?? 0))
        : field === 'invoiceRequested' ? String(Boolean(value)) : String(value ?? '');
    if (normalize(order[field]) !== normalize(body[field])) changes.push({ productName: label,
      reason: 'Изменение реквизита', before: normalize(order[field]), after: normalize(body[field]) });
  }
  const next = new Map<string, any>((body.items ?? []).map((line: any) => [String(line.lineGuid).toLowerCase(), line]));
  const previous = new Map<string, any>((order.items ?? []).map((line: any) => [String(line.lineGuid ?? line.id).toLowerCase(), line]));
  for (const [key, old] of previous) {
    const line = next.get(key);
    const base = { lineGuid: old.lineGuid ?? old.id, productName: old.product?.name ?? key };
    if (!line) { changes.push({ ...base, reason: 'Удаление строки', before: Number(old.quantity), after: null }); continue; }
    if (!same(line.productGuid, old.product?.guid) || !same(line.packageGuid, old.package?.guid)) {
      changes.push({ ...base, reason: 'Замена товара или упаковки', before: old.product?.name ?? null,
        after: name(line.productGuid) ?? line.productGuid });
    }
    if (Number(line.quantity) !== Number(old.quantity)) changes.push({ ...base, reason: 'Изменение количества',
      before: Number(old.quantity), after: Number(line.quantity) });
    const oldPrice = Number(old.manualPrice ?? old.basePrice ?? old.price);
    const newPrice = Number(line.manualPrice ?? line.basePrice ?? 0);
    if (oldPrice !== newPrice) changes.push({ ...base, reason: 'Изменение цены', before: oldPrice, after: newPrice });
    for (const [field, reason] of [['isCancelled', 'Отмена строки'], ['discountPercent', 'Изменение скидки'],
      ['comment', 'Комментарий строки'], ['cancelReason', 'Причина отмены']] as const) {
      const value = (v: any) => field === 'isCancelled' ? String(Boolean(v))
        : field === 'discountPercent' ? String(Number(v ?? 0)) : String(v ?? '');
      if (value(old[field]) !== value(line[field])) changes.push({ ...base, reason, before: value(old[field]), after: value(line[field]) });
    }
  }
  for (const [key, line] of next) if (!previous.has(key)) changes.push({ lineGuid: line.lineGuid,
    productName: name(line.productGuid) ?? line.productGuid, reason: 'Добавление строки', before: null, after: Number(line.quantity) });
  const baseContentToken = orderContentToken(order);
  let confirmationToken: string | undefined;
  try { assertOrderIntegrity(order, { ...body, integrity: { baseContentToken } }, userId); }
  catch (error) {
    if (!(error instanceof OrderIntegrityError) || error.details.kind !== 'ORDER_CHANGE_REVIEW_REQUIRED') throw error;
    confirmationToken = error.details.confirmationToken;
  }
  return { orderGuid: order.guid, serverRevision: order.revision, number1c: order.number1c ?? null,
    baseContentToken, confirmationToken, changes,
    requiresConfirmation: changes.length > 0 || Boolean(body.integrity?.baseContentToken && body.integrity.baseContentToken !== baseContentToken) };
}
