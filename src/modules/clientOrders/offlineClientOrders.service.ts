import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../prisma/client';
import { reconcileOfflineProjection } from './offlineProjection';
import { ErrorCodes } from '../../utils/apiResponse';
import { ClientOrdersError } from './clientOrders.service';
import { getOfflineExportPolicy, priceTypeClosure, type ResolvedOfflinePolicy } from './offlineExportPolicy';

export const OFFLINE_DATASET_SCHEMA_VERSION = 1;
export const OFFLINE_DATASET_SCOPE = 'client-orders';
export const OFFLINE_DATASET_ENTITIES = [
  'organizations',
  'warehouses',
  'counterparties',
  'agreements',
  'contracts',
  'delivery-addresses',
  'price-types',
  'order-options',
  'selling-prices',
  'stock',
  'manager-stock',
] as const;

export type OfflineDatasetEntity = typeof OFFLINE_DATASET_ENTITIES[number];
type Tx = Prisma.TransactionClient;

const offlineEnabled = () =>
  process.env.CLIENT_ORDERS_OFFLINE_ENABLED === 'true'
  || (process.env.CLIENT_ORDERS_OFFLINE_ENABLED !== 'false' && process.env.NODE_ENV !== 'production');

const offlineChangeRevisionWindow = () => {
  const parsed = Number(process.env.CLIENT_ORDERS_OFFLINE_CHANGE_WINDOW ?? 250_000);
  return BigInt(Number.isFinite(parsed) ? Math.max(10_000, Math.trunc(parsed)) : 250_000);
};

function assertOfflineEnabled() {
  if (!offlineEnabled()) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Офлайн-черновики пока не включены');
  }
}

function numberValue(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Prisma.Decimal) return item.toNumber();
    if (item instanceof Date) return item.toISOString();
    return item;
  })) as T;
}

async function managerGuidForUser(userId: number) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { onecUserGuid: true },
  });
  const managerGuid = profile?.onecUserGuid?.trim();
  if (!managerGuid) {
    throw new ClientOrdersError(
      409,
      ErrorCodes.CONFLICT,
      'Для пользователя не настроена связь с менеджером 1С'
    );
  }
  return managerGuid;
}

const activeContractWhere = { isActive: true, status: 'Действует' };
const activeAgreementWhere = { isActive: true, status: 'Действует' };
const accessibleCounterpartyWhere = (managerGuid: string): Prisma.CounterpartyWhereInput => ({
  isActive: true,
  OR: [
    { managerGuid },
    { managerLinks: { some: { managerGuid, isActive: true } } },
    { contracts: { some: { managerGuid, ...activeContractWhere } } },
    { agreements: { some: { managerGuid, ...activeAgreementWhere } } },
  ],
});

async function accessibleCounterpartyIds(managerGuid: string, db: Tx = prisma) {
  const items = await db.counterparty.findMany({
    where: accessibleCounterpartyWhere(managerGuid),
    select: { id: true },
  });
  return items.map((item) => item.id);
}

const productWhere = (policy: ResolvedOfflinePolicy | null): Prisma.ProductWhereInput => ({
  isActive: true, ...(policy ? { guid: { in: policy.productGuids } } : {}),
});
const activeStockWhere = (policy: ResolvedOfflinePolicy | null, managerReserve = false) => ({
  product: productWhere(policy),
  warehouse: { isActive: true, ...(policy ? { guid: { in: policy.warehouseGuids } } : {}) },
  OR: policy?.stockOrganizationGuid && !managerReserve
    ? [{ organization: { is: { guid: policy.stockOrganizationGuid } } }]
    : [
    { organizationId: null },
    { organization: { is: { isActive: true, ...(policy ? { guid: { in: policy.organizationGuids } } : {}) } } },
  ],
});

async function accessiblePriceTypeGuids(managerGuid: string, policy: ResolvedOfflinePolicy | null, db: Tx = prisma) {
  const agreements = await db.clientAgreement.findMany({
    where: { ...activeAgreementWhere, counterparty: { is: accessibleCounterpartyWhere(managerGuid) }, priceTypeId: { not: null } },
    distinct: ['priceTypeId'], select: { priceType: { select: { guid: true } } },
  });
  return priceTypeClosure(agreements.flatMap(item => item.priceType ? [item.priceType.guid] : []), policy?.priceTypes ?? []);
}

