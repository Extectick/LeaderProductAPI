import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../prisma/client';
import { ErrorCodes } from '../../utils/apiResponse';
import { ClientOrdersError } from './clientOrders.service';
import { getOfflineExportPolicy, priceTypeClosure, scopedEpoch, type ResolvedOfflinePolicy } from './offlineExportPolicy';

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

async function accessibleCounterpartyIds(managerGuid: string) {
  const items = await prisma.counterparty.findMany({
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

async function accessiblePriceTypeGuids(managerGuid: string, policy: ResolvedOfflinePolicy | null) {
  const agreements = await prisma.clientAgreement.findMany({
    where: { ...activeAgreementWhere, counterparty: { is: accessibleCounterpartyWhere(managerGuid) }, priceTypeId: { not: null } },
    distinct: ['priceTypeId'], select: { priceType: { select: { guid: true } } },
  });
  return priceTypeClosure(agreements.flatMap(item => item.priceType ? [item.priceType.guid] : []), policy?.priceTypes ?? []);
}

async function decorateStockBalances(balances: any[], policy: ResolvedOfflinePolicy | null) {
  if (!balances.length) return [];
  const productIds = [...new Set(balances.map((item) => item.productId as string))];
  const costs = await prisma.productPrice.findMany({
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

async function itemsForEntity(entity: OfflineDatasetEntity, managerGuid: string, policy: ResolvedOfflinePolicy | null): Promise<Array<Record<string, unknown>>> {
  const counterpartyIds = entity === 'organizations' || entity === 'warehouses' || entity === 'stock' || entity === 'manager-stock'
    ? []
    : await accessibleCounterpartyIds(managerGuid);

  switch (entity) {
    case 'organizations':
      return prisma.organization.findMany({
        where: { isActive: true, ...(policy ? { guid: { in: policy.organizationGuids } } : {}) },
        orderBy: { guid: 'asc' },
        select: { guid: true, name: true, code: true, isActive: true, sourceUpdatedAt: true },
      });
    case 'warehouses':
      return prisma.warehouse.findMany({
        where: { isActive: true, ...(policy ? { guid: { in: policy.warehouseGuids } } : {}) },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, code: true, address: true,
          isDefault: true, isPickup: true, isActive: true, sourceUpdatedAt: true,
        },
      });
    case 'counterparties':
      return prisma.counterparty.findMany({
        where: { id: { in: counterpartyIds }, isActive: true },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, fullName: true, inn: true, kpp: true,
          phone: true, email: true, isActive: true, sourceUpdatedAt: true,
        },
      });
    case 'agreements':
      return prisma.clientAgreement.findMany({
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
      return prisma.clientContract.findMany({
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
      return prisma.deliveryAddress.findMany({
        where: { isActive: true, counterpartyId: { in: counterpartyIds }, guid: { not: null } },
        orderBy: { guid: 'asc' },
        select: {
          guid: true, name: true, fullAddress: true, city: true, street: true,
          house: true, building: true, apartment: true, postcode: true,
          isDefault: true, isActive: true, sourceUpdatedAt: true,
          counterparty: { select: { guid: true } },
        },
      }) as Promise<Array<Record<string, unknown>>>;
    case 'price-types': {
      const guids = await accessiblePriceTypeGuids(managerGuid, policy);
      return prisma.priceType.findMany({
        where: { isActive: true, guid: { in: guids } },
        orderBy: { guid: 'asc' },
        select: { guid: true, name: true, code: true, isActive: true, sourceUpdatedAt: true },
      });
    }
    case 'order-options': {
      const [agreements, contracts] = await Promise.all([
        prisma.clientAgreement.findMany({
          where: { ...activeAgreementWhere, counterpartyId: { in: counterpartyIds } },
          select: { paymentForm: true, deliveryTerm: true, sourceUpdatedAt: true },
        }),
        prisma.clientContract.findMany({
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
      const guids = await accessiblePriceTypeGuids(managerGuid, policy);
      return prisma.sellingPrice.findMany({
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
      const balances = await prisma.stockBalance.findMany({
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
      return decorateStockBalances(balances, policy);
    }
    case 'manager-stock': {
      return prisma.managerStockReservation.findMany({
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

async function countItemsForEntity(entity: OfflineDatasetEntity, managerGuid: string, policy: ResolvedOfflinePolicy | null) {
  const counterpartyWhere = accessibleCounterpartyWhere(managerGuid);
  switch (entity) {
    case 'organizations': return prisma.organization.count({ where: { isActive: true, ...(policy ? { guid: { in: policy.organizationGuids } } : {}) } });
    case 'warehouses': return prisma.warehouse.count({ where: { isActive: true, ...(policy ? { guid: { in: policy.warehouseGuids } } : {}) } });
    case 'counterparties': return prisma.counterparty.count({ where: counterpartyWhere });
    case 'agreements': return prisma.clientAgreement.count({ where: { ...activeAgreementWhere, counterparty: { is: counterpartyWhere } } });
    case 'contracts': return prisma.clientContract.count({ where: { ...activeContractWhere, counterparty: { is: counterpartyWhere } } });
    case 'delivery-addresses': return prisma.deliveryAddress.count({
      where: { isActive: true, guid: { not: null }, counterparty: { is: counterpartyWhere } },
    });
    case 'price-types': return prisma.priceType.count({
      where: { isActive: true, guid: { in: await accessiblePriceTypeGuids(managerGuid, policy) } },
    });
    case 'order-options': return (await itemsForEntity(entity, managerGuid, policy)).length;
    case 'selling-prices': return prisma.sellingPrice.count({
      where: {
        isActive: true,
        product: productWhere(policy),
        priceType: { isActive: true, guid: { in: await accessiblePriceTypeGuids(managerGuid, policy) } },
      },
    });
    case 'stock': return prisma.stockBalance.count({ where: activeStockWhere(policy) });
    case 'manager-stock': return prisma.managerStockReservation.count({
      where: {
        managerGuid,
        reserved: { gt: 0 },
        ...activeStockWhere(policy, true),
      },
    });
  }
}

async function getLargeEntityPage(
  entity: 'selling-prices' | 'stock' | 'manager-stock',
  managerGuid: string,
  cursor: string | null | undefined,
  limit: number,
  policy: ResolvedOfflinePolicy | null
): Promise<Array<Record<string, unknown>>> {
  if (entity === 'selling-prices') {
    return prisma.sellingPrice.findMany({
      where: {
        isActive: true,
        product: productWhere(policy),
        priceType: { isActive: true, guid: { in: await accessiblePriceTypeGuids(managerGuid, policy) } },
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
    return prisma.managerStockReservation.findMany({
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
  const balances = await prisma.stockBalance.findMany({
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
  return decorateStockBalances(balances, policy);
}

async function getLargeItemsByKeys(
  entity: 'selling-prices' | 'stock' | 'manager-stock',
  managerGuid: string,
  itemKeys: string[],
  policy: ResolvedOfflinePolicy | null
): Promise<Array<Record<string, unknown>>> {
  if (!itemKeys.length) return [];
  const keySet = new Set(itemKeys);
  if (entity === 'selling-prices') {
    return prisma.sellingPrice.findMany({
      where: {
        syncKey: { in: itemKeys },
        isActive: true,
        product: productWhere(policy),
        priceType: { isActive: true, guid: { in: await accessiblePriceTypeGuids(managerGuid, policy) } },
      },
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
    return prisma.managerStockReservation.findMany({
      where: {
        syncKey: { in: itemKeys },
        managerGuid,
        reserved: { gt: 0 },
        ...activeStockWhere(policy, true),
      },
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
  const parsed = itemKeys.map((key) => key.split('|'));
  const productGuids = [...new Set(parsed.map((parts) => parts[0]).filter(Boolean))];
  const warehouseGuids = [...new Set(parsed.map((parts) => parts[1]).filter(Boolean))];
  const balances = await prisma.stockBalance.findMany({
    where: {
      ...activeStockWhere(policy),
      AND: [{ product: { guid: { in: productGuids } } }, { warehouse: { guid: { in: warehouseGuids } } }],
    },
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
  const decorated = await decorateStockBalances(balances, policy);
  return decorated.filter((item) => keySet.has(itemKey('stock', item)));
}

function itemKey(entity: OfflineDatasetEntity, item: Record<string, unknown>) {
  if (entity === 'selling-prices') return String(item.syncKey ?? '');
  if (entity === 'manager-stock') return String(item.syncKey ?? '');
  if (entity === 'stock') {
    if (item.syncKey) return String(item.syncKey);
    const product = item.product as { guid?: string } | undefined;
    const warehouse = item.warehouse as { guid?: string } | undefined;
    const organization = item.organization as { guid?: string } | undefined;
    return `${product?.guid ?? ''}|${warehouse?.guid ?? ''}|${organization?.guid ?? ''}|${item.seriesGuid ?? ''}`;
  }
  return String(item.guid ?? '');
}

async function ensureState(entity: OfflineDatasetEntity, itemCount: number) {
  return prisma.offlineDatasetState.upsert({
    where: { scopeKey_entity: { scopeKey: OFFLINE_DATASET_SCOPE, entity } },
    create: {
      scopeKey: OFFLINE_DATASET_SCOPE,
      entity,
      schemaVersion: OFFLINE_DATASET_SCHEMA_VERSION,
      currentRevision: 0n,
      minAvailableRevision: 0n,
      itemCount,
    },
    update: {
      schemaVersion: OFFLINE_DATASET_SCHEMA_VERSION,
      itemCount,
    },
  });
}

export async function getOfflineManifest(userId: number) {
  assertOfflineEnabled();
  const policy = await getOfflineExportPolicy();
  const managerGuid = await managerGuidForUser(userId);
  const entries = await Promise.all(OFFLINE_DATASET_ENTITIES.map(async (entity) => {
    const itemCount = await countItemsForEntity(entity, managerGuid, policy);
    const state = await ensureState(entity, itemCount);
    return {
      entity,
      epoch: scopedEpoch(state.epoch, policy, managerGuid),
      schemaVersion: state.schemaVersion,
      revision: state.currentRevision.toString(),
      minAvailableRevision: state.minAvailableRevision.toString(),
      itemCount,
      lastSourceUpdateAt: state.lastSourceUpdateAt,
      lastFullReconcileAt: state.lastFullReconcileAt,
    };
  }));
  return {
    enabled: true,
    schemaVersion: OFFLINE_DATASET_SCHEMA_VERSION,
    managerScope: 'authenticated-user',
    generatedAt: new Date(),
    entities: entries,
  };
}

export async function getOfflineSnapshot(
  userId: number,
  entity: OfflineDatasetEntity,
  options: { cursor?: string | null; limit: number }
) {
  assertOfflineEnabled();
  const policy = await getOfflineExportPolicy();
  const managerGuid = await managerGuidForUser(userId);
  if (entity === 'selling-prices' || entity === 'stock' || entity === 'manager-stock') {
    const itemCount = await countItemsForEntity(entity, managerGuid, policy);
    const page = await getLargeEntityPage(entity, managerGuid, options.cursor, options.limit + 1, policy);
    const hasMore = page.length > options.limit;
    const items = hasMore ? page.slice(0, options.limit) : page;
    const state = await ensureState(entity, itemCount);
    return jsonSafe({
      entity,
      epoch: scopedEpoch(state.epoch, policy, managerGuid),
      schemaVersion: state.schemaVersion,
      snapshotRevision: state.currentRevision.toString(),
      items,
      nextCursor: hasMore && items.length > 0 ? String(items[items.length - 1].syncKey ?? '') : null,
      hasMore,
      lastSourceUpdateAt: state.lastSourceUpdateAt,
    });
  }
  const all = (await itemsForEntity(entity, managerGuid, policy)).map((item) => ({ key: itemKey(entity, item), item }));
  const start = options.cursor ? Math.max(0, all.findIndex((entry) => entry.key === options.cursor) + 1) : 0;
  const items = all.slice(start, start + options.limit);
  const state = await ensureState(entity, all.length);
  return jsonSafe({
    entity,
    epoch: scopedEpoch(state.epoch, policy, managerGuid),
    schemaVersion: state.schemaVersion,
    snapshotRevision: state.currentRevision.toString(),
    items: items.map((entry) => entry.item),
    nextCursor: start + items.length < all.length && items.length > 0 ? items[items.length - 1].key : null,
    hasMore: start + items.length < all.length,
    lastSourceUpdateAt: state.lastSourceUpdateAt,
  });
}

export async function getOfflineChanges(
  userId: number,
  entity: OfflineDatasetEntity,
  options: { afterRevision: bigint; limit: number; epoch: string }
) {
  assertOfflineEnabled();
  const policy = await getOfflineExportPolicy();
  const managerGuid = await managerGuidForUser(userId);
  const itemCount = await countItemsForEntity(entity, managerGuid, policy);
  const state = await ensureState(entity, itemCount);
  if (scopedEpoch(state.epoch, policy, managerGuid) !== options.epoch || options.afterRevision < state.minAvailableRevision) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Требуется полная синхронизация офлайн-данных');
  }
  const rows = await prisma.offlineDatasetChange.findMany({
    where: {
      scopeKey: OFFLINE_DATASET_SCOPE,
      entity,
      revision: { gt: options.afterRevision },
    },
    orderBy: { revision: 'asc' },
    take: options.limit,
  });
  const currentItems = entity === 'selling-prices' || entity === 'stock' || entity === 'manager-stock'
    ? await getLargeItemsByKeys(entity, managerGuid, rows.map((row) => row.itemKey), policy)
    : await itemsForEntity(entity, managerGuid, policy);
  const byKey = new Map(currentItems.map((item) => [itemKey(entity, item), item]));
  const lastRevision = rows.length > 0 ? rows[rows.length - 1].revision : options.afterRevision;
  return jsonSafe({
    entity,
    epoch: scopedEpoch(state.epoch, policy, managerGuid),
    schemaVersion: state.schemaVersion,
    fromRevision: options.afterRevision.toString(),
    nextRevision: lastRevision.toString(),
    currentRevision: state.currentRevision.toString(),
    changes: rows.map((row) => {
      const item = byKey.get(row.itemKey) ?? null;
      return {
        revision: row.revision.toString(),
        itemKey: row.itemKey,
        operation: item ? 'UPSERT' : 'DELETE',
        item,
      };
    }),
    hasMore: lastRevision < state.currentRevision,
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
