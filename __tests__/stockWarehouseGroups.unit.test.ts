import { enrichStockWarehouseGroups } from '../src/modules/clientOrders/stockWarehouseGroups';
import { getLiveWarehouses, findLiveWarehouse } from '../src/modules/clientOrders/clientOrders.onecLive';
import { cacheGet, cacheSet } from '../src/utils/cache';
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({ getLiveWarehouses: jest.fn(), findLiveWarehouse: jest.fn() }));
jest.mock('../src/utils/cache', () => ({ cacheGet: jest.fn(), cacheSet: jest.fn() }));
beforeEach(() => { jest.resetAllMocks(); jest.mocked(cacheGet).mockResolvedValue(null); });
it('uses real 1C groups while preserving the database warehouse scope and names', async () => {
  jest.mocked(getLiveWarehouses).mockResolvedValue({ items: [
    { guid: 'a', name: 'Online name', cityGuid: 'omsk', cityName: 'Омск', sortOrder: 2 },
    { guid: 'not-in-stock-scope', cityName: 'Новосибирск' },
  ], total: 2 } as any);
  expect(await enrichStockWarehouseGroups([{ guid: 'a', name: 'Переработка' }, { guid: 'b', name: 'Unknown' }])).toEqual([
    { guid: 'a', name: 'Переработка', cityGuid: 'omsk', cityName: 'Омск', sortOrder: 2 }, { guid: 'b', name: 'Unknown' },
  ]);
  expect(cacheSet).toHaveBeenCalledTimes(2);
});
it('uses cached metadata without contacting 1C', async () => {
  jest.mocked(cacheGet).mockResolvedValue([{ guid: 'a', cityName: 'Новосибирск' }]);
  expect((await enrichStockWarehouseGroups([{ guid: 'a', name: 'Брак' }]))[0]).toMatchObject({ cityName: 'Новосибирск' });
  expect(getLiveWarehouses).not.toHaveBeenCalled();
});
it('returns last-good groups immediately and refreshes them in the background', async () => {
  jest.mocked(cacheGet).mockImplementation(async key => key.endsWith(':last-good') ? [{ guid: 'a', cityName: 'Омск' }] as any : null);
  jest.mocked(getLiveWarehouses).mockRejectedValue(new Error('1C unavailable'));
  expect((await enrichStockWarehouseGroups([{ guid: 'a', name: 'Брак' }]))[0]).toMatchObject({ cityName: 'Омск' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cacheSet).not.toHaveBeenCalled();
});
it('keeps filters usable on a cold-cache 1C failure and does not invent groups from names', async () => {
  jest.mocked(getLiveWarehouses).mockRejectedValue(new Error('1C unavailable'));
  expect(await enrichStockWarehouseGroups([{ guid: 'a', name: 'Омск' }])).toEqual([{ guid: 'a', name: 'Омск' }]);
});
it('paginates group metadata instead of truncating after the first hundred warehouses', async () => {
  jest.mocked(getLiveWarehouses).mockResolvedValueOnce({ total: 101, items: Array.from({ length: 100 }, (_, i) => ({ guid: String(i) })) } as any)
    .mockResolvedValueOnce({ total: 101, items: [{ guid: 'last', cityName: 'Омск' }] } as any);
  expect((await enrichStockWarehouseGroups([{ guid: 'last', name: 'Last' }]))[0]).toMatchObject({ cityName: 'Омск' });
  expect(getLiveWarehouses).toHaveBeenLastCalledWith({ limit: 100, offset: 100, includeInactive: false });
});
it('gets missing historical warehouse metadata by GUID without modifying order availability', async () => {
  jest.mocked(getLiveWarehouses).mockResolvedValue({ total: 0, items: [] } as any);
  jest.mocked(findLiveWarehouse).mockResolvedValue({ guid: 'processing', cityGuid: 'omsk', cityName: 'Омск', isSelectable: false } as any);
  expect(await enrichStockWarehouseGroups([{ guid: 'processing', name: 'Переработка' }])).toEqual([
    { guid: 'processing', name: 'Переработка', cityGuid: 'omsk', cityName: 'Омск', sortOrder: null },
  ]);
  expect(findLiveWarehouse).toHaveBeenCalledWith('processing');
});