async function decorateStockBalances(balances: any[], policy: ResolvedOfflinePolicy | null, db: Tx = prisma) {
  if (!balances.length) return [];
  const productIds = [...new Set(balances.map((item) => item.productId as string))];
  const costs = await db.productPrice.findMany({
      where: { productId: { in: productIds }, isActive: true, priceType: { name: 'ЦенаПоступления' } },
      orderBy: [{ startDate: 'desc' }],
      distinct: ['productId'],
      select: { product: { select: { guid: true } }, price: true },
    });
  const costByProduct = new Map(costs.map((item) => [item.product.guid, numberValue(item.price)]));
  return balances.map((item) => {
    const quantity = numberValue(item.quantity) ?? 0;
    const totalReserved = numberValue(item.reserved) ?? 0;
    const freeAvailable = numberValue(item.available) ?? Math.max(quantity - totalReserved, 0);
    const { productId: _productId, warehouseId: _warehouseId, ...publicItem } = item;
    return {
      ...publicItem,
      // These registers contain warehouse-wide stock, not stock owned by an organization.
      ...(policy?.stockOrganizationGuid ? { organization: null } : {}),
      receiptPrice: costByProduct.get(item.product.guid) ?? null,
      freeAvailable,
      ownReserve: 0,
      available: Math.max(freeAvailable, 0),
    };
  });
}

