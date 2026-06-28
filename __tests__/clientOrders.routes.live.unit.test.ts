import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 1, permissions: [], profileStatus: 'ACTIVE' };
    next();
  },
  authorizePermissions: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/middleware/checkUserStatus', () => ({
  checkUserStatus: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/middleware/serviceAccess', () => ({
  authorizeServiceAccess: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../src/modules/clientOrders/clientOrders.service', () => {
  class ClientOrdersError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string
    ) {
      super(message);
    }
  }

  return {
    ClientOrdersError,
    cancelClientOrder: jest.fn(),
    copyClientOrder: jest.fn(),
    createClientOrder: jest.fn(),
    deleteDraftClientOrder: jest.fn(),
    getClientOrderByGuid: jest.fn(),
    getClientOrderDefaults: jest.fn(),
    getClientOrderReferenceDetails: jest.fn(),
    getClientOrderSettings: jest.fn(),
    getClientOrdersAgreements: jest.fn(),
    getClientOrdersContracts: jest.fn(),
    getClientOrdersCounterparties: jest.fn(),
    getClientOrdersDeliveryAddresses: jest.fn(),
    getClientOrdersPriceTypes: jest.fn(),
    getClientOrdersProducts: jest.fn(),
    getClientOrdersProductsByGuids: jest.fn(),
    getClientOrdersReferenceData: jest.fn(),
    getClientOrdersWarehouses: jest.fn(),
    listClientOrders: jest.fn(),
    restoreClientOrder: jest.fn(),
    submitClientOrder: jest.fn(),
    unqueueClientOrder: jest.fn(),
    updateClientOrder: jest.fn(),
    updateClientOrderSettings: jest.fn(),
  };
});

import clientOrdersRouter from '../src/modules/clientOrders/clientOrders.routes';
import * as service from '../src/modules/clientOrders/clientOrders.service';

const app = express();
app.use(express.json());
app.use('/api/client-orders', clientOrdersRouter);

function page(items: unknown[], patch: Partial<{ total: number; limit: number; offset: number }> = {}) {
  return {
    items,
    total: patch.total ?? items.length,
    limit: patch.limit ?? 25,
    offset: patch.offset ?? 0,
  } as any;
}

function expectPagedResponse(body: any, expectedItems: number, expectedMeta: { total: number; limit: number; offset: number }) {
  expect(body.ok).toBe(true);
  expect(body.data.items).toHaveLength(expectedItems);
  expect(body.meta).toMatchObject({
    total: expectedMeta.total,
    count: expectedItems,
    limit: expectedMeta.limit,
    offset: expectedMeta.offset,
  });
}

