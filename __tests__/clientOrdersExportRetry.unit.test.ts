jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  order: { findFirst: jest.fn() }, orderEvent: { findFirst: jest.fn(), create: jest.fn() }, $transaction: jest.fn(),
}, pool: { connect: jest.fn() } }));
jest.mock('../src/lib/redis', () => ({ getRedis: () => ({ isOpen: false }) }));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({ getLiveProductsByGuids: jest.fn(), getLiveClientOrder: jest.fn() }));
jest.mock('../src/modules/onec/onec.lpApp.client', () => ({
  ...jest.requireActual('../src/modules/onec/onec.lpApp.client'),
  getOnecLpAppClientOrder: jest.fn(), postOnecLpAppClientOrder: jest.fn(),
  putOnecLpAppClientOrder: jest.fn(), pingOnecLpApp: jest.fn(),
}));
import { Prisma } from '@prisma/client';
import prisma, { pool } from '../src/prisma/client';
import { exportOrder, markOrderExportFailure } from '../src/services/clientOrdersExportWorker';
import { buildQueuedOrderPayload } from '../src/modules/onec/onec.orderQueuePayload';
import { getOnecLpAppClientOrder, postOnecLpAppClientOrder, putOnecLpAppClientOrder, pingOnecLpApp, OnecLpAppHttpError } from '../src/modules/onec/onec.lpApp.client';
import { ATOMIC_ORDER_WRITE_PROTOCOL, OnecOrderWriteUncertainError } from '../src/modules/onec/onec.orderWriteSafety';
import { getLiveClientOrder } from '../src/modules/clientOrders/clientOrders.onecLive';
import { CANCEL_FAILURE_POLICY, ClientOrderCancellationDenied } from '../src/modules/clientOrders/clientOrderCancellation';

const order: any = { id: 'order', guid: 'app-order', revision: 3, status: 'QUEUED', syncState: 'QUEUED',
  exportAttempts: 1, source: 'MANAGER_APP', organization: { guid: 'org' }, counterparty: { guid: 'client' },
  agreement: { guid: 'agreement' }, contract: { guid: 'contract' }, warehouse: { guid: 'warehouse' },
  deliveryAddress: { guid: 'address' }, deliveryDate: new Date(),
  items: [{ lineGuid: 'line', product: { guid: 'product' }, quantity: new Prisma.Decimal(2), quantityBase: new Prisma.Decimal(2),
    basePrice: new Prisma.Decimal(100), price: new Prisma.Decimal(100), package: null, isCancelled: false }] };
const packet = () => ({ ...buildQueuedOrderPayload(order), requestId: 'original-request' });
const response = () => ({ item: { appGuid: order.guid, documentGuid: 'document', number1c: 'НОУТ-115292',
  organization: order.organization, counterparty: order.counterparty, lastImportedRevision: order.revision,
  isPostedIn1c: true, items: packet().items } });
