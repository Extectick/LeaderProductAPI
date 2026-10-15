import { InvalidStockCursor, listStockMovements, stockMovementsQuery } from '../src/modules/clientOrders/stockMovements';
import { getOnecLpAppStock } from '../src/modules/onec/onec.lpApp.client';
jest.mock('../src/modules/onec/onec.lpApp.client', () => ({ getOnecLpAppStock: jest.fn() }));
const product = '65cdab4f-9940-11e8-8010-001e676f7f9b';
const warehouse = '913e8a88-88d9-11e8-8263-001e676f7f9b';
const doc = '37e85c59-a66c-11f1-9d38-f869712becc1';
const nil = '00000000-0000-0000-0000-000000000000';
function payload(more = false) {
  return { version: 'stock-movements-v1', snapshotAt: '2026-10-14T15:00:00', hasMore: more,
    nextKey: more ? { period: '2026-09-02T07:18:39', type: 'ПриходныйОрдерНаТовары', guid: doc, warehouse, characteristic: nil } : null,
    items: [{ id: 'movement-1', direction: 'receipt', operationKind: 'Приобретение товаров и услуг',
      document: { type: 'ПриходныйОрдерНаТовары', typeName: 'Приходный ордер на товары', guid: doc, number: 'УТ-00000253', date: '2026-09-02' },
      movementAt: '2026-09-02T07:18:39', warehouse: { guid: warehouse, name: 'Омск' }, characteristic: '', quantity: 60,
      baseDocuments: [], counterparty: 'Поставщик', writeOffArticles: [], price: 100, amount: 6000, currency: 'руб.',
      costBasis: 'VAT_INCLUDED', costStatus: 'PRELIMINARY', costReason: 'С учётом распределённых расходов' }] };
}
beforeEach(() => { jest.clearAllMocks(); jest.mocked(getOnecLpAppStock).mockResolvedValue(payload() as any); });
it('bounds requests and does not accept arbitrary cursor objects or document types', () => {
  for (const value of [{}, { direction: 'bad' }, { direction: 'receipt', limit: 51 }, { direction: 'receipt', limit: -1 },
    { direction: 'receipt', warehouseGuids: `${warehouse},bad` }, { direction: 'receipt', cursor: {} }]) {
    expect(stockMovementsQuery.safeParse(value).success).toBe(false);
  }
  expect(stockMovementsQuery.parse({ direction: 'receipt', warehouseGuids: `${warehouse},${warehouse}` }).warehouseGuids).toEqual([warehouse]);
});
it('passes only the validated live movement contract, never persists or silently uses old stock data', async () => {
  const result = await listStockMovements(product, stockMovementsQuery.parse({ direction: 'receipt' }), 42);
  expect(result.items[0]).toMatchObject({ price: 100, amount: 6000, costBasis: 'VAT_INCLUDED', document: { date: '2026-09-02' } });
  expect(result.nextCursor).toBeNull();
  expect(getOnecLpAppStock).toHaveBeenCalledWith({ view: 'movements', productGuid: product, direction: 'receipt', warehouseGuids: undefined, limit: 30 });
  jest.mocked(getOnecLpAppStock).mockResolvedValue({ items: [] } as any);
  await expect(listStockMovements(product, stockMovementsQuery.parse({ direction: 'receipt' }), 42)).rejects.toThrow();
});
it('signs a stable cursor tied to account, product, warehouses and direction', async () => {
  jest.mocked(getOnecLpAppStock).mockResolvedValueOnce(payload(true) as any);
  const query = stockMovementsQuery.parse({ direction: 'receipt', warehouseGuids: warehouse });
  const page = await listStockMovements(product, query, 42);
  await listStockMovements(product, { ...query, cursor: page.nextCursor! }, 42);
  expect(getOnecLpAppStock).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotAt: '2026-10-14T15:00:00', beforeGuid: doc, beforeCharacteristic: nil }));
  const calls = jest.mocked(getOnecLpAppStock).mock.calls.length;
  for (const [guid, changes, user] of [[product, {}, 43], [doc, {}, 42], [product, { direction: 'expense' }, 42],
    [product, { warehouseGuids: [] }, 42], [product, { cursor: `${page.nextCursor}x` }, 42]] as const) {
    await expect(listStockMovements(guid, { ...query, cursor: page.nextCursor!, ...changes } as any, user)).rejects.toBeInstanceOf(InvalidStockCursor);
  }
  expect(getOnecLpAppStock).toHaveBeenCalledTimes(calls);
});
it('expires cursors without renewing expiration on each page', async () => {
  jest.mocked(getOnecLpAppStock).mockResolvedValueOnce(payload(true) as any);
  const page = await listStockMovements(product, stockMovementsQuery.parse({ direction: 'receipt' }), 42);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600001);
  await expect(listStockMovements(product, stockMovementsQuery.parse({ direction: 'receipt', cursor: page.nextCursor }), 42)).rejects.toBeInstanceOf(InvalidStockCursor);
  clock.mockRestore();
});
it('rejects mismatched direction, scope, duplicates, cursor and invented unavailable prices', async () => {
  const samples = [payload(), payload(), payload(), payload(true), payload()];
  samples[0].items[0].direction = 'expense';
  samples[1].items[0].warehouse.guid = doc;
  samples[2].items.push(samples[2].items[0]);
  samples[3].nextKey!.guid = warehouse;
  samples[4].items[0].costStatus = 'UNAVAILABLE';
  for (const sample of samples) {
    jest.mocked(getOnecLpAppStock).mockResolvedValue(sample as any);
    await expect(listStockMovements(product, stockMovementsQuery.parse({ direction: 'receipt', warehouseGuids: warehouse }), 42)).rejects.toThrow();
  }
});
