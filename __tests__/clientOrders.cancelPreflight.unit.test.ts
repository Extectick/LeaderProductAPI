jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  order: { findFirst: jest.fn() }, employeeProfile: { findUnique: jest.fn(async () => ({ onecUserGuid: 'manager' })) },
  $transaction: jest.fn(),
} }));
jest.mock('../src/lib/redis', () => ({ cacheGet: jest.fn(), cacheSet: jest.fn() }));
jest.mock('../src/modules/orders/orderIntegrity', () => ({
  ...jest.requireActual('../src/modules/orders/orderIntegrity'), lockOrderMutation: jest.fn(),
}));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({
  ...jest.requireActual('../src/modules/clientOrders/clientOrders.onecLive'), getLiveClientOrder: jest.fn(),
}));
import prisma from '../src/prisma/client';
import { getLiveClientOrder } from '../src/modules/clientOrders/clientOrders.onecLive';
import { cancelClientOrder } from '../src/modules/clientOrders/clientOrders.service';

let tx: any;
const existing: any = { id: 'id', guid: 'app', revision: 4, status: 'CONFIRMED', syncState: 'SYNCED',
  source: 'MANAGER_APP', isPostedIn1c: true, hasRealization: false };
beforeEach(() => {
  jest.clearAllMocks();
  tx = { order: { findFirst: jest.fn(async () => existing), update: jest.fn() }, orderEvent: { create: jest.fn() } };
  jest.mocked(prisma.order.findFirst).mockResolvedValue(existing);
  jest.mocked(prisma.$transaction).mockImplementation((async (fn: any) => fn(tx)) as any);
  jest.mocked(getLiveClientOrder).mockResolvedValue({ appGuid: 'app', documentGuid: 'doc', hasRealization: true, isPostedIn1c: true } as any);
});

it('rejects a new cancellation before enqueue, writes only action history, not the order', async () => {
  await expect(cancelClientOrder('app', 99, { revision: 4 })).rejects.toMatchObject({ status: 409, details: { action: 'CANCEL_DENIED' } });
  expect(tx.order.update).not.toHaveBeenCalled();
  expect(tx.orderEvent.create.mock.calls[0][0].data.eventType).toBe('ONEC_ORDER_CANCEL_DENIED');
  expect(getLiveClientOrder).toHaveBeenCalledWith('app', { managerGuid: 'manager', appGuid: 'app' });
});

it('does not access 1C or write for an unauthorized/missing order', async () => {
  jest.mocked(prisma.order.findFirst).mockResolvedValue(null);
  await expect(cancelClientOrder('app', 99, { revision: 4 })).rejects.toMatchObject({ status: 404 });
  expect(getLiveClientOrder).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('does not trust the state of a different order', async () => {
  jest.mocked(getLiveClientOrder).mockResolvedValue({ appGuid: 'other', documentGuid: 'other', hasRealization: true } as any);
  await expect(cancelClientOrder('app', 99, { revision: 4 })).rejects.toMatchObject({ status: 409 });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('does not cancel or change order status when fresh 1C verification fails', async () => {
  jest.mocked(getLiveClientOrder).mockRejectedValue(new Error('unavailable'));
  await expect(cancelClientOrder('app', 99, { revision: 4 })).rejects.toThrow('unavailable');
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
