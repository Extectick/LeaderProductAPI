import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ProfileStatus } from '@prisma/client';
import app, { prisma } from '../src';

const TEST_PREFIX = `test-mp-${Date.now()}`;

function createToken(userId: number, role: string) {
  const secret = process.env.ACCESS_TOKEN_SECRET || 'test_jwt_secret';
  return jwt.sign(
    {
      userId,
      role,
      permissions: [],
      profileStatus: ProfileStatus.ACTIVE,
    },
    secret,
    { expiresIn: '1h' }
  );
}

async function cleanupByPrefix(prefix: string) {
  await prisma.orderItem.deleteMany({
    where: { order: { guid: { startsWith: prefix } } },
  });
  await prisma.order.deleteMany({ where: { guid: { startsWith: prefix } } });

  await prisma.specialPrice.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.stockBalance.deleteMany({ where: { product: { guid: { startsWith: prefix } } } });
  await prisma.productPackage.deleteMany({ where: { product: { guid: { startsWith: prefix } } } });
  await prisma.product.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.productGroup.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.unit.deleteMany({ where: { guid: { startsWith: prefix } } });

  await prisma.clientAgreement.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.clientContract.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.priceType.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.deliveryAddress.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.warehouse.deleteMany({ where: { guid: { startsWith: prefix } } });
  await prisma.counterparty.deleteMany({ where: { guid: { startsWith: prefix } } });

  await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
}

