import request from 'supertest';

const tx = {
  productGroup: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  unit: {
    upsert: jest.fn(),
  },
  product: {
    upsert: jest.fn(),
  },
  productPackage: {
    upsert: jest.fn(),
    create: jest.fn(),
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
};

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: prismaMock,
  prisma: prismaMock,
}));

import app from '../src/index';

describe('POST /api/1c/nomenclature/batch', () => {
  beforeEach(() => {
    process.env.ONEC_SECRET = 'test-secret';
    jest.clearAllMocks();
    tx.productGroup.findUnique.mockResolvedValue(null);
    tx.productGroup.upsert.mockResolvedValue({ id: 'group1', guid: 'group-guid' });
    tx.unit.upsert.mockResolvedValue({ id: 'unit1', guid: 'unit-guid' });
    tx.product.upsert.mockResolvedValue({ id: 'product1', guid: 'product-guid' });
    tx.productPackage.upsert.mockResolvedValue({});
    tx.productPackage.create.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx));
    prismaMock.syncRun.create.mockResolvedValue({ id: 'run-1', requestId: 'req-1' });
    prismaMock.syncRun.update.mockResolvedValue({});
    prismaMock.syncRunItem.createMany.mockResolvedValue({ count: 0 });
  });

  it('returns 200 and upserts entities on success', async () => {
    const response = await request(app).post('/api/1c/nomenclature/batch').send({
      secret: 'test-secret',
      items: [
        {
          guid: 'group-guid',
          isGroup: true,
          parentGuid: null,
          name: 'Group',
          code: '001',
          isActive: true,
        },
        {
          guid: 'product-guid',
          isGroup: false,
          parentGuid: 'group-guid',
          name: 'Product',
          code: '002',
          article: 'A1',
          sku: 'SKU1',
          isWeight: false,
          isService: false,
          isActive: true,
          baseUnit: {
            guid: 'unit-guid',
            name: 'Piece',
            code: '796',
            symbol: 'pc',
          },
          packages: [
            {
              guid: 'pkg-guid',
              name: 'Box',
              unit: {
                guid: 'unit-guid',
                name: 'Piece',
                code: '796',
                symbol: 'pc',
              },
              multiplier: 1,
              barcode: '123',
              isDefault: true,
              sortOrder: 0,
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(2);
    expect(tx.productGroup.upsert).toHaveBeenCalled();
    expect(tx.product.upsert).toHaveBeenCalled();
  });

  it('returns 400 on validation error', async () => {
    const response = await request(app).post('/api/1c/nomenclature/batch').send({
      secret: 'test-secret',
      items: [],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation error');
  });

  it('returns 401 on invalid secret', async () => {
    const response = await request(app).post('/api/1c/nomenclature/batch').send({
      secret: 'wrong-secret',
      items: [
        {
          guid: 'group-guid',
          isGroup: true,
          parentGuid: null,
          name: 'Group',
          code: '001',
        },
      ],
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Unauthorized');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
