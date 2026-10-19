// Run only against an isolated schema in the local test PostgreSQL (see guard below).
import { randomUUID } from 'node:crypto';
jest.mock('../src/prisma/client', () => {
  const url = new URL(process.env.DATABASE_URL!);
  const schema = url.searchParams.get('schema') || '';
  if (url.hostname !== '127.0.0.1' || url.port !== '54329' || !/^draft_recovery_[a-z0-9_]+$/.test(schema)) throw new Error('Isolated test schema required');
  const { Pool } = require('pg');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('@prisma/client');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  return { __esModule: true, default: client, prisma: client, pool };
});
jest.mock('../src/modules/clientOrders/clientOrders.onecLive');
jest.mock('../src/services/clientOrdersExportWorker', () => ({ requestClientOrdersExportWakeup: jest.fn() }));
jest.mock('../src/modules/clientOrders/clientOrders.productImages', () => ({ enrichOrderItemsWithImages: async (order: unknown) => order }));
jest.mock('../src/modules/clientOrders/clientOrders.cache', () => ({
  ...jest.requireActual('../src/modules/clientOrders/clientOrders.cache'),
  readThroughClientOrdersCache: (_kind: unknown, _key: unknown, _ttl: unknown, load: () => unknown) => load(),
}));
import prisma, { pool } from '../src/prisma/client';
import * as live from '../src/modules/clientOrders/clientOrders.onecLive';
import { putClientOrderByClientId, getClientOrderByClientId, submitClientOrder, previewClientOrderAmendment, getStoredClientOrderForSubmission } from '../src/modules/clientOrders/clientOrders.service';
import { draftBackupSchema, saveDraftBackup, getDraftBackup, DraftBackupConflict } from '../src/modules/clientOrders/clientOrderDraftBackups';
import { clientOrderMutationSchema } from '../src/modules/clientOrders/clientOrders.schemas';
import { requestClientOrdersExportWakeup } from '../src/services/clientOrdersExportWorker';
import { OnecLpAppNetworkError } from '../src/modules/onec/onec.lpApp.client';

const prefix = randomUUID();
const ids = Object.fromEntries(['org', 'cp', 'warehouse', 'agreement', 'contract', 'address', 'product', 'price'].map(k => [k, `${prefix}-${k}`]));
let userId: number;
let otherUserId: number;
const product: any = { guid: ids.product, name: 'Test product', isActive: true, isWeight: false, packages: [],
  baseUnit: null, basePrice: 100, receiptPrice: 50, priceType: { guid: ids.price, name: 'Test price' }, currency: 'RUB', stock: { available: 1 } };
const body = () => clientOrderMutationSchema.parse({
  organizationGuid: ids.org, counterpartyGuid: ids.cp, warehouseGuid: ids.warehouse,
  agreementGuid: ids.agreement, contractGuid: ids.contract, deliveryAddressGuid: ids.address, priceTypeGuid: ids.price,
  deliveryDate: '2026-10-10', clientRevision: 1, intent: 'SUBMIT', offlineReview: { pricePolicy: 'ASK' },
  items: [{ lineGuid: 'line-a', productGuid: ids.product, quantity: 2, basePrice: 100 },
    { lineGuid: 'line-b', productGuid: ids.product, quantity: 3, basePrice: 100 }],
});

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.port !== '54329' || !url.searchParams.get('schema')?.startsWith('draft_recovery_')) {
    throw new Error('Use isolated local draft_recovery_* test schema only');
  }
  const role = await prisma.role.create({ data: { name: `draft-test-${prefix}` } });
  userId = (await prisma.user.create({ data: { roleId: role.id, isActive: true } })).id;
  await prisma.employeeProfile.create({ data: { userId, onecUserGuid: `${prefix}-manager`, status: 'ACTIVE' } });
  otherUserId = (await prisma.user.create({ data: { roleId: role.id, isActive: true } })).id;
});
afterAll(async () => { await prisma.$disconnect(); await pool.end(); });
beforeEach(() => {
  jest.clearAllMocks();
  product.stock.available = 1;
  product.basePrice = 100;
  jest.mocked(live.findLiveOrganization).mockResolvedValue({ guid: ids.org, name: 'Test org', code: null, isActive: true });
  jest.mocked(live.findLiveCounterparty).mockResolvedValue({ guid: ids.cp, name: 'Test cp', isActive: true } as any);
  jest.mocked(live.findLiveWarehouse).mockResolvedValue({ guid: ids.warehouse, name: 'Test warehouse', isActive: true, isDefault: false, isPickup: false } as any);
  jest.mocked(live.findLiveContract).mockResolvedValue({ guid: ids.contract, number: 'Test contract', isActive: true,
    status: 'Действует', purpose: 'Реализация', organizationGuid: ids.org } as any);
  jest.mocked(live.findLiveAgreement).mockResolvedValue({ guid: ids.agreement, name: 'Test agreement', isActive: true,
    status: 'Действует',
    organizationGuid: ids.org, organization: { guid: ids.org, name: 'Test org' },
    counterpartyGuid: ids.cp, contract: { guid: ids.contract, number: 'Test' },
    warehouse: { guid: ids.warehouse, name: 'Test' }, priceType: { guid: ids.price, name: 'Test' } } as any);
  jest.mocked(live.findLiveDeliveryAddress).mockResolvedValue({ guid: ids.address, fullAddress: 'Test address', isActive: true, isDefault: true } as any);
  jest.mocked(live.findLivePriceType).mockResolvedValue({ guid: ids.price, name: 'Test price', isActive: true, code: null });
  jest.mocked(live.getLiveProductsByGuids).mockImplementation(async () => [product]);
});

