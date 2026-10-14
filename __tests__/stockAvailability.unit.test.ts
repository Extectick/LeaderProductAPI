import { availableStockForManager } from '../src/modules/clientOrders/stockAvailability';

test.each([
  [3, -22, 25, 25, 3], // reported production failure
  [9, 3, 6, 9, 9], // normal personal reserve remains usable
  [9, -2, 6, 6, 4], // other managers/customer commitments remain deducted
  [0, -25, 25, 25, 0],
  [3, -30, 25, 25, 0],
  [10, 3, 0, 3, 3],
  [10, 3, 6, 2, 2], // do not raise a stricter authoritative result
  [3, 0, 25, 25, 3], // legacy incomplete raw data: physical ceiling
])('quantity=%s rawFree=%s own=%s published=%s -> %s', (quantity, freeAvailableRaw, myReserved, available, expected) => {
  expect(availableStockForManager({ quantity, freeAvailableRaw, myReserved, available })).toBe(expected);
});
test('unknown stock stays unknown rather than inventing availability', () => {
  expect(availableStockForManager({ quantity: null, freeAvailableRaw: null })).toBeNull();
});
