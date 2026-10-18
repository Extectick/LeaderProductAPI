import { ClientOrdersError, getStoredClientOrderForSubmission, updateClientOrder, submitClientOrder } from './clientOrders.service';
import type { ClientOrderMutationBody } from './clientOrders.schemas';
import { ErrorCodes } from '../../utils/apiResponse';

const text = (value: unknown) => String(value ?? '').trim();
const guid = (value: unknown) => text(value).toLowerCase();
const number = (value: unknown) => value == null || value === '' ? null : Number(value);
const date = (value: unknown) => { const parsed = Date.parse(text(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text(value); };
/** Same input-only legacy proof used by the phone; never infer equality from a number or total. */
export function legacySubmissionMatches(body: ClientOrderMutationBody, order: any) {
  for (const ref of ['organization','counterparty','agreement','contract','warehouse','deliveryAddress','priceType'] as const) {
    if (guid(body[`${ref}Guid`]) !== guid(order[ref]?.guid)) return false;
  }
  for (const key of ['paymentForm','comment','currency'] as const) if (text(body[key]) !== text(order[key])) return false;
  // Empty legacy input did not choose a method; saving may now fill the new-draft
  // default or retain the existing selection. Explicit choices remain strict.
  if (text(body.deliveryMethod) && text(body.deliveryMethod) !== text(order.deliveryMethod)) return false;
  if (date(body.deliveryDate) !== date(order.deliveryDate) || Boolean(body.invoiceRequested) !== Boolean(order.invoiceRequested)
    || (number(body.generalDiscountPercent) ?? 0) !== (number(order.generalDiscountPercent) ?? 0)) return false;
  if (!body.items.length || body.items.length !== order.items?.length) return false;
  const lines = new Map<string, any>(order.items.map((line: any) => [guid(line.lineGuid), line]));
  return body.items.every(line => {
    const other = lines.get(guid(line.lineGuid));
    return Boolean(line.lineGuid) && !!other && guid(line.productGuid) === guid(other.product?.guid)
      && guid(line.packageGuid) === guid(other.package?.guid) && number(line.quantity) === number(other.quantity)
      && number(line.manualPrice) === number(other.manualPrice)
      && (!line.priceTypeGuid || guid(line.priceTypeGuid) === guid(other.priceType?.guid))
      && (number(line.discountPercent) ?? 0) === (number(other.discountPercent) ?? 0)
      && text(line.comment) === text(other.comment) && Boolean(line.isCancelled) === Boolean(other.isCancelled)
      && guid(line.cancelReasonGuid) === guid(other.cancelReasonGuid) && text(line.cancelReason) === text(other.cancelReason)
      && text(line.cancelReasonName) === text(other.cancelReasonName) && number(line.cancelledAmount) === number(other.cancelledAmount);
  });
}
const accepted = (order: any) => ['QUEUED','SENT_TO_1C','CONFIRMED'].includes(order.status) && ['QUEUED','SYNCED'].includes(order.syncState);
function conflict() { return new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Заказ изменён на сервере. Локальные изменения сохранены; сравните версии перед отправкой.', { kind: 'LEGACY_DRAFT_CONFLICT' }); }

/** Background compatibility: update/submit the ORIGINAL GUID, never POST a replacement. */
export async function materializeLegacyOrderSubmission(userId: number, raw: any, body: ClientOrderMutationBody) {
  const target = raw.legacyServerGuid as string;
  const expectedRevision = raw.legacyServerRevision as number;
  const read = () => getStoredClientOrderForSubmission(target, userId);
  const valid = (order: any) => {
    if (order.guid !== target || order.createdByUser?.id !== userId || !Number.isInteger(order.revision) || order.revision < expectedRevision) throw conflict();
  };
  let order: any = await read(); valid(order);
  if (!legacySubmissionMatches(body, order)) {
    if (order.revision !== expectedRevision || accepted(order)) throw conflict();
    try { order = await updateClientOrder(target, userId, { ...body, revision: order.revision }); }
    catch (error) {
      // A write may have committed before a failed detail read. An exact durable
      // read is the only permission to continue with its new revision.
      const observed = await read(); valid(observed);
      if (!legacySubmissionMatches(body, observed)) throw error;
      order = observed;
    }
    valid(order); if (!legacySubmissionMatches(body, order)) throw conflict();
  }
  if (accepted(order)) return order;
  try { order = await submitClientOrder(target, userId, { revision: order.revision, geoEvents: body.geoEvents }); }
  catch (error) {
    const observed = await read(); valid(observed);
    if (!legacySubmissionMatches(body, observed) || !accepted(observed)) throw error;
    order = observed;
  }
  valid(order); if (!legacySubmissionMatches(body, order) || !accepted(order)) throw conflict();
  return order;
}