it('persists an incomplete recovery copy without 1C or export and isolates owners', async () => {
  const id = randomUUID();
  const data = draftBackupSchema.parse({ clientRevision: 1, payload: { organizationGuid: '', items: [] }, order: { comment: 'Incomplete' } });
  await saveDraftBackup(userId, id, data);
  expect((await getDraftBackup(userId, id))?.payload).toEqual(data.payload);
  expect(await getDraftBackup(otherUserId, id)).toBeNull();
  expect(await prisma.order.count({ where: { clientOrderId: id } })).toBe(0);
  expect(live.getLiveProductsByGuids).not.toHaveBeenCalled();
  expect(requestClientOrdersExportWakeup).not.toHaveBeenCalled();
  await expect(saveDraftBackup(userId, id, { ...data, payload: { items: [1] } })).rejects.toBeInstanceOf(DraftBackupConflict);
  await saveDraftBackup(userId, id, { ...data, clientRevision: 2 });
  await expect(saveDraftBackup(userId, id, data)).rejects.toBeInstanceOf(DraftBackupConflict);
});

it('edits an ordinary API draft from 60 to 20 before first submission, without losing conflict/export protection', async () => {
  const id = randomUUID();
  product.stock.available = 1000;
  const initial = { ...body(), intent: 'SAVE' as const,
    items: [{ ...body().items[0], quantity: 60 }, { ...body().items[1], quantity: 1 }] };
  const draft = await putClientOrderByClientId(userId, id, initial);
  expect(draft.syncState).toBe('DRAFT');
  expect(draft).toMatchObject({ draftReview: null });
  if (!('contentToken' in draft) || !draft.contentToken) throw new Error('Local draft must expose its content token');
  expect(requestClientOrdersExportWakeup).not.toHaveBeenCalled();
  const request = { ...initial, clientRevision: 2, intent: 'SUBMIT' as const,
    integrity: { baseContentToken: draft.contentToken },
    items: [{ ...initial.items[0], quantity: 20 }, initial.items[1],
      { ...initial.items[1], lineGuid: 'line-c' }, { ...initial.items[1], lineGuid: 'line-d' }] };
  await expect(putClientOrderByClientId(userId, id, {
    ...request, integrity: { baseContentToken: 'stale' },
  })).rejects.toMatchObject({ details: { kind: 'ORDER_CONTENT_CONFLICT' } });
  const unchanged = await prisma.order.findFirstOrThrow({ where: { clientOrderId: id }, include: { items: true } });
  expect(unchanged.clientRevision).toBe(1);
  expect(unchanged.items).toHaveLength(2);
  const sent = await putClientOrderByClientId(userId, id, request);
  if (!('contentToken' in sent) || !sent.contentToken) throw new Error('Queued order must expose its content token');
  expect(sent.guid).toBe(draft.guid);
  expect(sent.syncState).toBe('QUEUED');
  const saved = await prisma.order.findFirstOrThrow({ where: { clientOrderId: id }, include: { items: true } });
  expect(saved.items).toHaveLength(4);
  expect(Number(saved.items.find(i => i.lineGuid === 'line-a')?.quantity)).toBe(20);
  expect(saved.submitRequestedAt).not.toBeNull();
  expect(saved.clientRevision).toBe(2);
  expect((await putClientOrderByClientId(userId, id, request)).guid).toBe(sent.guid);
  expect(await prisma.order.count({ where: { clientOrderId: id } })).toBe(1);
  await expect(putClientOrderByClientId(userId, id, { ...request, clientRevision: 3,
    integrity: { baseContentToken: sent.contentToken }, items: request.items.slice(0, 2),
  })).rejects.toMatchObject({ details: { kind: 'ORDER_CHANGE_REVIEW_REQUIRED' } });
  expect(await prisma.orderItem.count({ where: { orderId: saved.id } })).toBe(4);
});

