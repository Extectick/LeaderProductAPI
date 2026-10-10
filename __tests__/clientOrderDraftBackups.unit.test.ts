import { draftBackupHash, draftBackupSchema } from '../src/modules/clientOrders/clientOrderDraftBackups';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';

test('allows incomplete forms but bounds backup size and revision', () => {
  expect(draftBackupSchema.safeParse({ clientRevision: 1, payload: { items: [], organizationGuid: '' } }).success).toBe(true);
  expect(draftBackupSchema.safeParse({ clientRevision: 0, payload: {} }).success).toBe(false);
  expect(draftBackupSchema.safeParse({ clientRevision: 1, payload: { comment: 'x'.repeat(2 * 1024 * 1024) } }).success).toBe(false);
});
test('hash is identical before/after request normalization and excludes transport review choices', () => {
  const raw = { organizationGuid: 'org', counterpartyGuid: 'cp', deliveryDate: '2026-10-10',
    items: [{ productGuid: 'p', quantity: 5, basePrice: 100 }] };
  const parsed = clientOrderMutationSchema.parse({ ...raw, clientRevision: 1, intent: 'SUBMIT', offlineReview: { pricePolicy: 'USE_CURRENT' } });
  expect(draftBackupHash(raw)).toBe(draftBackupHash(parsed));
  expect(draftBackupHash(raw)).not.toBe(draftBackupHash({ ...raw, items: [{ ...raw.items[0], quantity: 4 }] }));
});
