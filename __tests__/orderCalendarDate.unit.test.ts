import { matchesDeliveryDateRange, orderCalendarDate } from '../src/modules/clientOrders/orderCalendarDate';
const day = new Date('2026-10-26T00:00:00Z');
it.each(['2026-10-26', '2026-10-26T00:00:00', '2026-10-26T00:00:00Z', '2026-10-26T23:59:59+07:00'])('keeps calendar shipment day: %s', value => {
  expect(matchesDeliveryDateRange(value, day, day)).toBe(true);
});
it.each(['2026-10-25T23:59:59Z', '2026-10-27T00:00:00+07:00', null, '', '2026-02-30'])('excludes another or invalid day: %s', value => {
  expect(matchesDeliveryDateRange(value, day, day)).toBe(false);
});
it('accepts a range and open bounds without rounding into another day', () => {
  expect(matchesDeliveryDateRange('2026-10-25', undefined, day)).toBe(true);
  expect(matchesDeliveryDateRange('2026-10-27', day)).toBe(true);
  expect(orderCalendarDate(new Date('invalid'))).toBeNull();
});
