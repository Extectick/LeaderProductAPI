jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), syncRun: { create: jest.fn() },
}, pool: {} }));
import prisma from '../src/prisma/client';
import { canRetryDuplicateLineSnapshot } from '../src/modules/onec/onec.orderSnapshotRecovery';
import { handleOrdersSnapshotBatch } from '../src/modules/onec/onec.controllers';

const line = (lineGuid: string, extra = {}) => ({ lineGuid, product: { guid: 'product' },
  quantity: 7.335, quantityBase: 7.335, price: 505, lineAmount: 3704.18, ...extra });
const failed = { guid: 'app', number1c: 'НОУТ-123744', baseRevision: 1, revision: 2,
  sourceUpdatedAt: '2026-10-13T14:25:41Z', items: [line('same'), line('same')] };
const snapshot = () => ({ ...failed, sourceUpdatedAt: '2026-10-13T15:50:00Z',
  status: 'CONFIRMED', syncState: 'SYNCED', isPostedIn1c: true, totalAmount: 3704.18,
  items: [line('same'), line('onec-row:cancelled', { quantity: 0.665, quantityBase: 0.665,
    lineAmount: 335.83, isCancelled: true })] });
const order = () => ({ id: 'order', guid: 'app', number1c: 'НОУТ-123744', source: 'MANAGER_APP',
  revision: 2, status: 'CONFIRMED', syncState: 'ERROR', last1cError: 'Duplicate lineGuid same in order snapshot',
  lastExportError: null, cancelRequestedAt: null, last1cSnapshot: failed });

describe('retry of a rejected duplicate-line snapshot', () => {
  it('allows exactly the failed acknowledged revision', () => {
    expect(canRetryDuplicateLineSnapshot(order(), snapshot())).toBe(true);
  });
  it.each([
    { syncState: 'QUEUED' }, { syncState: 'CANCEL_REQUESTED' }, { syncState: 'CONFLICT' },
    { status: 'QUEUED' }, { status: 'DRAFT' }, { status: 'CANCELLED' },
    { revision: 3 }, { lastExportError: 'Unknown write result' }, { cancelRequestedAt: new Date() },
    { source: 'MARKETPLACE_CLIENT' }, { last1cError: 'Posting failed' },
    { last1cSnapshot: null }, { last1cSnapshot: { ...failed, items: [line('unique')] } },
    { last1cSnapshot: { ...failed, guid: 'other' } },
  ])('keeps unrelated/pending state protected: %j', extra => {
    expect(canRetryDuplicateLineSnapshot({ ...order(), ...extra }, snapshot())).toBe(false);
  });
  it.each([{ guid: 'other' }, { number1c: 'НОУТ-other' }, { revision: 3 },
    { baseRevision: 2 }, { sourceUpdatedAt: '2026-10-12T00:00:00Z' }])('rejects mismatched/stale input: %j', extra => {
    expect(canRetryDuplicateLineSnapshot(order(), { ...snapshot(), ...extra })).toBe(false);
  });
});