it('keeps both backup and normal DRAFT on shortage, then queues the same order without duplicates', async () => {
  const id = randomUUID();
  const request = body();
  await saveDraftBackup(userId, id, { clientRevision: 1, payload: { ...request, deliveryDate: '2026-10-10' } });
  const rejected = await putClientOrderByClientId(userId, id, request).catch(error => error);
  if (rejected.code !== 'STOCK_SHORTAGE') throw rejected;
  expect(rejected).toMatchObject({ code: 'STOCK_SHORTAGE',
    details: { draftSaved: true, items: [expect.objectContaining({ required: 5, available: 1 })] } });
  const draft = await prisma.order.findFirstOrThrow({ where: { createdByUserId: userId, clientOrderId: id }, include: { items: true } });
  expect(draft.syncState).toBe('DRAFT');
  expect(draft.submitRequestedAt).toBeNull();
  expect(draft.items).toHaveLength(2);
  expect((draft.draftReview as any).code).toBe('STOCK_SHORTAGE');
  await expect(submitClientOrder(draft.guid!, userId, { revision: draft.revision })).rejects.toMatchObject({ code: 'STOCK_SHORTAGE' });
  expect(requestClientOrdersExportWakeup).not.toHaveBeenCalled();
  expect((await getDraftBackup(userId, id))?.review).toMatchObject({ code: 'STOCK_SHORTAGE' });
  product.stock.available = 10;
  const sent = await putClientOrderByClientId(userId, id, request);
  expect(sent.guid).toBe(draft.guid);
  expect(sent.syncState).toBe('QUEUED');
  expect(sent).toMatchObject({ draftReview: null });
  const repeated = await putClientOrderByClientId(userId, id, request);
  expect(repeated.guid).toBe(sent.guid);
  expect(await prisma.order.count({ where: { createdByUserId: userId, clientOrderId: id } })).toBe(1);
  expect((await getClientOrderByClientId(userId, id)).guid).toBe(sent.guid);
  product.stock.available = 0;
  await expect(putClientOrderByClientId(userId, id, { ...request, clientRevision: 2 })).rejects.toMatchObject({ code: 'STOCK_SHORTAGE' });
  const protectedOrder = await prisma.order.findUniqueOrThrow({ where: { id: draft.id } });
  expect(protectedOrder.syncState).toBe('QUEUED');
  expect(protectedOrder.clientRevision).toBe(1);
  // An older committed retry wins even when a newer recovery copy exists.
  expect((await putClientOrderByClientId(userId, id, request)).guid).toBe(sent.guid);
});

it('applies current prices when retrying a rejected draft at the same client revision', async () => {
  const id = randomUUID();
  const request = body();
  await expect(putClientOrderByClientId(userId, id, request)).rejects.toMatchObject({ code: 'STOCK_SHORTAGE' });
  product.stock.available = 10;
  product.basePrice = 120;
  const sent = await putClientOrderByClientId(userId, id, { ...request, offlineReview: { pricePolicy: 'USE_CURRENT' } });
  expect(sent.syncState).toBe('QUEUED');
  const order = await prisma.order.findFirstOrThrow({ where: { createdByUserId: userId, clientOrderId: id }, include: { items: true } });
  expect(Number(order.totalAmount)).toBe(600);
  expect(order.items.every(item => Number(item.basePrice) === 120)).toBe(true);
});

