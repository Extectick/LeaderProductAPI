import { reviewOfflineOrderPrices } from '../src/modules/clientOrders/offlineOrderPrices';

const input = (price: number | null, line: any = {}) => ({ line: { productGuid: 'product', lineGuid: 'line',
  quantity: 2, basePrice: 100, ...line }, productName: 'Товар', currentPrice: price, quantityBase: 2 });

it.each([null, 0, -1, NaN, Infinity])('does not replace a valid draft price with unavailable %s', price => {
  for (const policy of ['ASK', 'USE_CURRENT'] as const) {
    const source = input(price);
    const result = reviewOfflineOrderPrices([source], policy);
    expect(result.requiresReview).toBe(true);
    expect(result.items[0].basePrice).toBe(100);
    expect(result.details).toMatchObject({ canUseCurrent: false, canKeepDraft: true, oldTotal: 200,
      currentTotal: null, totalDifference: null, items: [{ currentPrice: null, priceAvailable: false }] });
    expect(source.line.basePrice).toBe(100);
  }
});

it('allows an explicit fixed draft price and preserves the effective general discount', () => {
  const result = reviewOfflineOrderPrices([input(null)], 'KEEP_DRAFT', 10);
  expect(result.requiresReview).toBe(false);
  expect(result.items[0]).toMatchObject({ basePrice: 100, manualPrice: 100, discountPercent: 10 });
  expect(result.details.oldTotal).toBe(180);
});

it('does not replace an explicit line discount with the general discount', () => {
  expect(reviewOfflineOrderPrices([input(0, { discountPercent: 5 })], 'KEEP_DRAFT', 10).items[0].discountPercent).toBe(5);
});

it('never approves keeping a missing/zero draft price', () => {
  const result = reviewOfflineOrderPrices([input(null, { basePrice: 0 })], 'KEEP_DRAFT');
  expect(result.requiresReview).toBe(true);
  expect(result.details.canKeepDraft).toBe(false);
});

it('keeps manual and cancelled lines independent of automatic price availability', () => {
  const result = reviewOfflineOrderPrices([input(null, { manualPrice: 120 }), input(null, { isCancelled: true })], 'USE_CURRENT');
  expect(result.requiresReview).toBe(false);
  expect(result.details.currentTotal).toBe(240);
  expect(result.items[0].manualPrice).toBe(120);
});

it('updates only explicitly approved valid current prices', () => {
  expect(reviewOfflineOrderPrices([input(130)], 'ASK').requiresReview).toBe(true);
  const result = reviewOfflineOrderPrices([input(130)], 'USE_CURRENT');
  expect(result.items[0].basePrice).toBe(130);
  expect(result.details.totalDifference).toBe(60);
  expect(result.requiresReview).toBe(false);
});
