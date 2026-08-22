import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import type { CatalogChangesQuery, CatalogSnapshotQuery } from './catalog.schemas';

const STATE_ID = 'nomenclature';
const SCHEMA_VERSION = 1;
const CHANGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHANGE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastChangePruneAt = 0;

export class CatalogError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function getState() {
  return prisma.catalogState.upsert({
    where: { id: STATE_ID },
    create: {
      id: STATE_ID,
      epoch: randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      currentRevision: 0,
      minAvailableRevision: 0,
    },
    update: {},
  });
}

async function pruneCatalogChangesIfNeeded() {
  const now = Date.now();
  if (now - lastChangePruneAt < CHANGE_PRUNE_INTERVAL_MS) return;
  lastChangePruneAt = now;
  await prisma.catalogChange.deleteMany({
    where: { changedAt: { lt: new Date(now - CHANGE_RETENTION_MS) } },
  });
}

const productInclude = {
  group: { select: { guid: true, name: true } },
  baseUnit: { select: { guid: true, name: true, code: true, symbol: true } },
  packages: {
    orderBy: [{ sortOrder: Prisma.SortOrder.asc }, { name: Prisma.SortOrder.asc }],
    select: {
      guid: true,
      name: true,
      multiplier: true,
      barcode: true,
      isDefault: true,
      sortOrder: true,
      unit: { select: { guid: true, name: true, code: true, symbol: true } },
    },
  },
} satisfies Prisma.ProductInclude;

type CatalogProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

async function loadProducts(where: Prisma.ProductWhereInput, take: number) {
  return prisma.product.findMany({
    where,
    take,
    orderBy: { guid: 'asc' },
    include: productInclude,
  });
}

function toNumber(value: { toString(): string } | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeProduct(row: CatalogProductRow, imageHash?: string | null) {
  return {
    guid: row.guid,
    name: row.name,
    code: row.code,
    article: row.article,
    sku: row.sku,
    isWeight: row.isWeight,
    isService: row.isService,
    isActive: row.isActive,
    group: row.group ? { guid: row.group.guid, name: row.group.name } : null,
    baseUnit: row.baseUnit,
    packages: row.packages.map((pack) => ({
      guid: pack.guid,
      name: pack.name,
      multiplier: toNumber(pack.multiplier) ?? 1,
      barcode: pack.barcode,
      isDefault: pack.isDefault,
      sortOrder: pack.sortOrder,
      unit: pack.unit,
    })),
    imageHash: imageHash ?? null,
    revision: row.catalogRevision.toString(),
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
  };
}

async function imageHashesByProduct(productGuids: string[]) {
  if (!productGuids.length) return new Map<string, string>();
  const images = await prisma.productImage.findMany({
    where: { productGuid: { in: productGuids }, isMain: true, deletedAt: null },
    select: { productGuid: true, hashSha256: true },
    orderBy: { syncedAt: 'desc' },
  });
  const map = new Map<string, string>();
  for (const image of images) {
    if (!map.has(image.productGuid)) map.set(image.productGuid, image.hashSha256);
  }
  return map;
}

export async function getCatalogManifest() {
  await pruneCatalogChangesIfNeeded();
  const [state, productCount, firstChange] = await Promise.all([
    getState(),
    prisma.product.count({ where: { isActive: true } }),
    prisma.catalogChange.findFirst({ orderBy: { revision: 'asc' }, select: { revision: true } }),
  ]);
  const minAvailableRevision = firstChange?.revision ?? state.currentRevision;
  if (minAvailableRevision !== state.minAvailableRevision) {
    await prisma.catalogState.update({
      where: { id: STATE_ID },
      data: { minAvailableRevision },
    });
  }
  return {
    epoch: state.epoch,
    schemaVersion: state.schemaVersion,
    revision: state.currentRevision.toString(),
    minAvailableRevision: minAvailableRevision.toString(),
    productCount,
    lastSourceUpdateAt: state.lastSourceUpdateAt?.toISOString() ?? null,
    lastFullReconcileAt: state.lastFullReconcileAt?.toISOString() ?? null,
    generatedAt: new Date().toISOString(),
  };
}

function validateEpoch(actual: string, requested?: string) {
  if (requested && requested !== actual) {
    throw new CatalogError(409, 'Версия локального каталога устарела. Требуется полная синхронизация.');
  }
}

export async function getCatalogSnapshot(query: CatalogSnapshotQuery) {
  const state = await getState();
  validateEpoch(state.epoch, query.epoch);
  const snapshotRevision = query.snapshotRevision === undefined
    ? state.currentRevision
    : BigInt(query.snapshotRevision);
  if (snapshotRevision > state.currentRevision) {
    throw new CatalogError(409, 'Запрошенная ревизия каталога ещё не существует.');
  }

  const rows = await loadProducts(
    {
      isActive: true,
      ...(query.cursor ? { guid: { gt: query.cursor } } : {}),
    },
    query.limit + 1
  );
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const hashes = await imageHashesByProduct(page.map((item) => item.guid));

  return {
    epoch: state.epoch,
    schemaVersion: state.schemaVersion,
    snapshotRevision: snapshotRevision.toString(),
    items: page.map((row) => serializeProduct(row, hashes.get(row.guid))),
    nextCursor: hasMore ? page[page.length - 1]?.guid ?? null : null,
    hasMore,
  };
}

export async function getCatalogChanges(query: CatalogChangesQuery) {
  const state = await getState();
  validateEpoch(state.epoch, query.epoch);
  const afterRevision = BigInt(query.afterRevision);
  if (afterRevision < state.minAvailableRevision && afterRevision !== state.currentRevision) {
    throw new CatalogError(409, 'История изменений каталога устарела. Требуется полная синхронизация.');
  }

  const raw = await prisma.catalogChange.findMany({
    where: { revision: { gt: afterRevision } },
    orderBy: { revision: 'asc' },
    take: query.limit + 1,
  });
  const hasMore = raw.length > query.limit;
  const page = hasMore ? raw.slice(0, query.limit) : raw;
  const latestByGuid = new Map<string, (typeof page)[number]>();
  for (const change of page) latestByGuid.set(change.productGuid, change);
  const productGuids = [...latestByGuid.keys()];
  const products = productGuids.length
    ? await prisma.product.findMany({ where: { guid: { in: productGuids } }, include: productInclude })
    : [];
  const byGuid = new Map(products.map((product) => [product.guid, product]));
  const hashes = await imageHashesByProduct(productGuids);
  const changes = [...latestByGuid.values()]
    .sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0))
    .map((change) => {
      const product = byGuid.get(change.productGuid);
      const deleted = !product || product.isActive === false;
      return {
        revision: change.revision.toString(),
        productGuid: change.productGuid,
        operation: deleted ? 'DELETE' as const : 'UPSERT' as const,
        item: deleted || !product ? null : serializeProduct(product, hashes.get(product.guid)),
      };
    });
  const nextRevision = page.length ? page[page.length - 1].revision : afterRevision;

  return {
    epoch: state.epoch,
    schemaVersion: state.schemaVersion,
    fromRevision: afterRevision.toString(),
    nextRevision: nextRevision.toString(),
    currentRevision: state.currentRevision.toString(),
    changes,
    hasMore,
  };
}
