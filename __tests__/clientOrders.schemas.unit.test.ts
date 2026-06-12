import {
  clientOrdersListQuerySchema,
  clientOrdersProductsQuerySchema,
} from '../src/modules/clientOrders/clientOrders.schemas';

describe('client orders query schemas', () => {
  it('parses inStockOnly=false as false', () => {
    const result = clientOrdersProductsQuerySchema.parse({ inStockOnly: 'false' });
    expect(result.inStockOnly).toBe(false);
  });

  it('parses inStockOnly=true as true', () => {
    const result = clientOrdersProductsQuerySchema.parse({ inStockOnly: 'true' });
    expect(result.inStockOnly).toBe(true);
  });

  it('keeps pagination defaults stable', () => {
    expect(clientOrdersListQuerySchema.parse({})).toMatchObject({
      limit: 20,
      offset: 0,
      onlyProblems: false,
    });
  });
});
