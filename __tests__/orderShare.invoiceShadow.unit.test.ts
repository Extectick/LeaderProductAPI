jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  order: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  orderShareLink: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
  productImage: { findMany: jest.fn(), findFirst: jest.fn() }, user: { findFirst: jest.fn() },
  $transaction: jest.fn(), $executeRaw: jest.fn(),
} }));
jest.mock('../src/modules/clientOrders/clientOrders.service', () => ({ getClientOrderByGuid: jest.fn() }));
jest.mock('../src/modules/orderShare/orderShare.weightRefresh', () => ({ scheduleShareWeightRefresh: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: Number(req.get('x-test-user-id') || 100) }; next(); },
  authorizePermissions: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/middleware/serviceAccess', () => ({ authorizeServiceAccess: () => (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/storage/minio', () => ({ downloadBuffer: jest.fn(async () => ({ contentType: 'image/webp', body: Buffer.from('test-image') })) }));
import express from 'express';
import request from 'supertest';
import prisma from '../src/prisma/client';
import { getClientOrderByGuid } from '../src/modules/clientOrders/clientOrders.service';
import { publishOrder, resolvePublicShare, sharedImageKey } from '../src/modules/orderShare/orderShare.service';
import { scheduleShareWeightRefresh } from '../src/modules/orderShare/orderShare.weightRefresh';
import { projectShareOrder } from '../src/modules/orderShare/orderShare.model';
import { orderShareManagerRouter, publicOrderRouter } from '../src/modules/orderShare/orderShare.routes';

const db = prisma as any;
const guid = 'a3e51711-17ea-47ad-9a46-dc328db2c577';
let local: any;
let detail: any;
let savedLink: any;
const app = express();
app.use(express.json());
app.use('/api/order-sharing', orderShareManagerRouter);
app.use('/public/order', publicOrderRouter);
function setRows(count: number) {
  detail = { documentGuid: guid, guid, number1c: 'НОУТ-125752', itemsCount: count,
    isPostedIn1c: true, status: 'CLOSED', totalAmount: count * 100,
    counterparty: { guid: 'customer', name: 'Клиент' }, currency: 'RUB',
    items: Array.from({ length: count }, (_, i) => ({ lineGuid: `row-${i}`, product: { guid: `p-${i}`, name: `Товар ${i}` },
      quantity: 1, price: 100, lineAmount: 100 })) };
  local = { id: 'invoice-record', guid, createdByUserId: 100, clientOrderId: null,
    syncState: 'SYNCED', status: 'CONFIRMED', number1c: detail.number1c,
    updatedAt: new Date(), counterparty: detail.counterparty, items: [], _count: { items: 0 },
    last1cSnapshot: { invoiceShadow: true, item: detail } };
  jest.mocked(getClientOrderByGuid).mockImplementation(async () => detail);
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ORDER_SHARE_SECRET = 'unit-test-only-32-byte-secret-not-live';
  process.env.ORDER_SHARE_PUBLIC_ORIGIN = 'https://api.example.test';
  process.env.ORDER_SHARE_PATH_LINKS_ENABLED = '1';
  process.env.ORDER_SHARING_ENABLED = '1';
  savedLink = null;
  setRows(5);
  db.order.findUnique.mockImplementation(async () => local);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.orderShareLink.findUnique.mockImplementation(async () => savedLink);
  db.orderShareLink.upsert.mockImplementation(async ({ create, update }: any) => {
    savedLink = savedLink ? { ...savedLink, ...update } : { id: 'link', ...create };
    return savedLink;
  });
  db.user.findFirst.mockResolvedValue({ firstName: 'Менеджер', lastName: 'Тестовый', phone: null });
  db.productImage.findMany.mockResolvedValue([]);
  db.productImage.findFirst.mockResolvedValue({ productGuid: 'p-0', s3KeyPreview: 'image.webp' });
});

it.each([5, 7])('publishes and opens an invoice-only order with %i rows, without writing or submitting the order', async count => {
  setRows(count);
  const result = await publishOrder(guid, 100, false);
  expect(getClientOrderByGuid).toHaveBeenCalledWith(guid, 100);
  expect(savedLink.localOrderId).toBeNull();
  expect(savedLink.snapshot.items).toHaveLength(count);
  const token = new URL(result.url).pathname.split('/').pop()!;
  const read = await resolvePublicShare(token);
  expect(read.data.items).toHaveLength(count);
  expect(read.data.total).toBe(`${count * 100}.00`);
  expect(JSON.stringify(read.data)).not.toMatch(/invoiceShadow|documentGuid|productGuid|ownerId|last1cSnapshot/);
  expect(await sharedImageKey(token, 'picture')).toBe('image.webp');
  expect(db.order.update).not.toHaveBeenCalled();
  expect(db.order.create).not.toHaveBeenCalled();
  expect(scheduleShareWeightRefresh).not.toHaveBeenCalled();
});