export async function itemsForEntity(entity: OfflineDatasetEntity, managerGuid: string, policy: ResolvedOfflinePolicy | null, db: Tx = prisma): Promise<Array<Record<string, unknown>>> {
  const counterpartyIds = entity === 'organizations' || entity === 'warehouses' || entity === 'stock' || entity === 'manager-stock'
    ? []
    : await accessibleCounterpartyIds(managerGuid, db);

  switch (entity) {
    case 'organizations':
      return db.organization.findMany({
        where: { isActive: true, ...(policy ? { guid: { in: policy.organizationGuids } } : {}) },
        orderBy: { guid: 'asc' },
        select: { guid: true, name: true, code: true, isActive: true, sourceUpdatedAt: true },
      });
    case 'warehouses':
      return db.warehouse.findMany({
        where: { isActive: true, ...(policy ? { guid: { in: policy.warehouseGuids } } : {}) },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, code: true, address: true,
          isDefault: true, isPickup: true, isActive: true, sourceUpdatedAt: true,
        },
      });
    case 'counterparties':
      return db.counterparty.findMany({
        where: { id: { in: counterpartyIds }, isActive: true },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, fullName: true, inn: true, kpp: true,
          phone: true, email: true, isActive: true, sourceUpdatedAt: true,
        },
      });
    case 'agreements':
      return db.clientAgreement.findMany({
        where: { ...activeAgreementWhere, counterpartyId: { in: counterpartyIds } },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, number: true, date: true, validFrom: true, validTo: true,
          status: true, currency: true, paymentForm: true, deliveryTerm: true,
          settlementProcedure: true, managerGuid: true, isActive: true, sourceUpdatedAt: true,
          counterparty: { select: { guid: true } },
          organization: { select: { guid: true } },
          contract: { select: { guid: true } },
          warehouse: { select: { guid: true } },
          priceType: { select: { guid: true } },
        },
      });
    case 'contracts':
      return db.clientContract.findMany({
        where: { ...activeContractWhere, counterpartyId: { in: counterpartyIds } },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, printName: true, number: true, date: true,
          validFrom: true, validTo: true, status: true, purpose: true, currency: true,
          paymentTermDays: true, settlementProcedure: true, deliveryMethod: true,
          deliveryAddress: true, managerGuid: true, isActive: true, sourceUpdatedAt: true,
          counterparty: { select: { guid: true } },
          organization: { select: { guid: true } },
        },
      });
    case 'delivery-addresses':
      return db.deliveryAddress.findMany({
        where: { isActive: true, counterpartyId: { in: counterpartyIds }, guid: { not: null } },
        orderBy: [{ guid: 'asc' }, { counterpartyId: 'asc' }],
        select: {
          guid: true, name: true, fullAddress: true, city: true, street: true,
          house: true, building: true, apartment: true, postcode: true, comment: true, kindName: true,
          isDefault: true, isActive: true, sourceUpdatedAt: true,
          counterparty: { select: { guid: true } },
        },
      }) as Promise<Array<Record<string, unknown>>>;
    case 'price-types': {
      const guids = await accessiblePriceTypeGuids(managerGuid, policy, db);
      return db.priceType.findMany({
        where: { isActive: true, guid: { in: guids } },
        orderBy: { guid: 'asc' },
        select: { guid: true, name: true, code: true, isActive: true, sourceUpdatedAt: true },
      });
    }
    case 'order-options': {
      const [agreements, contracts] = await Promise.all([
        db.clientAgreement.findMany({
          where: { ...activeAgreementWhere, counterpartyId: { in: counterpartyIds } },
          select: { paymentForm: true, deliveryTerm: true, sourceUpdatedAt: true },
        }),
        db.clientContract.findMany({
          where: { ...activeContractWhere, counterpartyId: { in: counterpartyIds } },
          select: { deliveryMethod: true, sourceUpdatedAt: true },
        }),
      ]);
      const values = new Map<string, Record<string, unknown>>();
      const append = (kind: 'payment-form' | 'delivery-method', raw: string | null, sourceUpdatedAt: Date | null) => {
        const value = raw?.trim();
        if (!value) return;
        const guid = `${kind}:${value}`;
        const previous = values.get(guid);
        const previousUpdatedAt = previous?.sourceUpdatedAt instanceof Date ? previous.sourceUpdatedAt : null;
        values.set(guid, {
          guid,
          kind,
          code: value,
          name: value,
          isActive: true,
          sourceUpdatedAt: !previousUpdatedAt || (sourceUpdatedAt && sourceUpdatedAt > previousUpdatedAt)
            ? sourceUpdatedAt
            : previousUpdatedAt,
        });
      };
      agreements.forEach((item) => {
        append('payment-form', item.paymentForm, item.sourceUpdatedAt);
        append('delivery-method', item.deliveryTerm, item.sourceUpdatedAt);
      });
      contracts.forEach((item) => append('delivery-method', item.deliveryMethod, item.sourceUpdatedAt));
      return [...values.values()].sort((left, right) => String(left.guid).localeCompare(String(right.guid), 'ru'));
    }
    case 'selling-prices': {
      const guids = await accessiblePriceTypeGuids(managerGuid, policy, db);
      return db.sellingPrice.findMany({
        where: { isActive: true, product: productWhere(policy), priceType: { isActive: true, guid: { in: guids } } },
        orderBy: { syncKey: 'asc' },
        select: {
          syncKey: true, price: true, currency: true, packageGuid: true,
          characteristicGuid: true, sourceRegister: true, priority: true,
          startDate: true, endDate: true, minQty: true, isActive: true, sourceUpdatedAt: true,
          product: { select: { guid: true } },
          priceType: { select: { guid: true } },
        },
      }) as Promise<Array<Record<string, unknown>>>;
    }
    case 'stock': {
      const balances = await db.stockBalance.findMany({
          where: activeStockWhere(policy),
          orderBy: { syncKey: 'asc' },
          select: {
            productId: true, warehouseId: true,
            syncKey: true, quantity: true, reserved: true, inStock: true, shipping: true,
            clientReserved: true, managerReserved: true, available: true,
            seriesGuid: true,
            sourceUpdatedAt: true, updatedAt: true,
            product: { select: { guid: true } },
            warehouse: { select: { guid: true } },
            organization: { select: { guid: true } },
          },
      });
      return decorateStockBalances(balances, policy, db);
    }
    case 'manager-stock': {
      return db.managerStockReservation.findMany({
        where: {
          managerGuid,
          reserved: { gt: 0 },
          ...activeStockWhere(policy, true),
        },
        orderBy: { syncKey: 'asc' },
        select: {
          syncKey: true,
          reserved: true,
          sourceUpdatedAt: true,
          product: { select: { guid: true } },
          warehouse: { select: { guid: true } },
          organization: { select: { guid: true } },
        },
      }) as Promise<Array<Record<string, unknown>>>;
    }
  }
}

