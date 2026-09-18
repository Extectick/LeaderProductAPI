jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { $transaction: jest.fn() }, pool: {} }));
import prisma from '../src/prisma/client';
import { assertSavedOrderDidNotLoseItems, markOrderExportSuccess } from '../src/services/clientOrdersExportWorker';
const order: any = { id: 'order', guid: 'app', revision: 3, status: 'QUEUED', syncState: 'QUEUED',
  items: [{ lineGuid: 'line1', product: { guid: 'product1' }, quantity: 2, package: null, isCancelled: false },
    { lineGuid: 'line2', product: { guid: 'product2' }, quantity: 3, package: null, isCancelled: false }] };
const response = () => ({ item: { isPostedIn1c: true, items: order.items.map((i: any) => ({ ...i })) } });
describe('revision-bound export acknowledgement', () => {
  it('accepts 1C base-unit package normalization but checks base quantity', () => {
    const expected = { ...order, items: [{ ...order.items[0], quantityBase: 2, package: { guid: 'base-unit' } }] };
    const payload = { item: { items: [{ ...order.items[0], quantityBase: 2, package: null }] } };
    expect(() => assertSavedOrderDidNotLoseItems(expected, payload)).not.toThrow();
    payload.item.items[0].quantityBase = 1;
    expect(() => assertSavedOrderDidNotLoseItems(expected, payload)).toThrow();
  });
  it('rejects a partial nonempty 1C response', () => {
    const payload = response(); payload.item.items.pop();
    expect(() => assertSavedOrderDidNotLoseItems(order, payload)).toThrow('Состав заказа');
  });
  it('rejects changed product and quantity with the same line count', () => {
    const payload = response(); payload.item.items[0].quantity = 1;
    expect(() => assertSavedOrderDidNotLoseItems(order, payload)).toThrow();
    payload.item.items[0].quantity = 2; payload.item.items[0].product = { guid: 'wrong' };
    expect(() => assertSavedOrderDidNotLoseItems(order, payload)).toThrow();
  });
  it('accepts reordered intact lines', () => {
    const payload = response(); payload.item.items.reverse();
    expect(() => assertSavedOrderDidNotLoseItems(order, payload)).not.toThrow();
  });
  it('does not acknowledge a newer revision on a late response', async () => {
    const tx = { order: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() }, orderEvent: { create: jest.fn() } };
    (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
    await markOrderExportSuccess(order, response(), 'request', 'POST');
    expect(tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ revision: 3 }) }));
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'ONEC_ORDER_ACK_STALE' }) }));
  });
  it('CAS failure cannot produce a success event', async () => {
    const tx = { order: { findFirst: jest.fn().mockResolvedValue({ revision: 3 }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, orderEvent: { create: jest.fn() } };
    (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(tx));
    await markOrderExportSuccess(order, response(), 'request', 'POST');
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ revision: 3 }) }));
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
  });
});