it('preserves an existing capability rather than requiring rotation or relogin', async () => {
  const first = await publishOrder(guid, 100, false);
  const second = await publishOrder(guid, 100, false);
  expect(second.url).toBe(first.url);
});

it('opens a legacy link bound to an empty invoice record from the verified cached snapshot without 1C', async () => {
  savedLink = { id: 'legacy', ownerId: 100, orderGuid: guid, localOrderId: local.id, counterpartyGuid: 'customer',
    tokenHash: 'hash', expiresAt: new Date(Date.now() + 86400000), refreshedAt: new Date(), snapshot: {} };
  const result = await resolvePublicShare('test-token');
  expect(result.data.items).toHaveLength(5);
  expect(result.data.total).toBe('500.00');
  expect(getClientOrderByGuid).not.toHaveBeenCalled();
  expect(await sharedImageKey('test-token', 'picture')).toBe('image.webp');
});

it('validates an application identity when the cached 1C document has a different native GUID', async () => {
  detail.documentGuid = 'bf0ee6e5-c877-11f1-9d3a-f1cbadb7fc65';
  detail.appGuid = guid;
  savedLink = { id: 'legacy-app-guid', ownerId: 100, orderGuid: guid, localOrderId: local.id, counterpartyGuid: 'customer',
    tokenHash: 'hash', expiresAt: new Date(Date.now() + 86400000), refreshedAt: new Date(), snapshot: {} };
  expect((await resolvePublicShare('test-token')).data.items).toHaveLength(5);
});

it('uses the complete document total rather than an outdated invoice bookkeeping total', async () => {
  local.totalAmount = 99999;
  await publishOrder(guid, 100, false);
  expect((await resolvePublicShare('test-token')).data.total).toBe('500.00');
});

it('does not publish a regular empty draft or reinterpret its old snapshot as actual content', async () => {
  local.clientOrderId = 'editable-draft';
  local.syncState = 'DRAFT';
  await expect(publishOrder(guid, 100, false)).rejects.toMatchObject({ status: 422, code: 'ORDER_ITEMS_MISSING' });
  expect(getClientOrderByGuid).not.toHaveBeenCalled();
  expect(db.orderShareLink.upsert).not.toHaveBeenCalled();
});

it('does not publish another manager\'s shadow or read its 1C/cached contents', async () => {
  await expect(publishOrder(guid, 101, false)).rejects.toMatchObject({ status: 404 });
  expect(getClientOrderByGuid).not.toHaveBeenCalled();
  expect(db.order.findUnique).toHaveBeenCalledTimes(1);
  expect(db.orderShareLink.upsert).not.toHaveBeenCalled();
});

it('does not publish when full-source loading fails, and leaves an existing link intact', async () => {
  const old = await publishOrder(guid, 100, false);
  const previous = JSON.stringify(savedLink);
  jest.mocked(getClientOrderByGuid).mockRejectedValueOnce(Object.assign(new Error('upstream unavailable'), { status: 502 }));
  await expect(publishOrder(guid, 100, false)).rejects.toMatchObject({ status: 502 });
  expect(JSON.stringify(savedLink)).toBe(previous);
  expect(old.active).toBe(true);
});

it('rejects a customer change between the local source and resolved full detail', async () => {
  jest.mocked(getClientOrderByGuid).mockResolvedValueOnce({ ...detail, counterparty: { guid: 'other' } });
  await expect(publishOrder(guid, 100, false)).rejects.toMatchObject({ status: 409, code: 'ORDER_CHANGED' });
  expect(db.orderShareLink.upsert).not.toHaveBeenCalled();
});

it.each(['missing', 'foreign', 'partial'])('never uses an unverified %s cached invoice snapshot on public read', async kind => {
  savedLink = { id: 'legacy', ownerId: 100, orderGuid: guid, localOrderId: local.id, counterpartyGuid: 'customer',
    tokenHash: 'hash', expiresAt: new Date(Date.now() + 86400000), refreshedAt: new Date(), snapshot: projectShareOrder(detail) };
  if (kind === 'missing') delete local.last1cSnapshot.item.items;
  if (kind === 'foreign') local.last1cSnapshot.item.documentGuid = 'different';
  if (kind === 'partial') local.last1cSnapshot.item.items.pop();
  await expect(resolvePublicShare('test-token')).rejects.toMatchObject({ status: 503 });
});

