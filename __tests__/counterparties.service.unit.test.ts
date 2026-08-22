const cacheGet = jest.fn();
const cacheSet = jest.fn();
const getOnecLpAppCounterpartyCard = jest.fn();
const getOnecLpAppCounterpartyFinancialDocuments = jest.fn();

jest.mock('../src/lib/redis', () => ({ cacheGet, cacheSet }));
jest.mock('../src/modules/onec/onec.lpApp.client', () => {
  class OnecLpAppHttpError extends Error {
    constructor(public upstreamStatus: number, public payload: unknown, message: string) {
      super(message);
    }
  }
  return { getOnecLpAppCounterpartyCard, getOnecLpAppCounterpartyFinancialDocuments, OnecLpAppHttpError };
});

import {
  counterpartyCardPeriods,
  counterpartyCardPermissions,
  getCounterpartyCard,
  getCounterpartyFinancialDocuments,
} from '../src/modules/counterparties/counterparties.service';

describe('counterparty card service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);
  });

  it('coalesces concurrent reads and supplies periods to 1C without manager scoping', async () => {
    let resolveRequest!: (value: unknown) => void;
    getOnecLpAppCounterpartyCard.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const options = {
      counterpartyGuid: '44444444-4444-4444-8444-444444444444',
      organizationGuid: '55555555-5555-4555-8555-555555555555',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      preset: 'custom' as const,
      periodFrom: '2026-06-10',
      periodTo: '2026-06-20',
    };

    const first = getCounterpartyCard(options);
    const second = getCounterpartyCard(options);
    await Promise.resolve();
    resolveRequest({ item: {
      identity: { guid: options.counterpartyGuid, name: 'Клиент' },
      overview: {},
      calculatedAt: '2026-08-12T10:00:00',
    } });
    const [left, right] = await Promise.all([first, second]);

    expect(left.identity.name).toBe('Клиент');
    expect(right.identity.name).toBe('Клиент');
    expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(1);
    expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledWith(expect.objectContaining({
      organizationGuid: options.organizationGuid,
      periodFrom: '2026-06-10',
      periodTo: '2026-06-20',
      period: 'custom',
      financialDocumentsLimit: 20,
    }));
    expect(getOnecLpAppCounterpartyCard.mock.calls[0][0]).not.toHaveProperty('managerGuid');
  });

  it('limits distinct heavy 1C card reads while preserving the queue', async () => {
    process.env.ONEC_COUNTERPARTY_CARD_MAX_CONCURRENCY = '2';
    const pending: Array<{ query: any; resolve: (value: unknown) => void }> = [];
    getOnecLpAppCounterpartyCard.mockImplementation((query) => new Promise((resolve) => {
      pending.push({ query, resolve });
    }));
    const base = {
      organizationGuid: '55555555-5555-4555-8555-555555555555',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      preset: 'month' as const,
      forceRefresh: true,
    };

    try {
      const requests = [1, 2, 3].map((index) => getCounterpartyCard({
        ...base,
        counterpartyGuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }));
      await Promise.resolve();
      await Promise.resolve();
      expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(2);

      const first = pending[0];
      first.resolve({ item: { identity: { guid: first.query.counterpartyGuid, name: 'Первый' }, overview: {} } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(3);

      for (const item of pending.slice(1)) {
        item.resolve({ item: { identity: { guid: item.query.counterpartyGuid, name: 'Клиент' }, overview: {} } });
      }
      await Promise.all(requests);
    } finally {
      delete process.env.ONEC_COUNTERPARTY_CARD_MAX_CONCURRENCY;
    }
  });

  it('returns a stale card immediately and refreshes it in the background', async () => {
    const guid = '12121212-1212-4212-8212-121212121212';
    cacheGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        value: {
          identity: { guid, name: 'Cached client' },
          context: {},
          organizationOptions: [],
          overview: {},
          financeSummary: null,
          salesSummary: null,
          commercialTerms: null,
          recentOrders: [],
          incomingPayments: [],
          upcomingPayments: [],
          paymentDiscipline: null,
          contacts: [],
          availability: {},
          permissions: {},
          calculatedAt: '2026-08-14T10:00:00',
          sourceVersion: 'v-test',
        },
      });
    getOnecLpAppCounterpartyCard.mockResolvedValueOnce({ item: {
      identity: { guid, name: 'Fresh client' },
      overview: {},
    } });

    const result = await getCounterpartyCard({
      counterpartyGuid: guid,
      organizationGuid: '34343434-3434-4434-8434-343434343434',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      preset: 'month',
    });

    expect(result.identity.name).toBe('Cached client');
    expect(result.stale).toBe(true);
    expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(1);
  });

  it('calculates stable calendar and custom comparison periods', () => {
    const now = new Date('2026-08-12T08:00:00.000Z');
    expect(counterpartyCardPeriods(now, 'week')).toMatchObject({
      preset: 'week', periodFrom: '2026-08-10', periodTo: '2026-08-16',
      compareFrom: '2026-08-03', compareTo: '2026-08-09',
    });
    expect(counterpartyCardPeriods(now, 'month')).toMatchObject({
      preset: 'month', periodFrom: '2026-08-01', periodTo: '2026-08-31',
      compareFrom: '2026-07-01', compareTo: '2026-07-31',
    });
    expect(counterpartyCardPeriods(now, 'quarter')).toMatchObject({
      preset: 'quarter', periodFrom: '2026-07-01', periodTo: '2026-09-30',
      compareFrom: '2026-04-01', compareTo: '2026-06-30',
    });
    expect(counterpartyCardPeriods(now, 'halfYear')).toMatchObject({
      preset: 'halfYear', periodFrom: '2026-07-01', periodTo: '2026-12-31',
      compareFrom: '2026-01-01', compareTo: '2026-06-30',
    });
    expect(counterpartyCardPeriods(now, 'custom', {
      periodFrom: '2026-07-01', periodTo: '2026-07-10',
    })).toMatchObject({
      preset: 'custom', periodFrom: '2026-07-01', periodTo: '2026-07-10',
      compareFrom: '2026-06-21', compareTo: '2026-06-30',
    });
  });

  it('keeps exact periods isolated in cache and upstream requests', async () => {
    getOnecLpAppCounterpartyCard.mockImplementation(async (query) => ({ item: {
      identity: { guid: query.counterpartyGuid, name: 'РљР»РёРµРЅС‚' },
      overview: {},
    } }));
    const base = {
      counterpartyGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      preset: 'custom' as const,
    };

    await getCounterpartyCard({ ...base, periodFrom: '2026-06-01', periodTo: '2026-06-30' });
    await getCounterpartyCard({ ...base, periodFrom: '2026-07-01', periodTo: '2026-07-31' });

    expect(getOnecLpAppCounterpartyCard).toHaveBeenCalledTimes(2);
    expect(getOnecLpAppCounterpartyCard).toHaveBeenNthCalledWith(1, expect.objectContaining({
      periodFrom: '2026-06-01', periodTo: '2026-06-30',
    }));
    expect(getOnecLpAppCounterpartyCard).toHaveBeenNthCalledWith(2, expect.objectContaining({
      periodFrom: '2026-07-01', periodTo: '2026-07-31',
    }));
  });

  it('does not scope card access by managerGuid from any client shape', async () => {
    getOnecLpAppCounterpartyCard.mockResolvedValueOnce({ item: {
      identity: { guid: '66666666-6666-4666-8666-666666666666', name: 'Клиент' },
      overview: {},
    } });

    await getCounterpartyCard({
      counterpartyGuid: '66666666-6666-4666-8666-666666666666',
      organizationGuid: '77777777-7777-4777-8777-777777777777',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      forceRefresh: true,
      ...({ managerGuid: '99999999-9999-4999-8999-999999999999' } as object),
    });

    expect(getOnecLpAppCounterpartyCard.mock.calls[0][0]).not.toHaveProperty('managerGuid');
  });

  it('returns identity and sales but hides organization-scoped finance without organizationGuid', async () => {
    getOnecLpAppCounterpartyCard.mockResolvedValueOnce({ item: {
      identity: { guid: '88888888-8888-4888-8888-888888888888', name: 'Клиент' },
      overview: { status: 'HAS_DEBT', debtTotal: 500, overdueDebt: 200, salesAmount: 1000 },
      financeSummary: { debtTotal: 500, overdueDebt: 200 },
      financialDocuments: [{ documentGuid: '99999999-9999-4999-8999-999999999999', status: 'OVERDUE' }],
      salesSummary: { salesAmount: 1000 },
      commercialTerms: { contractName: 'Договор' },
      sections: {
        finance: { available: true },
        sales: { available: true },
        commercialTerms: { available: true },
      },
    } });

    const card = await getCounterpartyCard({
      counterpartyGuid: '88888888-8888-4888-8888-888888888888',
      userId: 1,
      roleName: 'employee',
      permissionNames: ['view_client_orders'],
      forceRefresh: true,
    });

    expect(card.identity.name).toBe('Клиент');
    expect(card.salesSummary?.salesAmount).toBe(1000);
    expect(card.overview.salesAmount).toBe(1000);
    expect(card.overview.status).toBeNull();
    expect(card.overview.debtTotal).toBeNull();
    expect(card.financeSummary).toBeNull();
    expect(card.financialDocuments).toEqual([]);
    expect(card.financialDocumentsSummary.totalCount).toBe(0);
    expect(card.commercialTerms).toBeNull();
    expect(card.availability.finance).toBe('unavailable');
    expect(card.availability.commercialTerms).toBe('unavailable');
  });

  it('uses legacy access only until granular permissions are assigned', () => {
    expect(counterpartyCardPermissions(['view_client_orders', 'manage_client_orders'])).toEqual({
      viewFinance: true,
      viewSales: true,
      viewContacts: true,
      createOrder: true,
    });
    expect(counterpartyCardPermissions(['view_client_orders', 'view_counterparty_sales'])).toEqual({
      viewFinance: false,
      viewSales: true,
      viewContacts: false,
      createOrder: false,
    });
  });

  it('maps financial documents and keeps the upstream offset inside an opaque cursor', async () => {
    getOnecLpAppCounterpartyFinancialDocuments.mockResolvedValueOnce({
      items: [{ documentGuid: '22222222-2222-4222-8222-222222222222', status: 'EXPECTED', amount: 500 }],
      summary: { totalCount: 21, overdueCount: 1, pendingCount: 20, awaitingShipmentCount: 1 },
      hasMore: true,
      nextOffset: 20,
      calculatedAt: '2026-08-16T10:00:00',
      sourceVersion: 'financial-v1',
    });
    const first = await getCounterpartyFinancialDocuments({
      counterpartyGuid: '11111111-1111-4111-8111-111111111111',
      organizationGuid: '33333333-3333-4333-8333-333333333333',
      roleName: 'employee', permissionNames: ['view_client_orders'], preset: 'month', limit: 20,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(getOnecLpAppCounterpartyFinancialDocuments).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 20 }));

    getOnecLpAppCounterpartyFinancialDocuments.mockResolvedValueOnce({
      items: [], summary: { totalCount: 21 }, hasMore: false, nextOffset: null,
    });
    await getCounterpartyFinancialDocuments({
      counterpartyGuid: '11111111-1111-4111-8111-111111111111',
      organizationGuid: '33333333-3333-4333-8333-333333333333',
      roleName: 'employee', permissionNames: ['view_client_orders'], preset: 'month', cursor: first.nextCursor!, limit: 20,
    });
    expect(getOnecLpAppCounterpartyFinancialDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 }));
  });
});