async function getLargeEntityPage(
  entity: 'selling-prices' | 'stock' | 'manager-stock',
  managerGuid: string,
  cursor: string | null | undefined,
  limit: number,
  policy: ResolvedOfflinePolicy | null,
  db: Tx = prisma
): Promise<Array<Record<string, unknown>>> {
  if (entity === 'selling-prices') {
    return db.sellingPrice.findMany({
      where: {
        isActive: true,
        product: productWhere(policy),
        priceType: { isActive: true, guid: { in: await accessiblePriceTypeGuids(managerGuid, policy, db) } },
        ...(cursor ? { syncKey: { gt: cursor } } : {}),
      },
      orderBy: { syncKey: 'asc' },
      take: limit,
      select: {
        syncKey: true, price: true, currency: true, packageGuid: true,
        characteristicGuid: true, sourceRegister: true, priority: true,
        startDate: true, endDate: true, minQty: true, isActive: true, sourceUpdatedAt: true,
        product: { select: { guid: true } },
        priceType: { select: { guid: true } },
      },
    }) as Promise<Array<Record<string, unknown>>>;
  }
  if (entity === 'manager-stock') {
    return db.managerStockReservation.findMany({
      where: {
        managerGuid,
        reserved: { gt: 0 },
        ...activeStockWhere(policy, true),
        ...(cursor ? { syncKey: { gt: cursor } } : {}),
      },
      orderBy: { syncKey: 'asc' },
      take: limit,
      select: {
        syncKey: true,
        reserved: true,
        sourceUpdatedAt: true,
        product: { select: { guid: true } },
        warehouse: { select: { guid: true } },
        organization: { select: { guid: true } },
      },
    }) as Promise<Array<Record<string, unknown>>>;
  }
  const balances = await db.stockBalance.findMany({
    where: { ...activeStockWhere(policy), ...(cursor ? { syncKey: { gt: cursor } } : {}) },
    orderBy: { syncKey: 'asc' },
    take: limit,
    select: {
      productId: true, warehouseId: true,
      syncKey: true, quantity: true, reserved: true, inStock: true, shipping: true,
      clientReserved: true, managerReserved: true, available: true, seriesGuid: true,
      sourceUpdatedAt: true, updatedAt: true,
      product: { select: { guid: true } },
      warehouse: { select: { guid: true } },
      organization: { select: { guid: true } },
    },
  });
  return decorateStockBalances(balances, policy, db);
}

export function itemKey(entity: OfflineDatasetEntity, item: Record<string, unknown>) {
  if (entity === 'delivery-addresses') {
    return JSON.stringify([(item.counterparty as { guid?: string } | undefined)?.guid ?? item.counterpartyGuid ?? '', item.guid ?? '']);
  }
  if (entity === 'selling-prices') return String(item.syncKey ?? '');
  if (entity === 'manager-stock') return String(item.syncKey ?? '');
  if (entity === 'stock') {
    const product = item.product as { guid?: string } | undefined;
    const warehouse = item.warehouse as { guid?: string } | undefined;
    const organization = item.organization as { guid?: string } | undefined;
    return `${product?.guid ?? ''}|${warehouse?.guid ?? ''}|${organization?.guid ?? ''}|${item.seriesGuid ?? ''}`;
  }
  return String(item.guid ?? '');
}

const projectionScope = (managerGuid: string) => `client-orders-v3:${managerGuid}`;
const sourceDependencies: Record<OfflineDatasetEntity, OfflineDatasetEntity[]> = {
  organizations: ['organizations'], warehouses: ['warehouses'],
  counterparties: ['counterparties'], agreements: ['agreements'], contracts: ['contracts'],
  'delivery-addresses': ['delivery-addresses'], 'order-options': ['order-options'],
  'price-types': ['price-types', 'selling-prices'],
  'selling-prices': ['selling-prices', 'agreements', 'price-types'],
  stock: ['stock', 'warehouses', 'organizations'],
  'manager-stock': ['manager-stock', 'warehouses', 'organizations'],
};