it('never serves an image absent from the invoice order and excludes cancelled rows', async () => {
  await publishOrder(guid, 100, false);
  db.productImage.findFirst.mockResolvedValue({ productGuid: 'foreign-product', s3KeyPreview: 'private.webp' });
  expect(await sharedImageKey('test-token', 'picture')).toBeNull();
  savedLink.localOrderId = local.id;
  detail.items[0].isCancelled = true;
  db.productImage.findFirst.mockResolvedValue({ productGuid: 'p-0', s3KeyPreview: 'private.webp' });
  expect(await sharedImageKey('test-token', 'picture')).toBeNull();
});

it('refuses bad publishing configuration before persisting a link', async () => {
  delete process.env.ORDER_SHARE_PUBLIC_ORIGIN;
  await expect(publishOrder(guid, 100, false)).rejects.toMatchObject({ code: 'SHARING_NOT_CONFIGURED' });
  expect(db.orderShareLink.upsert).not.toHaveBeenCalled();
});

it.each(['owner', 'customer'])('revokes an unbound invoice link immediately when its %s changes', async changed => {
  await publishOrder(guid, 100, false);
  if (changed === 'owner') local.createdByUserId = 101;
  if (changed === 'customer') local.counterparty = { guid: 'other-customer' };
  await expect(resolvePublicShare('test-token')).rejects.toMatchObject({ status: 410 });
  expect(db.orderShareLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: expect.any(Date) } }));
  await expect(sharedImageKey('test-token', 'picture')).rejects.toMatchObject({ status: 410 });
});

it('upgrades a legacy binding in the bounded refresh with compare-and-swap protection', async () => {
  savedLink = { id: 'legacy-upgrade', ownerId: 100, orderGuid: guid, localOrderId: local.id, counterpartyGuid: 'customer',
    tokenHash: 'hash', version: 'original-version', expiresAt: new Date(Date.now() + 86400000),
    refreshedAt: new Date(Date.now() - 120000), snapshot: projectShareOrder(detail) };
  await resolvePublicShare('test-token');
  await new Promise(resolve => setImmediate(resolve));
  expect(db.orderShareLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ tokenHash: 'hash', version: 'original-version', counterpartyGuid: 'customer', revokedAt: null }),
    data: expect.objectContaining({ localOrderId: null }),
  }));
});

it('HTTP create -> public read -> image succeeds for the same invoice-only source', async () => {
  const published = await request(app).post(`/api/order-sharing/${guid}/share`).send({ rotate: false }).expect(200);
  const token = new URL(published.body.data.url).pathname.split('/').pop()!;
  const read = await request(app).get('/public/order').auth(token, { type: 'bearer' }).expect(200);
  expect(read.body.data.items).toHaveLength(5);
  expect(read.headers['cache-control']).toContain('no-store');
  await request(app).get('/public/order/images/picture').auth(token, { type: 'bearer' }).expect(200).expect('Content-Type', /image\/webp/);
  expect(db.order.update).not.toHaveBeenCalled();
});

it('HTTP incomplete-draft errors have a useful code and a server-generated correlation ID', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    local.clientOrderId = 'draft'; local.syncState = 'DRAFT';
    const response = await request(app).post(`/api/order-sharing/${guid}/share`).send({}).expect(422);
    expect(response.body).toMatchObject({ ok: false, code: 'ORDER_ITEMS_MISSING' });
    expect(response.body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(log).toHaveBeenCalledWith('[order-share] operation rejected', expect.objectContaining({
      operation: 'CREATE', ownerId: 100, orderGuid: guid, code: 'ORDER_ITEMS_MISSING', requestId: response.body.requestId,
    }));
  } finally { log.mockRestore(); }
});

it('HTTP unexpected failures are logged without exception payloads, tokens or request content', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const secret = 'test-sensitive-capability';
    db.order.findUnique.mockRejectedValueOnce(Object.assign(new Error(`postgres://private:password@example.test https://site/order/${secret}`), { code: 'P2024' }));
    const response = await request(app).post(`/api/order-sharing/${guid}/share?token=${secret}`)
      .set('Authorization', `Bearer ${secret}`).send({ secret }).expect(503);
    expect(response.body).toMatchObject({ ok: false, code: 'ORDER_SHARE_UNAVAILABLE' });
    expect(log).toHaveBeenCalledWith('[order-share] operation failed', expect.objectContaining({
      operation: 'CREATE', errorCode: 'P2024', requestId: response.body.requestId,
    }));
    expect(JSON.stringify([log.mock.calls, response.body])).not.toMatch(/test-sensitive-capability|postgres:|private:password/);
  } finally { log.mockRestore(); }
});
