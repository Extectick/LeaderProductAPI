import {
  getOnecLpAppAgreements,
  getOnecLpAppClientOrder,
  getOnecLpAppClientOrderDefaults,
  getOnecLpAppClientOrders,
  getOnecLpAppContracts,
  getOnecLpAppCounterparties,
  getOnecLpAppDeliveryAddresses,
  getOnecLpAppNomenclature,
  getOnecLpAppNomenclatureItem,
  getOnecLpAppOrganizations,
  getOnecLpAppPriceTypes,
  getOnecLpAppProductPrices,
  getOnecLpAppSpecialPrices,
  getOnecLpAppStock,
  getOnecLpAppWarehouses,
  putOnecLpAppClientOrder,
} from '../src/modules/onec/onec.lpApp.client';

const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('onec.lpApp.client client-orders live routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    process.env.ONEC_LP_APP_BASE_URL = 'http://onec.local/WMS10/hs/lp-app/';
    process.env.ONEC_LP_APP_API_KEY = 'lp-app-key';
    process.env.ONEC_LP_APP_TIMEOUT_MS = '10000';
    delete process.env.ONEC_LP_APP_BASIC_USER;
    delete process.env.ONEC_LP_APP_BASIC_PASSWORD;
    (globalThis as any).fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ items: [], limit: 10, offset: 5, hasMore: false }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['/organizations', getOnecLpAppOrganizations],
    ['/warehouses', getOnecLpAppWarehouses],
    ['/counterparties', getOnecLpAppCounterparties],
    ['/contracts', getOnecLpAppContracts],
    ['/agreements', getOnecLpAppAgreements],
    ['/delivery-addresses', getOnecLpAppDeliveryAddresses],
    ['/price-types', getOnecLpAppPriceTypes],
    ['/nomenclature', getOnecLpAppNomenclature],
    ['/product-prices', getOnecLpAppProductPrices],
    ['/special-prices', getOnecLpAppSpecialPrices],
    ['/stock', getOnecLpAppStock],
    ['/client-orders', getOnecLpAppClientOrders],
    ['/client-order-defaults', getOnecLpAppClientOrderDefaults],
  ])('calls %s with pagination and context query', async (path, loader) => {
    await loader({
      limit: 10,
      offset: 5,
      search: 'молоко',
      organizationGuid: 'org-guid',
      counterpartyGuid: 'counterparty-guid',
      agreementGuid: 'agreement-guid',
      contractGuid: 'contract-guid',
      warehouseGuid: 'warehouse-guid',
      priceTypeGuid: 'price-type-guid',
      inStockOnly: true,
      includeInactive: false,
      status: 'SHIPPING_IN_PROGRESS',
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/WMS10/hs/lp-app${path}`);
    expect(url.searchParams.get('apiKey')).toBe('lp-app-key');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('5');
    expect(url.searchParams.get('search')).toBe('молоко');
    expect(url.searchParams.get('organizationGuid')).toBe('org-guid');
    expect(url.searchParams.get('counterpartyGuid')).toBe('counterparty-guid');
    expect(url.searchParams.get('agreementGuid')).toBe('agreement-guid');
    expect(url.searchParams.get('contractGuid')).toBe('contract-guid');
    expect(url.searchParams.get('warehouseGuid')).toBe('warehouse-guid');
    expect(url.searchParams.get('priceTypeGuid')).toBe('price-type-guid');
    expect(url.searchParams.get('inStockOnly')).toBe('true');
    expect(url.searchParams.get('includeInactive')).toBe('false');
    expect(url.searchParams.get('status')).toBe('SHIPPING_IN_PROGRESS');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('lp-app-key');
  });

  it('encodes item guid for nomenclature details', async () => {
    await getOnecLpAppNomenclatureItem('guid with / slash', { warehouseGuid: 'warehouse-guid' });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/WMS10/hs/lp-app/nomenclature/guid%20with%20%2F%20slash');
    expect(url.searchParams.get('warehouseGuid')).toBe('warehouse-guid');
    expect(init.method).toBe('GET');
  });

  it('uses PUT for client order update', async () => {
    await putOnecLpAppClientOrder('order-guid', { status: 'draft' });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/WMS10/hs/lp-app/client-orders/order-guid');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'draft' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('calls client order details route', async () => {
    await getOnecLpAppClientOrder('order-guid', { includeItems: true });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/WMS10/hs/lp-app/client-orders/order-guid');
    expect(url.searchParams.get('includeItems')).toBe('true');
    expect(init.method).toBe('GET');
  });

  it('maps upstream errors without hiding 1C status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '1C validation failed' }, 409));

    await expect(getOnecLpAppCounterparties({ limit: 1, offset: 0 })).rejects.toMatchObject({
      name: 'OnecLpAppHttpError',
      upstreamStatus: 409,
      message: '1C validation failed',
    });
  });

  it('aborts stalled 1C requests after 10 seconds', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));

    const request = getOnecLpAppClientOrders({ limit: 1, offset: 0 });
    const expectation = expect(request).rejects.toMatchObject({
      name: 'OnecLpAppNetworkError',
      message: '1C request timed out',
    });
    await jest.advanceTimersByTimeAsync(10_000);

    await expectation;
  });
});