let tx: any;
let connection: any;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CLIENT_ORDERS_EXPORT_STOCK_PREFLIGHT_DISABLED = '1';
  connection = { query: jest.fn().mockResolvedValue({ rows: [{ locked: true }] }), release: jest.fn() };
  (pool.connect as jest.Mock).mockResolvedValue(connection);
  (prisma.order.findFirst as jest.Mock).mockResolvedValue(order);
  (prisma.orderEvent.findFirst as jest.Mock).mockResolvedValueOnce({ payload: packet() })
    .mockResolvedValueOnce({ eventType: 'ORDER_EXPORT_PACKET', payload: packet() });
  (pingOnecLpApp as jest.Mock).mockResolvedValue({ clientOrderWriteProtocolVersion: ATOMIC_ORDER_WRITE_PROTOCOL });
  (getOnecLpAppClientOrder as jest.Mock).mockResolvedValue(response());
  (postOnecLpAppClientOrder as jest.Mock).mockResolvedValue(response());
  tx = { order: { findFirst: jest.fn().mockResolvedValue({ revision: 3 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn() } };
  (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
});

describe('new cancellation business denials without sticky document errors', () => {
  const cancelling = () => ({ ...order, status: 'CANCELLED', syncState: 'CANCEL_REQUESTED' });
  const policy = { failurePolicy: CANCEL_FAILURE_POLICY, previousStatus: 'CONFIRMED', previousSyncState: 'SYNCED',
    previousExportError: null, previous1cError: null };
  const live: any = { appGuid: order.guid, isPostedIn1c: true, hasRealization: true, documentStatus1c: 'Закрыт' };
  const refused = () => new OnecLpAppHttpError(500, {}, 'Нельзя отменить заказ в 1С: по заказу создана проведенная реализация товаров и услуг.');

  it('checks a new cancellation before POST and never writes when a realization appeared after enqueue', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(cancelling());
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ payload: policy });
    jest.mocked(getLiveClientOrder).mockResolvedValue(live);
    await expect(exportOrder(cancelling())).rejects.toThrow('Отмена не выполнена');
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(putOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });

  it('restores the confirmed status, stops retries and records the denial only in history', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue({ payload: policy });
    jest.mocked(getLiveClientOrder).mockResolvedValue(live);
    await markOrderExportFailure(cancelling(), refused());
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'CONFIRMED', syncState: 'SYNCED', hasRealization: true, cancelRequestedAt: null,
      lastExportError: null, last1cError: null,
    }) }));
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'ONEC_ORDER_CANCEL_DENIED', payload: expect.objectContaining({ willRetry: false, stateVerified: true }),
    }) }));
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
  });

  it('keeps pre-cancel state when readback is unavailable; never invents a successful cancellation', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue({ payload: policy });
    jest.mocked(getLiveClientOrder).mockRejectedValue(new Error('offline'));
    await markOrderExportFailure(cancelling(), refused());
    expect(tx.order.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CONFIRMED', syncState: 'SYNCED', lastExportError: null });
    expect(tx.orderEvent.create.mock.calls[0][0].data.payload.stateVerified).toBe(false);
  });

  it('uses actual unposted state from a fresh readback rather than the old confirmed flag', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue({ payload: policy });
    jest.mocked(getLiveClientOrder).mockResolvedValue({ ...live, isPostedIn1c: false, hasRealization: false });
    await markOrderExportFailure(cancelling(), new OnecLpAppHttpError(500, {}, 'Нельзя отменить заказ в 1С: объект документа не получен.'));
    expect(tx.order.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SENT_TO_1C', isPostedIn1c: false, syncState: 'SYNCED' });
  });

  it('does not apply the new policy to old pending cancellations', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue({ payload: { requiresOnecCancel: true } });
    await markOrderExportFailure(cancelling(), refused());
    expect(tx.order.updateMany.mock.calls[0][0].data.syncState).toBe('CANCEL_REQUESTED');
    expect(tx.orderEvent.create.mock.calls[0][0].data.eventType).toBe('ONEC_ORDER_PUSH_ERROR');
    expect(getLiveClientOrder).not.toHaveBeenCalled();
  });

  it('keeps network/unknown failures retryable, rather than hiding them as business denials', async () => {
    await markOrderExportFailure(cancelling(), new OnecLpAppHttpError(500, {}, 'Непредвиденная ошибка'));
    expect(tx.order.updateMany.mock.calls[0][0].data.syncState).toBe('CANCEL_REQUESTED');
    expect(tx.orderEvent.create.mock.calls[0][0].data.payload.willRetry).toBe(true);
  });

  it('does not overwrite a newer order revision after a late refusal', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue({ payload: policy });
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    await markOrderExportFailure(cancelling(), new ClientOrderCancellationDenied(live));
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.order.updateMany.mock.calls[0][0].where).toMatchObject({ revision: 3, syncState: 'CANCEL_REQUESTED' });
  });
});
afterEach(() => { delete process.env.CLIENT_ORDERS_EXPORT_STOCK_PREFLIGHT_DISABLED; });