it('keeps the backup if 1C is unavailable and does not enqueue anything', async () => {
  const id = randomUUID();
  jest.mocked(live.getLiveProductsByGuids).mockRejectedValue(new OnecLpAppNetworkError('Test offline'));
  await expect(putClientOrderByClientId(userId, id, body())).rejects.toMatchObject({ code: 'ONEC_UNAVAILABLE' });
  expect((await getDraftBackup(userId, id))?.payload).toBeTruthy();
  expect(await prisma.order.count({ where: { clientOrderId: id } })).toBe(0);
  expect(requestClientOrdersExportWakeup).not.toHaveBeenCalled();
});

it('accepts an explicitly corrected shortage draft as a newer revision without another order', async () => {
  const id = randomUUID();
  const request = body();
  await expect(putClientOrderByClientId(userId, id, request)).rejects.toMatchObject({ code: 'STOCK_SHORTAGE' });
  const sent = await putClientOrderByClientId(userId, id, { ...request, clientRevision: 2,
    items: [{ ...request.items[0], quantity: 1 }] });
  expect(sent.syncState).toBe('QUEUED');
  expect(await prisma.order.count({ where: { createdByUserId: userId, clientOrderId: id } })).toBe(1);
});

it('serializes concurrent backup revisions without losing the newest contents', async () => {
  const id = randomUUID();
  await Promise.allSettled([saveDraftBackup(userId, id, { clientRevision: 1, payload: { comment: 'old', items: [] } }),
    saveDraftBackup(userId, id, { clientRevision: 2, payload: { comment: 'new', items: [] } })]);
  const copy = await getDraftBackup(userId, id);
  expect(copy?.clientRevision).toBe(2);
  expect(copy?.payload).toEqual({ comment: 'new', items: [] });
  expect(await prisma.clientOrderDraftBackup.count({ where: { userId, clientOrderId: id } })).toBe(1);
});

async function acceptedFixture() {
  const id = randomUUID();
  product.stock.available = 100;
  const initial = { ...body(), items: [{ ...body().items[0], quantity: 2 }] };
  const sent = await putClientOrderByClientId(userId, id, initial, { storedResultOnly: true });
  if (!sent.guid) throw new Error('Missing fixture order guid');
  await prisma.order.update({ where: { guid: sent.guid }, data: { status: 'CONFIRMED', syncState: 'SYNCED',
    number1c: `TEST-${id}`, isPostedIn1c: true, revision: { increment: 1 }, last1cSnapshot: { test: true } } });
  return { id, initial, current: { ...await getStoredClientOrderForSubmission(sent.guid, userId), guid: sent.guid } };
}

it('incident 2 -> 1: requires explicit confirmation but not fresh free stock for a smaller accepted allocation', async () => {
  const { id, initial, current } = await acceptedFixture();
  product.stock.available = 0;
  const change = { ...initial, clientRevision: 2, items: [{ ...initial.items[0], quantity: 1 }] };
  await expect(putClientOrderByClientId(userId, id, change, { storedResultOnly: true }))
    .rejects.toMatchObject({ details: { kind: 'ORDER_CHANGE_REVIEW_REQUIRED' } });
  const preview = await previewClientOrderAmendment(userId, id, change);
  expect((await previewClientOrderAmendment(userId, `legacy-server:${current.guid}`, { ...change, clientRevision: 1 })).orderGuid).toBe(current.guid);
  expect(preview).toMatchObject({ requiresConfirmation: true, changes: [expect.objectContaining({ before: 2, after: 1 })] });
  const sent = await putClientOrderByClientId(userId, id, { ...change,
    integrity: { baseContentToken: preview.baseContentToken, confirmationToken: preview.confirmationToken } }, { storedResultOnly: true });
  expect(sent).toMatchObject({ guid: current.guid, clientRevision: 2, syncState: 'QUEUED', totalAmount: 100 });
  expect(await prisma.order.count({ where: { createdByUserId: userId, clientOrderId: id } })).toBe(1);
  expect(sent.items[0].quantity).toBe(1);
});

