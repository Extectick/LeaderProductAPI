jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {} }));
jest.mock('../src/lib/redis', () => ({ cacheGet: jest.fn(), cacheSet: jest.fn() }));
jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({
  ...jest.requireActual('../src/modules/clientOrders/clientOrders.onecLive'),
  findLiveOrganization: jest.fn(async () => ({ isActive: true })),
  findLiveCounterparty: jest.fn(async () => ({ isActive: true })),
  findLivePriceType: jest.fn(async () => ({ isActive: true })),
  getLiveProductsByGuids: jest.fn(),
}));
import { getLiveProductsByGuids } from '../src/modules/clientOrders/clientOrders.onecLive';
import { validateOfflineSubmission } from '../src/modules/clientOrders/clientOrders.service';

const body = (items: any[], policy = 'ASK'): any => ({ intent: 'SUBMIT', organizationGuid: 'org', counterpartyGuid: 'cp',
  priceTypeGuid: 'header-price', offlineReview: { pricePolicy: policy }, items });
const product = (guid: string, basePrice: number | null = 100, available = 20): any => ({ guid, name: 'Товар',
  isActive: true, basePrice, packages: [], stock: { available } });
beforeEach(() => jest.clearAllMocks());

it('uses each line price type without mixing prices of the same product', async () => {
  jest.mocked(getLiveProductsByGuids).mockImplementation(async query => [product('same', query.priceTypeGuid === 'special' ? 200 : 100)]);
  const result = await validateOfflineSubmission(body([
    { productGuid: 'same', quantity: 1, basePrice: 100 },
    { productGuid: 'same', quantity: 1, basePrice: 200, priceTypeGuid: 'special' },
  ]), 'manager');
  expect(result.items.map(line => line.basePrice)).toEqual([100, 200]);
  expect(getLiveProductsByGuids).toHaveBeenCalledTimes(2);
  expect(getLiveProductsByGuids).toHaveBeenCalledWith(expect.objectContaining({ managerGuid: 'manager', priceTypeGuid: 'special' }));
});

it('aggregates stock for duplicate products even with different price types and case', async () => {
  jest.mocked(getLiveProductsByGuids).mockResolvedValue([product('same', 100, 3)]);
  await expect(validateOfflineSubmission(body([
    { productGuid: 'SAME', quantity: 2, basePrice: 100 },
    { productGuid: 'same', quantity: 2, basePrice: 100, priceTypeGuid: 'special' },
  ]), 'manager')).rejects.toMatchObject({ code: 'STOCK_SHORTAGE', details: { items: [{ required: 4, available: 3 }] } });
});

it('a missing current price produces actionable review, never a zero-price order', async () => {
  jest.mocked(getLiveProductsByGuids).mockResolvedValue([product('same', null)]);
  const packet = body([{ productGuid: 'same', quantity: 1, basePrice: 100 }], 'USE_CURRENT');
  await expect(validateOfflineSubmission(packet, 'manager')).rejects.toMatchObject({ code: 'PRICE_REVIEW_REQUIRED',
    details: { canUseCurrent: false, currentTotal: null } });
  expect(packet.items[0].basePrice).toBe(100);
});

it('splits a large draft into bounded 1C requests', async () => {
  jest.mocked(getLiveProductsByGuids).mockImplementation(async query => query.productGuids.map(guid => product(guid)));
  await validateOfflineSubmission(body(Array.from({ length: 401 }, (_, i) => ({ productGuid: `p${i}`, quantity: 1, basePrice: 100 }))), 'manager');
  expect(jest.mocked(getLiveProductsByGuids).mock.calls.map(([q]) => q.productGuids.length)).toEqual([200, 200, 1]);
});
