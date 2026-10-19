import { acceptedOrderQuantities, amendmentAvailableQuantity, previewOrderAmendment } from '../src/modules/clientOrders/clientOrderAmendments';
import { assertOrderIntegrity, orderContentToken } from '../src/modules/orders/orderIntegrity';

const order = (): any => ({ id: 'order-id', guid: 'order-guid', source: 'MANAGER_APP', status: 'CONFIRMED', syncState: 'SYNCED',
  number1c: 'НОУТ-126039', isPostedIn1c: true, revision: 3, clientRevision: 1,
  hasRealization: false, cancelRequestedAt: null, lastExportError: null, last1cError: null,
  organization: { guid: 'org' }, warehouse: { guid: 'warehouse' }, counterparty: { guid: 'client' },
  items: [{ lineGuid: 'line', product: { guid: 'product', name: 'Чипсы' }, quantity: 2, quantityBase: 2, price: 900, basePrice: 900 }] });
const body = () => ({ organizationGuid: 'org', warehouseGuid: 'warehouse', counterpartyGuid: 'client',
  clientRevision: 2, intent: 'SUBMIT', offlineReview: { pricePolicy: 'ASK' },
  items: [{ lineGuid: 'line', productGuid: 'product', quantity: 1, basePrice: 900 }] });
beforeAll(() => { process.env.ACCESS_TOKEN_SECRET = 'test-only-amendment-secret'; });

test('existing 2 -> 1 remains possible at zero free stock, but never double counts the allocation', () => {
  expect(acceptedOrderQuantities(order(), body()).get('product')).toBe(2);
  expect(amendmentAvailableQuantity(0, 2)).toBe(2);
  expect(amendmentAvailableQuantity(2, 2)).toBe(2); // NOT four units
  expect(amendmentAvailableQuantity(5, 2)).toBe(5);
});
test.each([{ status: 'DRAFT' }, { status: 'CANCELLED' }, { syncState: 'QUEUED' }, { source: 'ONEC' },
  { number1c: null }, { isPostedIn1c: false }, { hasRealization: true }, { cancelRequestedAt: new Date() },
  { lastExportError: 'error' }, { last1cError: 'error' }])('does not credit an unproven or non-editable order: %p', patch => {
  expect(acceptedOrderQuantities({ ...order(), ...patch }, body()).size).toBe(0);
});
test.each(['organizationGuid', 'warehouseGuid', 'counterpartyGuid'])('does not transfer accepted quantities into another %s', key => {
  expect(acceptedOrderQuantities(order(), { ...body(), [key]: 'different' }).size).toBe(0);
});
test('aggregates base quantities and excludes cancelled lines', () => {
  const current = order();
  current.items.push({ ...current.items[0], lineGuid: 'second', quantity: 1, quantityBase: 5 });
  current.items.push({ ...current.items[0], lineGuid: 'cancelled', quantityBase: 100, isCancelled: true });
  expect(acceptedOrderQuantities(current, body()).get('product')).toBe(7);
});
test('fresh read-only review explains and signs the exact reduction, not an old cached challenge', () => {
  const current = order(), proposed = body();
  const before = JSON.stringify(current);
  const preview = previewOrderAmendment(current, proposed, 99);
  expect(preview).toMatchObject({ orderGuid: 'order-guid', number1c: 'НОУТ-126039', requiresConfirmation: true,
    changes: [expect.objectContaining({ productName: 'Чипсы', before: 2, after: 1 })] });
  expect(() => assertOrderIntegrity(current, { ...proposed, integrity: {
    baseContentToken: preview.baseContentToken, confirmationToken: preview.confirmationToken,
  } }, 99)).not.toThrow();
  expect(JSON.stringify(current)).toBe(before);
  expect(() => assertOrderIntegrity(current, { ...proposed, items: [], integrity: preview }, 99)).toThrow();
  expect(() => assertOrderIntegrity({ ...current, revision: 4 }, { ...proposed, integrity: preview }, 99)).toThrow();
  expect(() => assertOrderIntegrity(current, { ...proposed, integrity: preview }, 100)).toThrow();
  expect(() => assertOrderIntegrity(current, { ...proposed, integrity: preview }, 99, Date.now() + 700_000)).toThrow();
});
test('stale-token additions require explicit comparison and retain the real content guard', () => {
  const current = order();
  const proposed = { ...body(), integrity: { baseContentToken: '0'.repeat(64) },
    items: [{ ...body().items[0], quantity: 2 }, { lineGuid: 'new', productGuid: 'other', quantity: 3, basePrice: 100 }] };
  expect(() => assertOrderIntegrity(current, proposed, 99)).toThrow();
  const preview = previewOrderAmendment(current, proposed, 99, new Map([['other', 'Новый товар']]));
  expect(preview.baseContentToken).toBe(orderContentToken(current));
  expect(preview.requiresConfirmation).toBe(true);
  expect(preview.changes).toContainEqual(expect.objectContaining({ productName: 'Новый товар', reason: 'Добавление строки', after: 3 }));
  expect(() => assertOrderIntegrity(current, { ...proposed, integrity: { baseContentToken: preview.baseContentToken } }, 99)).not.toThrow();
});
