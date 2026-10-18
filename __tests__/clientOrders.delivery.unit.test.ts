import { resolveDraftDeliveryMethod } from '../src/modules/clientOrders/clientOrders.delivery';
import { Prisma } from '@prisma/client';
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), order: { findFirst: jest.fn() },
}, pool: {} }));
import prisma from '../src/prisma/client';
import { submitClientOrder } from '../src/modules/clientOrders/clientOrders.service';

test.each([undefined, null, '', '   '])('new drafts default to our delivery for %p', value => {
  expect(resolveDraftDeliveryMethod(value)).toBe('ДоКлиента');
});
test.each(['ДоКлиента', 'Самовывоз', 'СиламиПеревозчикаПоАдресу'])('preserves explicit %s', value => {
  expect(resolveDraftDeliveryMethod(value, 'ДоКлиента')).toBe(value);
});
test('does not erase explicit pickup or invent changes in linked historical orders', () => {
  expect(resolveDraftDeliveryMethod(null, 'Самовывоз')).toBe('Самовывоз');
  expect(resolveDraftDeliveryMethod(null, null, 'НОУТ-125211')).toBeNull();
  expect(resolveDraftDeliveryMethod('ДоКлиента', null, 'НОУТ-125211')).toBe('ДоКлиента');
});

test.each([
  ['DRAFT', null, null, 'ДоКлиента'],
  ['DRAFT', 'Самовывоз', null, 'Самовывоз'],
  ['DRAFT', 'ДоКлиента', null, 'ДоКлиента'],
  ['DRAFT', null, 'НОУТ-125211', null],
  ['QUEUED', null, null, undefined],
])('queue commit preserves delivery for %s / %s / %s', async (status, deliveryMethod, number1c, expected) => {
  const order = { id:'order',guid:'guid',revision:3,status,source:'MANAGER_APP',hasRealization:false,
    organizationId:'org',agreementId:'agreement',contractId:'contract',warehouseId:'warehouse',deliveryAddressId:'address',
    deliveryDate:new Date('2026-10-19T00:00:00Z'),deliveryMethod,number1c,
    items:[{quantity:new Prisma.Decimal(1),basePrice:new Prisma.Decimal(100),isCancelled:false}] };
  const tx = { $queryRaw:jest.fn().mockResolvedValue([{locked:true}]),
    order:{findFirst:jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(order).mockResolvedValue(null),update:jest.fn()},
    orderEvent:{create:jest.fn()} };
  (prisma.$transaction as jest.Mock).mockImplementation(fn=>fn(tx));
  // Simulate a lost detail read AFTER the queue commit, without contacting 1C.
  const lostDetail = new Error('detail response lost');
  (prisma.order.findFirst as jest.Mock).mockRejectedValue(lostDetail);
  await expect(submitClientOrder('guid',90,{revision:3})).rejects.toBe(lostDetail);
  expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
    status:'QUEUED',syncState:'QUEUED',deliveryMethod:expected,
  })}));
});
