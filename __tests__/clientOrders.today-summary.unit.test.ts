import prisma from '../src/prisma/client';
import { cacheGet, cacheSet } from '../src/lib/redis';
import { readThroughClientOrdersCache } from '../src/modules/clientOrders/clientOrders.cache';
import { getLiveClientOrdersTodaySummary } from '../src/modules/clientOrders/clientOrders.onecLive';
import { getClientOrdersTodaySummary } from '../src/modules/clientOrders/clientOrders.service';

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: {
    employeeProfile: { findUnique: jest.fn() },
  },
}));

jest.mock('../src/lib/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));

jest.mock('../src/modules/clientOrders/clientOrders.cache', () => {
  class ClientOrdersOnecCircuitOpenError extends Error {}
  return {
    CLIENT_ORDERS_CACHE_TTL: { todaySummary: 30 },
    ClientOrdersOnecCircuitOpenError,
    clientOrdersCacheKey: (scope: string, payload: unknown) => `${scope}:${JSON.stringify(payload)}`,
    readThroughClientOrdersCache: jest.fn(),
  };
});

jest.mock('../src/modules/clientOrders/clientOrders.onecLive', () => ({
  getLiveClientOrdersTodaySummary: jest.fn(),
}));

const profileMock = jest.mocked(prisma.employeeProfile.findUnique);
const cacheGetMock = jest.mocked(cacheGet);
const cacheSetMock = jest.mocked(cacheSet);
const readThroughMock = jest.mocked(readThroughClientOrdersCache);
const liveSummaryMock = jest.mocked(getLiveClientOrdersTodaySummary);

const summary = {
  date: '2026-08-07',
  ordersCount: 4,
  clientsCount: 3,
  totalAmount: 12_345.67,
  profit: 2_100,
  profitAvailable: true,
  profitBasisAmount: 12_345.67,
  profitabilityPercent: 17.01,
  missingReceiptPriceCount: 0,
  skippedReceiptPriceCount: 0,
  currency: 'RUB',
  calculatedAt: '2026-08-07T12:00:00',
};

describe('client orders daily summary cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    profileMock.mockResolvedValue({ onecUserGuid: 'manager-guid' } as never);
    cacheGetMock.mockResolvedValue(null);
    cacheSetMock.mockResolvedValue(undefined as never);
    readThroughMock.mockImplementation(((_scope, _payload, _ttl, loader) => loader()) as typeof readThroughClientOrdersCache);
    liveSummaryMock.mockResolvedValue(summary);
  });

  it('loads a manager-scoped value and persists a 15 minute fallback', async () => {
    await expect(getClientOrdersTodaySummary(17)).resolves.toMatchObject({ ...summary, stale: false });

    expect(profileMock).toHaveBeenCalledWith({
      where: { userId: 17 },
      select: { onecUserGuid: true },
    });
    expect(readThroughMock).toHaveBeenCalledWith(
      'today-summary',
      expect.objectContaining({ managerGuid: 'manager-guid', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
      30,
      expect.any(Function),
      expect.objectContaining({ shouldOpenCircuit: expect.any(Function) })
    );
    expect(cacheSetMock).toHaveBeenCalledWith(
      expect.stringContaining('today-summary:stale'),
      expect.objectContaining({ value: summary, fetchedAt: expect.any(String) }),
      15 * 60
    );
  });

  it('returns the last in-process value as stale when 1C becomes unavailable', async () => {
    await getClientOrdersTodaySummary(17);
    readThroughMock.mockRejectedValueOnce(new Error('1C unavailable'));

    await expect(getClientOrdersTodaySummary(17)).resolves.toMatchObject({ ...summary, stale: true });
  });

  it('uses a valid Redis fallback after a process restart', async () => {
    profileMock.mockResolvedValue({ onecUserGuid: 'another-manager-guid' } as never);
    readThroughMock.mockRejectedValueOnce(new Error('1C unavailable'));
    cacheGetMock.mockResolvedValueOnce({ value: summary, fetchedAt: new Date().toISOString() });

    await expect(getClientOrdersTodaySummary(18)).resolves.toMatchObject({ ...summary, stale: true });
  });
});
