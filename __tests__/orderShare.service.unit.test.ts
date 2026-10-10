jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  orderShareLink: { findUnique: jest.fn(), updateMany: jest.fn() },
  order: { findUnique: jest.fn() }, user: { findFirst: jest.fn() }, productImage: { findMany: jest.fn(), findFirst: jest.fn() }, $transaction: jest.fn(),
} }));
jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({ getClientOrderByGuid: jest.fn() }));
import prisma from '../src/prisma/client';
import { authorizePublicShare, publishOrder, resolvePublicShare, sharedImageKey } from '../src/modules/orderShare/orderShare.service';
import { encryptShareToken } from '../src/modules/orderShare/orderShare.model';
const db = prisma as any;
const link = { id: 'share', ownerId: 1, orderGuid: 'order', localOrderId: 'local', tokenHash: 'hash', counterpartyGuid: 'client',
  expiresAt: new Date(Date.now() + 86400000), revokedAt: null, refreshedAt: new Date() };
beforeEach(() => {
  jest.clearAllMocks(); db.orderShareLink.findUnique.mockResolvedValue(link);
  db.user.findFirst.mockResolvedValue({ firstName: 'Иван', lastName: 'Менеджер', phone: 79001234567n, clientContacts: null });
  db.$transaction.mockImplementation((callback: any) => callback(db)); db.productImage.findMany.mockResolvedValue([]);
  db.order.findUnique.mockResolvedValue({ id: 'local', createdByUserId: 1, updatedAt: new Date(), counterparty: { guid: 'client', name: 'Клиент', inn: 'private' },
    currency: 'RUB', totalAmount: 100, profit: 44, trackingSnapshot: { latitude: 50 },
    items: [{ id: 'line', product: { guid: 'product', name: 'Продукт' }, quantity: 2, price: 50, lineAmount: 100 }] });
});
test('rejects missing, expired, revoked and blocked-owner links', async () => {
  for (const value of [null, { ...link, expiresAt: new Date(0) }, { ...link, revokedAt: new Date() }]) {
    db.orderShareLink.findUnique.mockResolvedValue(value);
    await expect(authorizePublicShare('token')).rejects.toMatchObject({ status: 410 });
  }
  db.orderShareLink.findUnique.mockResolvedValue(link); db.user.findFirst.mockResolvedValue(null);
  await expect(authorizePublicShare('token')).rejects.toMatchObject({ status: 410 });
});
test('public response strips all private keys including identifiers and changes etag on saved content changes', async () => {
  const first = await resolvePublicShare('token');
  expect(JSON.stringify(first.data)).not.toMatch(/productGuid|counterpartyGuid|ownerId|tracking|profit|inn|private/);
  expect(first.data.items[0].amount).toBe('100.00');
  db.order.findUnique.mockResolvedValueOnce({ id: 'local', createdByUserId: 1, updatedAt: new Date(), counterparty: { guid: 'client', name: 'Клиент' },
    currency: 'RUB', totalAmount: 150, items: [{ id: 'line', product: { guid: 'product', name: 'Продукт' }, quantity: 3, price: 50, lineAmount: 150 }] });
  const second = await resolvePublicShare('token');
  expect(second.etag).not.toBe(first.etag);
  expect(second.data.total).toBe('150.00');
});
test('customer/owner change or order deletion permanently revokes access', async () => {
  db.order.findUnique.mockResolvedValue({ createdByUserId: 1, counterparty: { guid: 'another' } });
  await expect(resolvePublicShare('token')).rejects.toMatchObject({ status: 410 });
  expect(db.orderShareLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
});
test('cannot publish another managers order', async () => {
  await expect(publishOrder('order', 2, false)).rejects.toMatchObject({ status: 404 });
});
test('image access is scoped to non-cancelled rows of this order', async () => {
  db.productImage.findFirst.mockResolvedValue({ productGuid: 'other-product', s3KeyPreview: 'private/photo.webp' });
  db.order.findUnique.mockResolvedValue({ createdByUserId: 1, counterparty: { guid: 'client' }, items: [] });
  expect(await sharedImageKey('token', 'image')).toBeNull();
  expect(db.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ items: expect.objectContaining({ where: { isCancelled: false, product: { guid: 'other-product' } } }) }) }));
});

test('publishes short links for API drafts and preserves previously shared long links until rotation', async () => {
  process.env.ORDER_SHARE_SECRET = 'unit-test-only-32-byte-secret-not-live';
  process.env.ORDER_SHARE_PUBLIC_ORIGIN = 'https://dev.leader-product.ru';
  db.$executeRaw = jest.fn(async () => undefined);
  db.orderShareLink.upsert = jest.fn(async ({ create }: any) => ({ id: 'new-share', ...create }));
  db.orderShareLink.findUnique.mockResolvedValue(null);
  const fresh = await publishOrder('order', 1, false);
  expect(new URL(fresh.url).hash.slice(1)).toHaveLength(12);
  const oldToken = 'x'.repeat(43);
  db.orderShareLink.findUnique.mockResolvedValue({ ...link, tokenEncrypted: encryptShareToken(oldToken) });
  expect(new URL((await publishOrder('order', 1, false)).url).hash.slice(1)).toBe(oldToken);
  expect(new URL((await publishOrder('order', 1, true)).url).hash.slice(1)).toHaveLength(12);
});