describe('snapshot controller recovery', () => {
  let tx: any;
  let res: any;
  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      order: { findUnique: jest.fn().mockResolvedValue(order()), update: jest.fn() },
      orderItem: { count: jest.fn().mockResolvedValue(6), deleteMany: jest.fn(), createMany: jest.fn() },
      orderEvent: { create: jest.fn() },
      product: { findUnique: jest.fn().mockResolvedValue({ id: 'product', baseUnit: { id: 'unit' } }) },
      syncRun: { findUniqueOrThrow: jest.fn().mockResolvedValue({ entity: 'ORDERS_SNAPSHOT', direction: 'IMPORT' }), update: jest.fn() },
      syncRunItem: { createMany: jest.fn() },
    };
    (prisma.syncRun.create as jest.Mock).mockResolvedValue({ id: 'run' });
    (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
    res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  });
  const run = async (item: unknown = snapshot()) => handleOrdersSnapshotBatch({ body: { secret: 'secret', items: [item] } } as any, res);
  it('applies the corrected lines, preserves cancelled quantity and clears the actual snapshot error', async () => {
    await run();
    const rows = tx.orderItem.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ lineGuid: 'onec-row:cancelled', isCancelled: true });
    expect(Number(rows[1].quantityBase)).toBe(0.665);
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      revision: 2, syncState: 'SYNCED', isPostedIn1c: true, last1cError: null,
    }) }));
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'ONEC_ORDER_SNAPSHOT_APPLIED' }) }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ receiptVersion: 'order-snapshot-receipt-v1',
      results: [{ key: 'app', status: 'ok', applied: true, retryable: false, outcome: 'applied', currentRevision: 2 }] }));
  });
  it.each(['QUEUED', 'CANCEL_REQUESTED', 'CONFLICT'])('never replaces pending %s contents', async syncState => {
    tx.order.findUnique.mockResolvedValue({ ...order(), syncState });
    await run();
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ status: 'ok', applied: false,
      retryable: true, outcome: 'deferred', code: 'LOCAL_REVISION_PENDING' });
  });
  it('still rejects a duplicate incoming ID before deleting any old line', async () => {
    await run({ ...snapshot(), items: [line('same'), line('same')] });
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncState: 'ERROR' }) }));
    expect(res.json.mock.calls[0][0].results[0].status).toBe('error');
  });
  it('preserves all old lines when even the last product reference is missing', async () => {
    tx.product.findUnique.mockResolvedValueOnce({ id: 'product', baseUnit: { id: 'unit' } }).mockResolvedValueOnce(null);
    await run();
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.orderItem.createMany).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0].error).toContain('not found');
  });
  it('distinguishes a missing order from an applied receipt despite HTTP success', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await run();
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: true,
      results: [{ key: 'app', status: 'error', applied: false, retryable: false, code: 'ORDER_NOT_FOUND' }] });
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
  });
  it('replays the exact accepted snapshot without rewriting lines or incrementing revision', async () => {
    tx.order.update.mockImplementation(async ({ data }: any) => {
      tx.order.findUnique.mockResolvedValue({ ...order(), ...data,
        last1cSnapshot: JSON.parse(JSON.stringify(data.last1cSnapshot)) });
    });
    await run();
    await run();
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.orderEvent.create).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[1][0].results[0]).toEqual({ key: 'app', status: 'ok', applied: true,
      retryable: false, outcome: 'duplicate', currentRevision: 2 });
  });
  it('also replays a legacy snapshot with implicit revision exactly once', async () => {
    const item = { ...snapshot(), revision: undefined };
    tx.order.findUnique.mockResolvedValue({ ...order(), revision: 1, syncState: 'SYNCED' });
    tx.order.update.mockImplementation(async ({ data }: any) => {
      tx.order.findUnique.mockResolvedValue({ ...order(), ...data,
        last1cSnapshot: JSON.parse(JSON.stringify(data.last1cSnapshot)) });
    });
    await run(item);
    await run(item);
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[1][0].results[0]).toMatchObject({ applied: true, outcome: 'duplicate', currentRevision: 2 });
  });
  it('does not acknowledge an old accepted snapshot while a newer manager revision is queued', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), status: 'QUEUED', syncState: 'QUEUED', revision: 3,
      last1cSnapshot: snapshot() });
    await run();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: false, retryable: true, outcome: 'deferred' });
  });
  it('keeps legacy QUEUED/SYNCED orders protected and explicitly deferred', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), status: 'QUEUED', syncState: 'SYNCED', revision: 1 });
    await run();
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: false, retryable: true, outcome: 'deferred' });
  });
  it('still applies initial document details aligned with the direct worker ACK revision', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), status: 'SENT_TO_1C', syncState: 'SYNCED', revision: 2,
      last1cSnapshot: { item: { guid: 'app', revision: 1, isPostedIn1c: true } } });
    await run();
    expect(tx.orderItem.createMany).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: true, outcome: 'applied', currentRevision: 2 });
  });
  it('applies the next outgoing document revision after an accepted snapshot', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), syncState: 'SYNCED', last1cSnapshot: snapshot() });
    await run({ ...snapshot(), baseRevision: 2, revision: 3, sourceUpdatedAt: '2026-10-13T16:00:00Z', comment: 'Changed in 1C' });
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revision: 3 }) }));
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: true, outcome: 'applied', currentRevision: 3 });
  });
  it.each([
    { revision: 3, last1cSnapshot: snapshot() },
    { revision: 2, last1cSnapshot: { ...snapshot(), sourceUpdatedAt: '2026-10-13T16:00:00.000Z' } },
  ])('rejects a late source version without corrupting a healthy order: %j', extra => {
    tx.order.findUnique.mockResolvedValue({ ...order(), syncState: 'SYNCED', ...extra });
    return run().then(() => {
      expect(tx.order.update).not.toHaveBeenCalled();
      expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: false, retryable: false,
        outcome: 'rejected', code: 'STALE_SNAPSHOT' });
    });
  });
  it('preserves the revision conflict guard and reports a non-applied receipt', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), syncState: 'SYNCED' });
    await run({ ...snapshot(), baseRevision: 99 });
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncState: 'CONFLICT' }) }));
    expect(res.json.mock.calls[0][0].results[0]).toMatchObject({ applied: false, retryable: false,
      code: 'REVISION_CONFLICT' });
  });
});
