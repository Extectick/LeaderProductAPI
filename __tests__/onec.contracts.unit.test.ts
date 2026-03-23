import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const tx = {
  product: {
    findMany: jest.fn(),
  },
  priceType: {
    findMany: jest.fn(),
  },
  productPrice: {
    upsert: jest.fn(),
  },
} as any;

const prismaMock = {
  $transaction: jest.fn(async (cb: any) => cb(tx)),
  $disconnect: jest.fn(),
  $connect: jest.fn(),
  syncRun: {
    create: jest.fn(),
    update: jest.fn(),
  },
  syncRunItem: {
    createMany: jest.fn(),
  },
  order: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: prismaMock,
  prisma: prismaMock,
}));

import app from '../src/index';

describe('1C route contracts', () => {
  beforeEach(() => {
    process.env.ONEC_SECRET = 'test-secret';
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));
    prismaMock.syncRun.create.mockResolvedValue({ id: 'run-1', requestId: 'req-1' });
    prismaMock.syncRun.update.mockResolvedValue({});
    prismaMock.syncRunItem.createMany.mockResolvedValue({ count: 0 });
  });

  it('rejects non-export statuses on order ack', async () => {
    const response = await request(app).post('/api/1c/orders/order-guid/ack').send({
      secret: 'test-secret',
      status: 'CONFIRMED',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation error');
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it('returns 1C schema for configurator bootstrap', async () => {
    const response = await request(app).get('/api/1c/schema').query({
      secret: 'test-secret',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.version).toBe('1.0.0');
    expect(response.body.entities).toHaveLength(7);
    expect(response.body.entities.map((entity: any) => entity.code)).toEqual([
      'nomenclature',
      'warehouses',
      'counterparties',
      'agreements',
      'product-prices',
      'special-prices',
      'stock',
    ]);
    expect(
      response.body.entities.find((entity: any) => entity.code === 'nomenclature').sections.map((section: any) => section.code)
    ).toEqual(['group', 'product', 'baseUnit', 'packages']);
  });

  it('requires secret for 1C schema', async () => {
    const response = await request(app).get('/api/1c/schema');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Unauthorized');
  });

  it('returns a collision-safe key for product prices without guid', async () => {
    tx.product.findMany.mockResolvedValue([{ id: 'product-1', guid: 'PRODUCT_GUID' }]);
    tx.priceType.findMany.mockResolvedValue([{ id: 'price-type-1', guid: 'PRICE_TYPE_GUID' }]);
    tx.productPrice.upsert.mockResolvedValue({});

    const response = await request(app).post('/api/1c/product-prices/batch').send({
      secret: 'test-secret',
      items: [
        {
          productGuid: 'PRODUCT_GUID',
          priceTypeGuid: 'PRICE_TYPE_GUID',
          price: 120.5,
          startDate: '2025-01-01T00:00:00Z',
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.results[0].key).toBe(
      'productGuid=PRODUCT_GUID|priceTypeGuid=PRICE_TYPE_GUID|startDate=2025-01-01T00:00:00.000Z'
    );
  });
});
