import { resolveDraftDeliveryMethod } from '../src/modules/clientOrders/clientOrders.delivery';

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