describe('Marketplace read API', () => {
  let token: string;
  let productGuid: string;
  let counterpartyGuid: string;
  let agreementGuid: string;
  let priceTypeGuid: string;

  beforeAll(async () => {
    await cleanupByPrefix(TEST_PREFIX);

    const role = await prisma.role.findUnique({ where: { name: 'user' } });
    if (!role) throw new Error('Role "user" not found');

    const user = await prisma.user.create({
      data: {
        email: `${TEST_PREFIX}-user@example.com`,
        passwordHash: 'test-hash',
        roleId: role.id,
        profileStatus: ProfileStatus.ACTIVE,
      },
    });
    token = createToken(user.id, 'user');

    const unit = await prisma.unit.create({
      data: { guid: `${TEST_PREFIX}-unit`, name: 'Штука', code: '796', symbol: 'шт' },
    });

    const group = await prisma.productGroup.create({
      data: { guid: `${TEST_PREFIX}-group`, name: 'Тестовая группа', isActive: true },
    });

    const product = await prisma.product.create({
      data: {
        guid: `${TEST_PREFIX}-product`,
        name: 'Тестовый товар',
        code: 'T-001',
        article: 'ART-001',
        sku: 'SKU-001',
        isActive: true,
        groupId: group.id,
        baseUnitId: unit.id,
      },
    });
    productGuid = product.guid;

    const warehouse = await prisma.warehouse.create({
      data: { guid: `${TEST_PREFIX}-wh`, name: 'Тестовый склад', isActive: true },
    });

    await prisma.stockBalance.create({
      data: {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity: 10,
        reserved: 2,
        updatedAt: new Date(),
      },
    });

    const counterparty = await prisma.counterparty.create({
      data: { guid: `${TEST_PREFIX}-cp`, name: 'Тестовый клиент', isActive: true },
    });
    counterpartyGuid = counterparty.guid;

    const priceType = await prisma.priceType.create({
      data: { guid: `${TEST_PREFIX}-pt`, name: 'Оптовая', isActive: true },
    });
    priceTypeGuid = priceType.guid;

    const contract = await prisma.clientContract.create({
      data: {
        guid: `${TEST_PREFIX}-contract`,
        counterpartyId: counterparty.id,
        number: 'D-001',
        date: new Date('2025-01-01T00:00:00Z'),
        isActive: true,
      },
    });

    const agreement = await prisma.clientAgreement.create({
      data: {
        guid: `${TEST_PREFIX}-agr`,
        name: 'Основное соглашение',
        counterpartyId: counterparty.id,
        contractId: contract.id,
        priceTypeId: priceType.id,
        isActive: true,
      },
    });
    agreementGuid = agreement.guid;

    await prisma.specialPrice.createMany({
      data: [
        {
          guid: `${TEST_PREFIX}-sp-global`,
          productId: product.id,
          price: 100,
          startDate: new Date('2025-01-01T00:00:00Z'),
          isActive: true,
        },
        {
          guid: `${TEST_PREFIX}-sp-pt`,
          productId: product.id,
          priceTypeId: priceType.id,
          price: 90,
          startDate: new Date('2025-01-01T00:00:00Z'),
          isActive: true,
        },
        {
          guid: `${TEST_PREFIX}-sp-cp`,
          productId: product.id,
          counterpartyId: counterparty.id,
          price: 80,
          startDate: new Date('2025-01-01T00:00:00Z'),
          isActive: true,
        },
        {
          guid: `${TEST_PREFIX}-sp-agr-1`,
          productId: product.id,
          agreementId: agreement.id,
          price: 70,
          startDate: new Date('2025-01-01T00:00:00Z'),
          isActive: true,
        },
        {
          guid: `${TEST_PREFIX}-sp-agr-2`,
          productId: product.id,
          agreementId: agreement.id,
          price: 65,
          startDate: new Date('2025-06-01T00:00:00Z'),
          isActive: true,
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanupByPrefix(TEST_PREFIX);
  });

  it('returns products list with stock totals', async () => {
    const res = await request(app)
      .get('/api/marketplace/products')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);

    const items: any[] = res.body?.data ?? [];
    const product = items.find((p) => p.guid === productGuid);
    expect(product).toBeTruthy();
    expect(product.stock.total).toBe(10);
    expect(product.stock.reserved).toBe(2);
    expect(product.stock.available).toBe(8);
  });

  it('returns stock by product', async () => {
    const res = await request(app)
      .get(`/api/marketplace/products/${productGuid}/stock`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.totals?.quantity).toBe(10);
    expect(res.body?.data?.totals?.reserved).toBe(2);
    expect(res.body?.data?.totals?.available).toBe(8);
    expect(res.body?.data?.items?.length).toBe(1);
  });

  it('resolves effective price by priority', async () => {
    const agreementRes = await request(app)
      .get('/api/marketplace/prices/resolve')
      .query({ productGuid, agreementGuid })
      .set('Authorization', `Bearer ${token}`);

    expect(agreementRes.status).toBe(200);
    expect(agreementRes.body?.data?.price?.value).toBe(65);
    expect(agreementRes.body?.data?.match?.level).toBe('AGREEMENT');

    const counterpartyRes = await request(app)
      .get('/api/marketplace/prices/resolve')
      .query({ productGuid, counterpartyGuid, priceTypeGuid })
      .set('Authorization', `Bearer ${token}`);

    expect(counterpartyRes.status).toBe(200);
    expect(counterpartyRes.body?.data?.price?.value).toBe(80);
    expect(counterpartyRes.body?.data?.match?.level).toBe('COUNTERPARTY');

    const priceTypeRes = await request(app)
      .get('/api/marketplace/prices/resolve')
      .query({ productGuid, priceTypeGuid })
      .set('Authorization', `Bearer ${token}`);

    expect(priceTypeRes.status).toBe(200);
    expect(priceTypeRes.body?.data?.price?.value).toBe(90);
    expect(priceTypeRes.body?.data?.match?.level).toBe('PRICE_TYPE');

    const globalRes = await request(app)
      .get('/api/marketplace/prices/resolve')
      .query({ productGuid })
      .set('Authorization', `Bearer ${token}`);

    expect(globalRes.status).toBe(200);
    expect(globalRes.body?.data?.price?.value).toBe(100);
    expect(globalRes.body?.data?.match?.level).toBe('GLOBAL');
  });
});

