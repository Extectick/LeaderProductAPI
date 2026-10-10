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
import { putClientOrderByClientId, getClientOrderByClientId, submitClientOrder } from '../src/modules/clientOrders/clientOrders.service';
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
