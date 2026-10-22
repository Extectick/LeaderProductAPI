import { collectWeightReferences, orderLineWeightKg, orderWeightKey, summarizeShareWeights } from '../src/modules/orderShare/orderShare.weights';
import { projectShareOrder } from '../src/modules/orderShare/orderShare.model';
const kg = { guid: 'kg', name: 'Килограмм', symbol: 'кг' };
const piece = { guid: 'piece', name: 'Штука', symbol: 'шт' };
const row = (extra: any = {}) => ({ product: { guid: 'sauce', name: 'Соус', baseUnit: piece }, unit: piece, quantity: '3', price: 353, ...extra });

test('counts the whole line, respects package weight, and normalizes grams/tonnes', () => {
  expect(orderLineWeightKg(row({ product: { guid: 'p', weight: '815', weightUnit: { symbol: 'г' } } }))).toBe('2.445');
  expect(orderLineWeightKg(row({ package: { guid: 'box', name: 'кор', multiplier: 12, weight: 10, weightUnit: kg } }))).toBe('30');
  expect(orderLineWeightKg(row({ quantity: '0.5', product: { weight: '0.002', weightUnit: { name: 'Тонна' } } }))).toBe('1');
  expect(orderLineWeightKg(row({ quantity: '0.25', product: { weight: '2', weightUnit: kg }, package: { name: 'кор', multiplier: '10' } }))).toBe('5');
});
test('mass-based quantities work without extra reference weights, never litres or titles', () => {
  expect(orderLineWeightKg(row({ product: { baseUnit: kg }, quantity: '2.125' }))).toBe('2.125');
  expect(orderLineWeightKg(row({ unit: { symbol: 'г' }, product: {}, quantity: 500 }))).toBe('0.5');
  expect(orderLineWeightKg(row({ product: { name: 'Масло 5 кг', baseUnit: { symbol: 'л' } } }))).toBeNull();
  expect(orderLineWeightKg(row({ package: { name: 'кор 5 кг', multiplier: 5 } }))).toBeNull();
  expect(orderLineWeightKg(row({ product: { weight: 2, weightUnit: { symbol: 'л' } } }))).toBeNull();
});
test.each([null, '', 0, -1, 'NaN', 'Infinity', true])('invalid/missing reference weight %s is unknown', value => {
  expect(orderLineWeightKg(row({ product: { weight: value } }))).toBeNull();
});
test('empty/cancelled/invalid quantities never contribute to total weight', () => {
  for (const extra of [{ quantity: 0 }, { quantity: -1 }, { quantity: NaN }, { isCancelled: true }]) {
    expect(orderLineWeightKg(row({ product: { weight: 1 }, ...extra }))).toBeNull();
  }
  const order = projectShareOrder({ counterparty: {}, items: [row({ product: { guid: 'p', name: 'Весовой', weight: 1 } }), row({ isCancelled: true })] });
  expect(order.items).toHaveLength(1);
  expect(order.totalWeightKg).toBe('3');
  expect(order.weightComplete).toBe(true);
});
test('decimal arithmetic does not accumulate floating point drift or hide missing positions', () => {
  expect(summarizeShareWeights([{ weightKg: '0.1' }, { weightKg: '0.2' }])).toEqual({ totalWeightKg: '0.3', weightComplete: true, missingWeightItems: 0 });
  expect(summarizeShareWeights([{ weightKg: '2.445' }, {}])).toEqual({ totalWeightKg: '2.445', weightComplete: false, missingWeightItems: 1 });
  expect(summarizeShareWeights([{}])).toEqual({ totalWeightKg: null, weightComplete: false, missingWeightItems: 1 });
});

test('an explicit order mass unit takes precedence over a catalog per-piece weight', () => {
  expect(orderLineWeightKg(row({ unit: kg, product: { weight: '0.815', baseUnit: piece }, quantity: '2.445' }))).toBe('2.445');
  expect(orderLineWeightKg(row({ unit: { symbol: 'г' }, product: { weight: '0.815' }, quantity: '500' }))).toBe('0.5');
});

test('tiny positive masses are not rounded to a false zero or lost from the total', () => {
  const weightKg = orderLineWeightKg(row({ quantity: '0.01', product: { weight: '0.000001' } }));
  expect(Number(weightKg)).toBe(0.00000001);
  expect(summarizeShareWeights([{ weightKg }])).toMatchObject({ weightComplete: true, missingWeightItems: 0 });
});
test('cached kg per unit matches identity, not quantity; other packages/units cannot reuse it', () => {
  const original = row(); const references = { [orderWeightKey(original)]: '0.815' };
  expect(orderLineWeightKg(original, references)).toBe('2.445');
  expect(orderLineWeightKg({ ...original, quantity: 5 }, references)).toBe('4.075');
  expect(orderLineWeightKg({ ...original, package: { guid: 'box', multiplier: 5 } }, references)).toBeNull();
  expect(orderLineWeightKg({ ...original, product: { guid: 'other' } }, references)).toBeNull();
});
test('reference-only enrichment is exact and excludes prices and unrelated products', () => {
  const item = row({ package: { guid: 'box', name: 'кор', multiplier: 12 } });
  const products = [{ guid: 'sauce', baseUnit: piece, weight: 0.815, receiptPrice: 123,
    packages: [{ guid: 'box', multiplier: 12, weight: 9.78, weightUnit: kg }] }, { guid: 'private-other', weight: 999 }];
  const refs = collectWeightReferences([item], products);
  expect(refs).toEqual({ [orderWeightKey(item)]: '9.78' });
  expect(orderLineWeightKg(item, refs)).toBe('29.34');
  expect(JSON.stringify(refs)).not.toMatch(/receiptPrice|private-other|123/);
  expect(collectWeightReferences([row()], [{ ...products[0], baseUnit: kg }])).toEqual({});
});

test('a redefined package unit cannot apply its new package mass to an old order line', () => {
  const item = row({ package: { guid: 'box', unit: piece, name: 'кор', multiplier: 12 } });
  const products = [{ guid: 'sauce', baseUnit: piece, weight: 0.815,
    packages: [{ guid: 'box', unit: kg, multiplier: 12, weight: 100, weightUnit: kg }] }];
  expect(collectWeightReferences([item], products)).toEqual({ [orderWeightKey(item)]: '9.78' });
});