it('does not allow an increase or movement to another warehouse using the previous accepted quantity', async () => {
  const { id, initial, current } = await acceptedFixture();
  product.stock.available = 0;
  await expect(putClientOrderByClientId(userId, id, { ...initial, clientRevision: 2,
    items: [{ ...initial.items[0], quantity: 3 }] }, { storedResultOnly: true }))
    .rejects.toMatchObject({ code: 'STOCK_SHORTAGE', details: { items: [expect.objectContaining({ required: 3, available: 2 })] } });
  await expect(putClientOrderByClientId(userId, id, { ...initial, clientRevision: 3, warehouseGuid: 'another-warehouse',
    items: [{ ...initial.items[0], quantity: 1 }] }, { storedResultOnly: true }))
    .rejects.toMatchObject({ code: 'STOCK_SHORTAGE', details: { items: [expect.objectContaining({ required: 1, available: 0 })] } });
  expect(await getStoredClientOrderForSubmission(current.guid, userId)).toMatchObject({ clientRevision: 1, totalAmount: 200, syncState: 'SYNCED' });
});

it('incident stale content: read-only preview lists differences, never rebases a write silently, and fences subsequent changes', async () => {
  const { id, initial, current } = await acceptedFixture();
  await prisma.order.update({ where: { guid: current.guid }, data: { paymentForm: 'Наличная' } });
  const change = { ...initial, clientRevision: 2, integrity: { baseContentToken: current.contentToken! },
    items: [...initial.items, { ...initial.items[0], lineGuid: 'extra-line', quantity: 1 }] };
  await expect(putClientOrderByClientId(userId, id, change, { storedResultOnly: true }))
    .rejects.toMatchObject({ details: { kind: 'ORDER_CONTENT_CONFLICT' } });
  const before = await getStoredClientOrderForSubmission(current.guid, userId);
  const preview = await previewClientOrderAmendment(userId, id, change);
  expect(preview.changes).toContainEqual(expect.objectContaining({ reason: 'Добавление строки' }));
  expect(await getStoredClientOrderForSubmission(current.guid, userId)).toEqual(before);
  await expect(previewClientOrderAmendment(otherUserId, id, change)).rejects.toMatchObject({ status: 404 });
  await prisma.order.update({ where: { guid: current.guid }, data: { comment: 'Concurrent 1C change' } });
  await expect(putClientOrderByClientId(userId, id, { ...change, integrity: { baseContentToken: preview.baseContentToken } }, { storedResultOnly: true }))
    .rejects.toMatchObject({ details: { kind: 'ORDER_CONTENT_CONFLICT' } });
  const refreshed = await previewClientOrderAmendment(userId, id, change);
  const result = await putClientOrderByClientId(userId, id, { ...change, integrity: { baseContentToken: refreshed.baseContentToken } }, { storedResultOnly: true });
  expect(result.guid).toBe(current.guid);
  expect(result.items).toHaveLength(2);
});

it('does not use an accepted-stock allowance after the baseline changes during live validation', async () => {
  const { id, initial, current } = await acceptedFixture();
  const change = { ...initial, clientRevision: 2, items: [{ ...initial.items[0], quantity: 1 }] };
  const preview = await previewClientOrderAmendment(userId, id, change);
  product.stock.available = 0;
  jest.mocked(live.getLiveProductsByGuids).mockImplementationOnce(async () => {
    await prisma.order.update({ where: { guid: current.guid }, data: { comment: 'Changed during stock read' } });
    return [product];
  });
  await expect(putClientOrderByClientId(userId, id, { ...change,
    integrity: { baseContentToken: preview.baseContentToken, confirmationToken: preview.confirmationToken } }, { storedResultOnly: true }))
    .rejects.toMatchObject({ details: { kind: 'ORDER_CONTENT_CONFLICT' } });
  expect(await getStoredClientOrderForSubmission(current.guid, userId)).toMatchObject({ clientRevision: 1,
    syncState: 'SYNCED', totalAmount: 200, comment: 'Changed during stock read' });
});
