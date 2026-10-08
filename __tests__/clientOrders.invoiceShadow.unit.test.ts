import prisma from '../src/prisma/client';
import { getClientOrderByGuid } from '../src/modules/clientOrders/clientOrders.service';
import { getLiveClientOrder, restoreClientOrderDetailSnapshot } from '../src/modules/clientOrders/clientOrders.onecLive';
import { readThroughClientOrdersCache } from '../src/modules/clientOrders/clientOrders.cache';
import { OnecLpAppHttpError, OnecLpAppNetworkError, OnecLpAppTimeoutError } from '../src/modules/onec/onec.lpApp.client';
import { isInvoiceShadowOrder } from '../src/modules/clientOrders/clientOrders.invoiceShadow';

jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  order: { findFirst: jest.fn() }, employeeProfile: { findUnique: jest.fn() },
  stockBalance: { findMany: jest.fn().mockResolvedValue([]) },
} }));
jest.mock('../src/lib/redis', () => ({ cacheGet: jest.fn(), cacheSet: jest.fn() }));
jest.mock('../src/modules/clientOrders/clientOrders.cache', () => ({
  ...jest.requireActual('../src/modules/clientOrders/clientOrders.cache'),
  readThroughClientOrdersCache: jest.fn(),
}));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({
  ...jest.requireActual('../src/modules/clientOrders/clientOrders.onecLive'),
  getLiveClientOrder: jest.fn(),
}));
jest.mock('../src/modules/clientOrders/clientOrders.productImages', () => ({
  enrichOrderItemsWithImages: jest.fn(async value => value),
}));

const guid = 'c500e658-c1fd-11f1-9d3a-f1cbadb7fc65';
const managerGuid = 'a35e2053-62ee-11f1-9f81-1c98ec138053';
function detail() {
  return restoreClientOrderDetailSnapshot({
    documentGuid: guid, guid, number1c: 'НОУТ-120880', status: 'CLOSED',
    hasRealization: true, isPostedIn1c: true, totalAmount: 101574,
    counterparty: { guid: 'cp', name: 'Customer' }, organization: { guid: 'org', name: 'Organization' },
    itemsCount: 4, items: [40320, 34860, 16170, 10224].map((amount, i) => ({
      lineGuid: `line-${i}`, product: { guid: `p-${i}`, name: `Product ${i}` },
      quantity: 1, price: amount, lineAmount: amount,
    })),
  }, guid)!;
}
function shadow(): any {
  return {
    id: 'shadow', guid, clientOrderId: null, revision: 1, number1c: 'НОУТ-120880',
    source: 'MANAGER_APP', status: 'CONFIRMED', syncState: 'SYNCED',
    totalAmount: 111798, hasRealization: true, isPostedIn1c: true,
    items: [], invoices: [], events: [], invoiceRequested: false,
    counterparty: { guid: 'cp', name: 'Customer' }, organization: null,
    last1cSnapshot: { invoiceShadow: true, item: { ...detail(), totalAmount: 111798 } },
  };
}

describe('invoice-only order details (НОУТ-120880)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(prisma.order.findFirst).mockResolvedValue(shadow());
    jest.mocked(prisma.employeeProfile.findUnique).mockResolvedValue({ onecUserGuid: managerGuid } as any);
    jest.mocked(readThroughClientOrdersCache).mockImplementation(((_scope, _query, _ttl, loader) => loader()) as typeof readThroughClientOrdersCache);
    jest.mocked(getLiveClientOrder).mockResolvedValue(detail());
  });

  it('returns all live rows, current total and status instead of the empty bookkeeping record', async () => {
    const result = await getClientOrderByGuid(guid, 95);
    expect(result).toMatchObject({ totalAmount: 101574, status: 'CLOSED', readOnly: true, stale: false, origin: 'merged' });
    expect(result.items).toHaveLength(4);
    expect(result.items.reduce((sum, row) => sum + Number(row.lineAmount), 0)).toBe(101574);
    expect(result).toHaveProperty('contentToken', undefined);
    expect(result).toHaveProperty('invoices', []);
    expect(getLiveClientOrder).toHaveBeenCalledWith(guid, { managerGuid, appGuid: guid });
  });

  it.each([new OnecLpAppNetworkError('offline'), new OnecLpAppTimeoutError('/client-orders/order', 1000)])('uses the complete saved snapshot during a transient outage: %s', async error => {
    jest.mocked(getLiveClientOrder).mockRejectedValueOnce(error);
    const result = await getClientOrderByGuid(guid, 95);
    expect(result).toMatchObject({ totalAmount: 111798, readOnly: true, stale: true });
    expect(result.items).toHaveLength(4);
    expect(result).toHaveProperty('contentToken', undefined);
  });

  it.each([401, 403, 404])('does not hide upstream %i behind a saved snapshot', async status => {
    jest.mocked(getLiveClientOrder).mockRejectedValueOnce(new OnecLpAppHttpError(status, {}, 'denied'));
    await expect(getClientOrderByGuid(guid, 95)).rejects.toMatchObject({ status: status === 401 ? 403 : status });
  });

  it.each(['missing', 'partial', 'foreign'])('fails explicitly if the offline snapshot is %s', async kind => {
    const order = shadow();
    if (kind === 'missing') delete order.last1cSnapshot.item.items;
    if (kind === 'partial') order.last1cSnapshot.item.items.pop();
    if (kind === 'foreign') order.last1cSnapshot.item.documentGuid = 'another-document';
    jest.mocked(prisma.order.findFirst).mockResolvedValueOnce(order);
    jest.mocked(getLiveClientOrder).mockRejectedValueOnce(new OnecLpAppNetworkError('offline'));
    await expect(getClientOrderByGuid(guid, 95)).rejects.toMatchObject({ status: 502, code: 'ONEC_UNAVAILABLE' });
  });

  it('keeps API-owned editable content and its matching integrity token authoritative', async () => {
    const order = shadow();
    order.hasRealization = false;
    order.last1cSnapshot.invoiceShadow = false;
    order.clientOrderId = 'local-draft';
    order.items = [{ ...detail().items[0], quantity: 7, price: 100, lineAmount: 700 }];
    order.totalAmount = 700;
    jest.mocked(prisma.order.findFirst).mockResolvedValueOnce(order);
    jest.mocked(getLiveClientOrder).mockResolvedValueOnce({ ...detail(), hasRealization: false, readOnly: false });
    const result = await getClientOrderByGuid(guid, 95);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].quantity).toBe(7);
    expect(result.totalAmount).toBe(700);
    expect(result).toHaveProperty('contentToken', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result.readOnly).toBe(false);
  });

  it('never interprets an ordinary empty draft or an edited/queued shadow as invoice-only', () => {
    expect(isInvoiceShadowOrder(shadow())).toBe(true);
    expect(isInvoiceShadowOrder({ ...shadow(), last1cSnapshot: null })).toBe(false);
    expect(isInvoiceShadowOrder({ ...shadow(), clientOrderId: 'device-order' })).toBe(false);
    expect(isInvoiceShadowOrder({ ...shadow(), items: detail().items })).toBe(false);
    expect(isInvoiceShadowOrder({ ...shadow(), syncState: 'QUEUED' })).toBe(false);
  });

  it('preserves manager isolation for a different local owner', async () => {
    jest.mocked(prisma.order.findFirst).mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'foreign' } as any);
    await expect(getClientOrderByGuid(guid, 28)).rejects.toMatchObject({ status: 404 });
    expect(getLiveClientOrder).not.toHaveBeenCalled();
  });
});