describe('worker retry without duplicate creates', () => {
  it('partial save + legacy HTTP 500: one write, one readback, then terminal error', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    (pingOnecLpApp as jest.Mock).mockResolvedValue({ clientOrdersApiVersion: 'v50' });
    (postOnecLpAppClientOrder as jest.Mock).mockRejectedValue(new OnecLpAppHttpError(500, {}, 'EmeWms module initialization failed'));
    let failure: any;
    try { await exportOrder(order); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    await markOrderExportFailure(order, failure.cause, failure.context);
    const frozen = (prisma.orderEvent.create as jest.Mock).mock.calls[0][0].data.payload;
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValueOnce({ payload: frozen })
      .mockResolvedValueOnce({ eventType: 'ORDER_EXPORT_PACKET', payload: frozen });
    (getOnecLpAppClientOrder as jest.Mock).mockRejectedValue(new OnecLpAppHttpError(500, {}, 'legacy lookup has no appGuid support'));
    failure = null;
    try { await exportOrder(order); } catch (error) { failure = error; }
    expect(failure.cause).toBeInstanceOf(OnecOrderWriteUncertainError);
    await markOrderExportFailure(order, failure.cause, failure.context);
    expect(postOnecLpAppClientOrder).toHaveBeenCalledTimes(1);
    expect(putOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(getOnecLpAppClientOrder).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany.mock.calls.at(-1)[0].data.syncState).toBe('ERROR');
    expect(tx.orderEvent.create.mock.calls.at(-1)[0].data.payload.willRetry).toBe(false);
  });
  it('persists a terminal reconciliation error with no automatic write retry', async () => {
    await markOrderExportFailure(order, new OnecOrderWriteUncertainError('Связь не найдена.'));
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncState: 'ERROR' }) }));
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({
      willRetry: false, nextRetryBackoffMs: null, code: 'ONEC_WRITE_RECONCILIATION_REQUIRED',
    }) }) }));
  });
  it('lost ACK is reconciled using GET, not POST or PUT', async () => {
    await exportOrder(order);
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(putOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      eventType: 'ONEC_ORDER_PUSH_OK', payload: expect.objectContaining({ transport: 'GET_RECONCILED', requestId: 'original-request' }),
    }) }));
  });
  it('legacy partial save cannot trigger the second of seven creates', async () => {
    (getOnecLpAppClientOrder as jest.Mock).mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await expect(exportOrder(order)).rejects.toThrow('защиты от дублей');
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(putOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });
  it('replays the exact atomic packet after an uncertain non-commit', async () => {
    const safe = { ...packet(), writeProtocol: ATOMIC_ORDER_WRITE_PROTOCOL };
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValueOnce({ payload: safe })
      .mockResolvedValueOnce({ eventType: 'ORDER_EXPORT_PACKET', payload: safe });
    (getOnecLpAppClientOrder as jest.Mock).mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await exportOrder(order);
    expect(postOnecLpAppClientOrder).toHaveBeenCalledTimes(1);
    expect(postOnecLpAppClientOrder).toHaveBeenCalledWith(safe);
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });
  it('checks old pending revision before freezing a new packet', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ eventType: 'ORDER_EXPORT_PACKET', payload: { ...packet(), revision: 2 } });
    (getOnecLpAppClientOrder as jest.Mock).mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await expect(exportOrder(order)).rejects.toThrow('защиты от дублей');
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(prisma.orderEvent.create).not.toHaveBeenCalled();
  });
  it('rejects incomplete readback without writing or acknowledging', async () => {
    (getOnecLpAppClientOrder as jest.Mock).mockResolvedValue({ item: { ...response().item, items: [] } });
    await expect(exportOrder(order)).rejects.toThrow('Состав заказа');
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
  it('takes the database lock before contacting 1C', async () => {
    connection.query.mockResolvedValue({ rows: [{ locked: false }] });
    await exportOrder(order);
    expect(getOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
  });
  it('rejects a frozen packet with a mismatched revision before any upstream calls', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValueOnce({ payload: { ...packet(), revision: 2 } })
      .mockResolvedValueOnce(null);
    await expect(exportOrder(order)).rejects.toThrow('Сохраненный пакет не соответствует');
    expect(pingOnecLpApp).not.toHaveBeenCalled();
    expect(getOnecLpAppClientOrder).not.toHaveBeenCalled();
    expect(postOnecLpAppClientOrder).not.toHaveBeenCalled();
  });
  it('fresh initial write freezes capability and request ID before POST', async () => {
    (prisma.orderEvent.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    await exportOrder(order);
    expect(getOnecLpAppClientOrder).not.toHaveBeenCalled();
    const stored = (prisma.orderEvent.create as jest.Mock).mock.calls[0][0].data.payload;
    expect(stored.writeProtocol).toBe(ATOMIC_ORDER_WRITE_PROTOCOL);
    expect(postOnecLpAppClientOrder).toHaveBeenCalledWith(expect.objectContaining({ requestId: stored.requestId, writeProtocol: stored.writeProtocol }));
    expect((prisma.orderEvent.create as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((postOnecLpAppClientOrder as jest.Mock).mock.invocationCallOrder[0]);
  });
});