async function prepareOfflineProjection(managerGuid: string) {
  // Serialize builders across API replicas. RepeatableRead prevents a snapshot
  // mixing half of one 1C exchange with half of another. A waiter retries on 40001.
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const scopeKey = projectionScope(managerGuid);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`;
        const policy = await getOfflineExportPolicy(tx);
        const source = await tx.offlineDatasetState.findMany({ where: { scopeKey: OFFLINE_DATASET_SCOPE } });
        if (!source.length) throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Офлайн-данные ещё не подготовлены на сервере');
        const sourceByEntity = new Map(source.map(row => [row.entity, row]));
        const catalog = await tx.catalogState.findUnique({ where: { id: 'nomenclature' }, select: { epoch: true, currentRevision: true } });
        const entries = [];
        for (const entity of OFFLINE_DATASET_ENTITIES) {
          const large = entity === 'selling-prices' || entity === 'stock' || entity === 'manager-stock';
          const fingerprint = createHash('sha256').update(JSON.stringify({
            version: 3, policy: policy?.fingerprint,
            catalog: large ? jsonSafe(catalog) : undefined,
            sources: sourceDependencies[entity].map(name => {
              const row = sourceByEntity.get(name);
              return row ? [name, row.epoch, row.currentRevision.toString()] : [name];
            }),
          })).digest('hex');
          const state = await reconcileOfflineProjection(tx, {
            scopeKey, entity, schemaVersion: entity === 'delivery-addresses' ? 2 : OFFLINE_DATASET_SCHEMA_VERSION,
            fingerprint,
            pages: async function* () {
              if (entity === 'selling-prices' || entity === 'stock' || entity === 'manager-stock') {
                let cursor: string | null = null;
                while (true) {
                  const rows = await getLargeEntityPage(entity, managerGuid, cursor, 1000, policy, tx);
                  yield rows.map(item => ({ key: itemKey(entity, item), item: jsonSafe(item) }));
                  if (rows.length < 1000) break;
                  cursor = String(rows[rows.length - 1].syncKey);
                }
              } else {
                const rows = await itemsForEntity(entity, managerGuid, policy, tx);
                for (let offset = 0; offset < rows.length; offset += 1000) {
                  yield rows.slice(offset, offset + 1000).map(item => ({ key: itemKey(entity, item), item: jsonSafe(item) }));
                }
              }
            },
          });
          const sourceState = sourceByEntity.get(entity);
          const verifiedAt = sourceState?.lastSourceUpdateAt ?? sourceState?.lastFullReconcileAt ?? null;
          entries.push({ ...state, lastVerifiedAt: verifiedAt });
        }
        return entries;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 15_000 });
    } catch (error) {
      const failure = error as { code?: string; meta?: { code?: string } };
      const retryable = failure.code === 'P2034' || ['40001', '40P01'].includes(failure.meta?.code ?? '');
      if (attempt >= 2 || !retryable) throw error;
    }
  }
}

export async function getOfflineManifest(userId: number) {
  assertOfflineEnabled();
  const managerGuid = await managerGuidForUser(userId);
  const states = await prepareOfflineProjection(managerGuid);
  return jsonSafe({
    enabled: true, schemaVersion: OFFLINE_DATASET_SCHEMA_VERSION, managerScope: 'authenticated-user', generatedAt: new Date(),
    entities: states.map(state => ({ entity: state.entity, epoch: state.epoch, schemaVersion: state.schemaVersion,
      revision: state.currentRevision.toString(), minAvailableRevision: state.minAvailableRevision.toString(),
      itemCount: state.itemCount, lastChangedAt: state.lastSourceUpdateAt,
      // For balances/prices freshness means the last successful source exchange,
      // even when values did not change. Never claim a phone check refreshed 1C.
      lastSourceUpdateAt: ['stock', 'selling-prices', 'manager-stock'].includes(state.entity)
        ? state.lastVerifiedAt : state.lastSourceUpdateAt,
      lastVerifiedAt: state.lastVerifiedAt, lastFullReconcileAt: state.lastFullReconcileAt })),
  });
}

async function readProjection<T>(userId: number, entity: OfflineDatasetEntity,
  read: (tx: Tx, state: NonNullable<Awaited<ReturnType<Tx['offlineDatasetState']['findUnique']>>>) => Promise<T>) {
  assertOfflineEnabled();
  const scopeKey = projectionScope(await managerGuidForUser(userId));
  return prisma.$transaction(async tx => {
    const state = await tx.offlineDatasetState.findUnique({ where: { scopeKey_entity: { scopeKey, entity } } });
    if (!state) throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Обновите версии офлайн-данных');
    return read(tx, state);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getOfflineSnapshot(userId: number, entity: OfflineDatasetEntity, options: { cursor?: string | null; limit: number }) {
  return readProjection(userId, entity, async (tx, state) => {
    const rows = await tx.offlineDatasetRow.findMany({
      where: { scopeKey: state.scopeKey, entity, ...(options.cursor ? { itemKey: { gt: options.cursor } } : {}) },
      orderBy: { itemKey: 'asc' }, take: options.limit + 1,
    });
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    return jsonSafe({ entity, epoch: state.epoch, schemaVersion: state.schemaVersion, snapshotRevision: state.currentRevision.toString(),
      items: page.map(row => row.payload), hasMore, nextCursor: hasMore ? page[page.length - 1].itemKey : null,
      lastSourceUpdateAt: state.lastSourceUpdateAt });
  });
}

export async function getOfflineChanges(userId: number, entity: OfflineDatasetEntity,
  options: { afterRevision: bigint; limit: number; epoch: string; untilRevision?: string }) {
  return readProjection(userId, entity, async (tx, state) => {
    const until = options.untilRevision === undefined ? state.currentRevision : BigInt(options.untilRevision);
    if (state.epoch !== options.epoch || options.afterRevision < state.minAvailableRevision
      || options.afterRevision > until || until > state.currentRevision) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Требуется повторная проверка версий офлайн-данных');
    }
    const rows = await tx.offlineDatasetChange.findMany({
      where: { scopeKey: state.scopeKey, entity, revision: { gt: options.afterRevision, lte: until } },
      orderBy: { revision: 'asc' }, take: options.limit + 1,
    });
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const nextRevision = hasMore ? page[page.length - 1].revision : until;
    return jsonSafe({ entity, epoch: state.epoch, schemaVersion: state.schemaVersion,
      fromRevision: options.afterRevision.toString(), nextRevision: nextRevision.toString(), currentRevision: until.toString(),
      changes: page.map(row => ({ revision: row.revision.toString(), itemKey: row.itemKey, operation: row.operation,
        item: row.operation === 'DELETE' ? null : row.payload })), hasMore });
  });
}

export async function recordOfflineDatasetChanges(
  tx: Tx,
  entity: OfflineDatasetEntity,
  itemKeys: string[],
  sourceUpdatedAt = new Date()
) {
  const keys = [...new Set(itemKeys.map((key) => key.trim()).filter(Boolean))];
  if (!keys.length) return;
  await tx.offlineDatasetChange.createMany({
    data: keys.map((key) => ({
      scopeKey: OFFLINE_DATASET_SCOPE,
      entity,
      itemKey: key,
      operation: 'UPSERT',
      sourceUpdatedAt,
    })),
  });
  const latest = await tx.offlineDatasetChange.findFirst({
    where: { scopeKey: OFFLINE_DATASET_SCOPE, entity },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  const currentRevision = latest?.revision ?? 0n;
  const minAvailableRevision = currentRevision > offlineChangeRevisionWindow()
    ? currentRevision - offlineChangeRevisionWindow()
    : 0n;
  if (minAvailableRevision > 0n) {
    await tx.offlineDatasetChange.deleteMany({
      where: {
        scopeKey: OFFLINE_DATASET_SCOPE,
        entity,
        revision: { lte: minAvailableRevision },
      },
    });
  }
  await tx.offlineDatasetState.upsert({
    where: { scopeKey_entity: { scopeKey: OFFLINE_DATASET_SCOPE, entity } },
    create: {
      scopeKey: OFFLINE_DATASET_SCOPE,
      entity,
      schemaVersion: OFFLINE_DATASET_SCHEMA_VERSION,
      currentRevision,
      minAvailableRevision,
      lastSourceUpdateAt: sourceUpdatedAt,
    },
    update: {
      currentRevision,
      minAvailableRevision,
      lastSourceUpdateAt: sourceUpdatedAt,
    },
  });
}

export async function resetOfflineDataset(entity: OfflineDatasetEntity, tx: Tx | PrismaClient = prisma) {
  await tx.offlineDatasetChange.deleteMany({ where: { scopeKey: OFFLINE_DATASET_SCOPE, entity } });
  await tx.offlineDatasetState.upsert({
    where: { scopeKey_entity: { scopeKey: OFFLINE_DATASET_SCOPE, entity } },
    create: { scopeKey: OFFLINE_DATASET_SCOPE, entity, epoch: randomUUID() },
    update: {
      epoch: randomUUID(),
      currentRevision: 0n,
      minAvailableRevision: 0n,
      itemCount: 0,
      lastFullReconcileAt: new Date(),
    },
  });
}