describe('/api/client-orders live reference routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns mixed orders list metadata and passes authenticated user id to service', async () => {
    jest.mocked(service.listClientOrders).mockResolvedValueOnce({
      items: [
        {
          guid: 'draft-guid',
          status: 'DRAFT',
          syncState: 'DRAFT',
          readOnly: false,
          origin: 'local',
          items: [],
          events: [],
        },
      ],
      total: 3,
      limit: 20,
      offset: 0,
      statusCounts: { DRAFT: 1, SENT_TO_1C: 2 },
      liveSource: { status: 'ok' },
    } as any);

    const response = await request(app)
      .get('/api/client-orders')
      .query({ limit: 20, offset: 0, search: 'abc', status: 'SHIPPING_IN_PROGRESS' });

    expect(response.status).toBe(200);
    expect(service.listClientOrders).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, offset: 0, search: 'abc', status: 'SHIPPING_IN_PROGRESS' }), 1);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.meta).toMatchObject({
      total: 3,
      count: 1,
      limit: 20,
      offset: 0,
      statusCounts: { DRAFT: 1, SENT_TO_1C: 2 },
      liveSource: { status: 'ok' },
    });
  });

  it('returns validated counterparties with pagination metadata', async () => {
    jest.mocked(service.getClientOrdersCounterparties).mockResolvedValueOnce(
      page(
        [
          {
            guid: 'counterparty-guid',
            name: 'Абдулаева Елена Викторовна ИП',
            fullName: 'Абдулаева Елена Викторовна Индивидуальный предприниматель',
            inn: '540000000001',
            kpp: '540001001',
            phone: '+7 913 000-00-01',
            email: 'counterparty@example.test',
            isActive: true,
          },
        ],
        { total: 9, limit: 2, offset: 4 }
      )
    );

    const response = await request(app)
      .get('/api/client-orders/counterparties')
      .query({ limit: 2, offset: 4, search: 'Абдулаева', includeInactive: 'false' });

    expect(response.status).toBe(200);
    expect(service.getClientOrdersCounterparties).toHaveBeenCalledWith({
      limit: 2,
      offset: 4,
      search: 'Абдулаева',
      includeInactive: false,
    });
    expectPagedResponse(response.body, 1, { total: 9, limit: 2, offset: 4 });
    expect(response.body.data.items[0]).toMatchObject({
      guid: 'counterparty-guid',
      inn: '540000000001',
      kpp: '540001001',
      phone: '+7 913 000-00-01',
      email: 'counterparty@example.test',
    });
  });

  it.each([
    ['/api/client-orders/agreements', 'getClientOrdersAgreements', { counterpartyGuid: 'counterparty-guid' }],
    ['/api/client-orders/contracts', 'getClientOrdersContracts', { counterpartyGuid: 'counterparty-guid' }],
    ['/api/client-orders/warehouses', 'getClientOrdersWarehouses', { counterpartyGuid: 'counterparty-guid' }],
    ['/api/client-orders/delivery-addresses', 'getClientOrdersDeliveryAddresses', { counterpartyGuid: 'counterparty-guid' }],
    ['/api/client-orders/price-types', 'getClientOrdersPriceTypes', {}],
  ])('returns paged live references from %s', async (path, methodName, extraQuery) => {
    const loader = service[methodName as keyof typeof service] as jest.Mock;
    loader.mockResolvedValueOnce(page([{ guid: `${methodName}-guid`, name: 'Справочник', fullAddress: 'Адрес' }], { total: 3, limit: 10, offset: 5 }));

    const response = await request(app)
      .get(path)
      .query({ limit: 10, offset: 5, search: 'abc', includeInactive: 'false', ...extraQuery });

    expect(response.status).toBe(200);
    expect(loader).toHaveBeenCalledWith({
      limit: 10,
      offset: 5,
      search: 'abc',
      includeInactive: false,
      ...extraQuery,
    });
    expectPagedResponse(response.body, 1, { total: 3, limit: 10, offset: 5 });
  });

  it('passes product context and inStockOnly to the live products endpoint', async () => {
    jest.mocked(service.getClientOrdersProducts).mockResolvedValueOnce(
      page(
        [
          {
            guid: 'product-guid',
            name: 'Молоко',
            article: 'YT-00008199',
            basePrice: 123.45,
            stock: { quantity: 37, available: 35 },
            packages: [{ guid: 'package-guid', name: 'кор', multiplier: 12 }],
          },
        ],
        { total: 12, limit: 25, offset: 0 }
      )
    );

    const response = await request(app).get('/api/client-orders/products').query({
      limit: 25,
      offset: 0,
      search: 'молоко',
      counterpartyGuid: 'counterparty-guid',
      agreementGuid: 'agreement-guid',
      warehouseGuid: 'warehouse-guid',
      priceTypeGuid: 'price-type-guid',
      inStockOnly: 'true',
    });

    expect(response.status).toBe(200);
    expect(service.getClientOrdersProducts).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      search: 'молоко',
      includeInactive: false,
      counterpartyGuid: 'counterparty-guid',
      agreementGuid: 'agreement-guid',
      warehouseGuid: 'warehouse-guid',
      priceTypeGuid: 'price-type-guid',
      inStockOnly: true,
    });
    expectPagedResponse(response.body, 1, { total: 12, limit: 25, offset: 0 });
    expect(response.body.data.items[0]).toMatchObject({
      guid: 'product-guid',
      basePrice: 123.45,
      stock: { quantity: 37, available: 35 },
    });
  });

  it('returns controlled 502 when 1C live reference loading fails', async () => {
    jest.mocked(service.getClientOrdersCounterparties).mockRejectedValueOnce(
      new service.ClientOrdersError(502, 'INTERNAL_ERROR' as any, 'Ошибка получения контрагентов из 1С: Не удалось подключиться к 1С.')
    );

    const response = await request(app).get('/api/client-orders/counterparties').query({ limit: 1 });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      ok: false,
      message: 'Ошибка получения контрагентов из 1С: Не удалось подключиться к 1С.',
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('rejects invalid pagination before calling the live adapter', async () => {
    const response = await request(app).get('/api/client-orders/products').query({ limit: 0 });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(service.getClientOrdersProducts).not.toHaveBeenCalled();
  });

  it('routes queued order unqueue requests to the service', async () => {
    jest.mocked(service.unqueueClientOrder).mockResolvedValueOnce({
      guid: 'order-guid',
      status: 'DRAFT',
      syncState: 'DRAFT',
      revision: 8,
      items: [],
      events: [],
    } as any);

    const response = await request(app)
      .post('/api/client-orders/order-guid/unqueue')
      .send({ revision: 7 });

    expect(response.status).toBe(200);
    expect(service.unqueueClientOrder).toHaveBeenCalledWith('order-guid', 1, { revision: 7 });
    expect(response.body.data).toMatchObject({ guid: 'order-guid', status: 'DRAFT', syncState: 'DRAFT' });
  });

  it('rejects invalid unqueue body before calling service', async () => {
    const response = await request(app)
      .post('/api/client-orders/order-guid/unqueue')
      .send({ revision: 0 });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(service.unqueueClientOrder).not.toHaveBeenCalled();
  });

  it('routes order copy requests to the service', async () => {
    jest.mocked(service.copyClientOrder).mockResolvedValueOnce({
      guid: 'copy-guid',
      status: 'DRAFT',
      syncState: 'DRAFT',
      revision: 1,
      items: [],
      events: [],
    } as any);

    const response = await request(app)
      .post('/api/client-orders/source-guid/copy')
      .send({ revision: 3 });

    expect(response.status).toBe(201);
    expect(service.copyClientOrder).toHaveBeenCalledWith('source-guid', 1, { revision: 3 });
    expect(response.body.data).toMatchObject({ guid: 'copy-guid', status: 'DRAFT' });
  });

  it('routes cancelled order restore requests to the service', async () => {
    jest.mocked(service.restoreClientOrder).mockResolvedValueOnce({
      guid: 'cancelled-guid',
      status: 'DRAFT',
      syncState: 'DRAFT',
      revision: 4,
      items: [],
      events: [],
    } as any);

    const response = await request(app)
      .post('/api/client-orders/cancelled-guid/restore')
      .send({ revision: 3 });

    expect(response.status).toBe(200);
    expect(service.restoreClientOrder).toHaveBeenCalledWith('cancelled-guid', 1, { revision: 3 });
    expect(response.body.data).toMatchObject({ guid: 'cancelled-guid', status: 'DRAFT' });
  });

  it('routes local draft and queued deletes to the service', async () => {
    jest.mocked(service.deleteDraftClientOrder).mockResolvedValueOnce({ deleted: true, guid: 'queued-guid' } as any);

    const response = await request(app)
      .delete('/api/client-orders/queued-guid');

    expect(response.status).toBe(200);
    expect(service.deleteDraftClientOrder).toHaveBeenCalledWith('queued-guid');
    expect(response.body.data).toEqual({ deleted: true, guid: 'queued-guid' });
  });

  it('keeps cancel route compatible for queued-order unqueue fallback', async () => {
    jest.mocked(service.cancelClientOrder).mockResolvedValueOnce({
      guid: 'queued-guid',
      status: 'DRAFT',
      syncState: 'DRAFT',
      revision: 9,
      items: [],
      events: [],
    } as any);

    const response = await request(app)
      .post('/api/client-orders/queued-guid/cancel')
      .send({ revision: 8, reason: 'cancel queue' });

    expect(response.status).toBe(200);
    expect(service.cancelClientOrder).toHaveBeenCalledWith('queued-guid', 1, { revision: 8, reason: 'cancel queue' });
    expect(response.body.data).toMatchObject({ guid: 'queued-guid', status: 'DRAFT' });
  });
});
