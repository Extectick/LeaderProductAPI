import { ProductImageSyncState, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import prisma from '../../prisma/client';
import { buildStoragePrefix, deleteObject, resolveObjectUrl, uploadBuffer } from '../../storage/minio';
import {
  getOnecLpAppNomenclatureImageContent,
  getOnecLpAppNomenclatureImages,
  OnecLpAppConfigError,
  OnecLpAppHttpError,
  OnecLpAppNetworkError,
  type OnecLpAppQuery,
} from '../onec/onec.lpApp.client';

type ProductLike = {
  guid: string;
  [key: string]: unknown;
};

export type ProductImageDto = {
  id: string;
  fileGuid: string;
  thumbUrl: string;
  previewUrl: string;
  isMain: boolean;
  hash: string;
};

type OnecProductImageMetadata = {
  productGuid: string;
  fileGuid: string;
  fileName: string | null;
  contentType: string | null;
  extension: string | null;
  size: number | null;
  modifiedAt: Date | null;
  isMain: boolean;
  deletionMark: boolean;
};

type SyncStats = {
  requested: number;
  uploaded: number;
  skipped: number;
  deleted: number;
  failed: number;
  errors: string[];
};

const PRODUCT_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PRODUCT_IMAGE_PREFIX = `${buildStoragePrefix('images')}/client-orders/products`;
const DEFAULT_SYNC_LIMIT = 50;
const MAX_SYNC_LIMIT = 200;
const DEFAULT_ERROR_RETRY_MS = 24 * 60 * 60 * 1000;
const pendingProductSyncs = new Set<string>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function read(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function text(record: Record<string, unknown> | null | undefined, keys: string[], fallback: string | null = null) {
  const value = read(record, keys);
  if (value === undefined || value === null) return fallback;
  const prepared = String(value).trim();
  return prepared || fallback;
}

function bool(record: Record<string, unknown> | null | undefined, keys: string[], fallback = false) {
  const value = read(record, keys);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'да', 'истина'].includes(normalized)) return true;
    if (['false', '0', 'no', 'нет', 'ложь'].includes(normalized)) return false;
  }
  return fallback;
}

function numberValue(record: Record<string, unknown> | null | undefined, keys: string[], fallback: number | null = null) {
  const value = read(record, keys);
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(num) ? num : fallback;
}

function dateValue(record: Record<string, unknown> | null | undefined, keys: string[]) {
  const value = read(record, keys);
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function readItems(payload: unknown): { items: unknown[]; hasMore: boolean } {
  const record = asRecord(payload);
  const rawItems = read(record, ['items', 'images', 'productImages', 'nomenclatureImages']);
  const items = Array.isArray(rawItems) ? rawItems : [];
  return {
    items,
    hasMore: bool(record, ['hasMore'], false),
  };
}

function mapOnecImageMetadata(value: unknown): OnecProductImageMetadata | null {
  const record = asRecord(value);
  if (!record) return null;

  const productGuid = text(record, ['productGuid', 'nomenclatureGuid', 'ownerGuid']);
  const fileGuid = text(record, ['fileGuid', 'guid', 'id']);
  if (!productGuid || !fileGuid) return null;

  const fileName = text(record, ['fileName', 'name', 'Наименование']);
  const contentType = text(record, ['contentType', 'mimeType']);
  const extension = text(record, ['extension', 'ext']);
  const deletionMark = bool(record, ['deletionMark', 'isDeleted', 'deleted'], false);

  return {
    productGuid,
    fileGuid,
    fileName,
    contentType,
    extension,
    size: numberValue(record, ['size', 'fileSize'], null),
    modifiedAt: dateValue(record, ['modifiedAt', 'sourceUpdatedAt', 'updatedAt']),
    isMain: bool(record, ['isMain', 'main'], false),
    deletionMark,
  };
}

function isMissingTableError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2021' || error.code === 'P2022')
  );
}

function objectKey(meta: OnecProductImageMetadata, hash: string, variant: 'thumb' | 'preview' | 'original', ext = 'webp') {
  const cleanExt = ext.replace(/^\.+/, '').toLowerCase() || 'bin';
  return `${PRODUCT_IMAGE_PREFIX}/${meta.productGuid}/${meta.fileGuid}/${hash}/${variant}.${cleanExt}`;
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function getErrorRetryMs() {
  const value = Number(process.env.PRODUCT_IMAGE_ERROR_RETRY_MS);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : DEFAULT_ERROR_RETRY_MS;
}

function sameDate(left: Date | null | undefined, right: Date | null | undefined) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return Math.abs(left.getTime() - right.getTime()) < 1000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3, baseDelayMs = 250): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function contentExtension(contentType?: string | null, fileName?: string | null) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  const ext = path.extname(fileName || '').replace(/^\./, '').toLowerCase();
  return ext || 'bin';
}

async function buildDerivative(buffer: Buffer, maxSize: number, quality: number) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: maxSize,
      height: maxSize,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
}

async function markImageError(meta: OnecProductImageMetadata, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await prisma.productImage.upsert({
      where: {
        fileGuid_hashSha256: {
          fileGuid: meta.fileGuid,
          hashSha256: `error:${meta.fileGuid}`,
        },
      },
      create: {
        productGuid: meta.productGuid,
        fileGuid: meta.fileGuid,
        fileName: meta.fileName,
        contentType: meta.contentType,
        size: meta.size,
        hashSha256: `error:${meta.fileGuid}`,
        s3KeyThumb: '',
        s3KeyPreview: '',
        modifiedAt1c: meta.modifiedAt,
        syncState: ProductImageSyncState.ERROR,
        lastError: message,
      },
      update: {
        productGuid: meta.productGuid,
        fileName: meta.fileName,
        contentType: meta.contentType,
        size: meta.size,
        modifiedAt1c: meta.modifiedAt,
        syncState: ProductImageSyncState.ERROR,
        lastError: message,
        syncedAt: new Date(),
      },
    });
  } catch {
    // Do not let image sync errors break product endpoints.
  }
}

async function shouldSkipRecentImageError(meta: OnecProductImageMetadata) {
  const retryMs = getErrorRetryMs();
  if (retryMs === 0) return false;

  const existingError = await prisma.productImage.findUnique({
    where: {
      fileGuid_hashSha256: {
        fileGuid: meta.fileGuid,
        hashSha256: `error:${meta.fileGuid}`,
      },
    },
    select: {
      syncState: true,
      modifiedAt1c: true,
      syncedAt: true,
      deletedAt: true,
    },
  });

  if (!existingError || existingError.deletedAt || existingError.syncState !== ProductImageSyncState.ERROR) {
    return false;
  }

  if (!sameDate(existingError.modifiedAt1c, meta.modifiedAt)) {
    return false;
  }

  return Date.now() - existingError.syncedAt.getTime() < retryMs;
}

async function syncImage(meta: OnecProductImageMetadata): Promise<'uploaded' | 'skipped' | 'deleted'> {
  if (meta.deletionMark) {
    await prisma.productImage.updateMany({
      where: { productGuid: meta.productGuid, fileGuid: meta.fileGuid, deletedAt: null },
      data: { deletedAt: new Date(), syncState: ProductImageSyncState.DELETED },
    });
    return 'deleted';
  }

  if (await shouldSkipRecentImageError(meta)) {
    return 'skipped';
  }

  const binary = await withRetry(() => getOnecLpAppNomenclatureImageContent(meta.fileGuid));
  const buffer = binary.body;
  const hash = sha256(buffer);
  const existing = await prisma.productImage.findUnique({
    where: { fileGuid_hashSha256: { fileGuid: meta.fileGuid, hashSha256: hash } },
  });

  if (existing?.syncState === ProductImageSyncState.SYNCED && !existing.deletedAt) {
    return 'skipped';
  }

  const [thumb, preview] = await Promise.all([
    buildDerivative(buffer, 240, 80),
    buildDerivative(buffer, 1000, 86),
  ]);
  const thumbKey = objectKey(meta, hash, 'thumb', 'webp');
  const previewKey = objectKey(meta, hash, 'preview', 'webp');
  const shouldStoreOriginal = process.env.PRODUCT_IMAGES_STORE_ORIGINAL === '1';
  const originalExt = contentExtension(binary.contentType || meta.contentType, meta.fileName);
  const originalKey = shouldStoreOriginal ? objectKey(meta, hash, 'original', originalExt) : null;

  await Promise.all([
    withRetry(() => uploadBuffer(thumbKey, thumb.data, 'image/webp', false, meta.fileName || undefined, {
      cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
    })),
    withRetry(() => uploadBuffer(previewKey, preview.data, 'image/webp', false, meta.fileName || undefined, {
      cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
    })),
    originalKey
      ? withRetry(() => uploadBuffer(originalKey, buffer, binary.contentType || meta.contentType || 'application/octet-stream', false, meta.fileName || undefined, {
          cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
        }))
      : Promise.resolve(null),
  ]);

  await prisma.$transaction([
    prisma.productImage.updateMany({
      where: {
        fileGuid: meta.fileGuid,
        hashSha256: { not: hash },
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        syncState: ProductImageSyncState.DELETED,
      },
    }),
    prisma.productImage.upsert({
      where: { fileGuid_hashSha256: { fileGuid: meta.fileGuid, hashSha256: hash } },
      create: {
        productGuid: meta.productGuid,
        fileGuid: meta.fileGuid,
        isMain: meta.isMain,
        fileName: meta.fileName,
        contentType: binary.contentType || meta.contentType,
        size: meta.size ?? binary.contentLength ?? buffer.length,
        width: preview.info.width ?? null,
        height: preview.info.height ?? null,
        hashSha256: hash,
        s3KeyThumb: thumbKey,
        s3KeyPreview: previewKey,
        s3KeyOriginal: originalKey,
        modifiedAt1c: meta.modifiedAt,
        syncState: ProductImageSyncState.SYNCED,
        lastError: null,
        syncedAt: new Date(),
      },
      update: {
        productGuid: meta.productGuid,
        isMain: meta.isMain,
        fileName: meta.fileName,
        contentType: binary.contentType || meta.contentType,
        size: meta.size ?? binary.contentLength ?? buffer.length,
        width: preview.info.width ?? null,
        height: preview.info.height ?? null,
        s3KeyThumb: thumbKey,
        s3KeyPreview: previewKey,
        s3KeyOriginal: originalKey,
        modifiedAt1c: meta.modifiedAt,
        deletedAt: null,
        syncState: ProductImageSyncState.SYNCED,
        lastError: null,
        syncedAt: new Date(),
      },
    }),
  ]);

  return 'uploaded';
}

function onecImageErrorMessage(error: unknown) {
  if (error instanceof OnecLpAppConfigError) return `1C image sync config error: ${error.message}`;
  if (error instanceof OnecLpAppNetworkError) return `1C image sync network error: ${error.message}`;
  if (error instanceof OnecLpAppHttpError) return `1C image sync HTTP ${error.upstreamStatus}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export async function syncProductImages(params: {
  productGuid?: string;
  changedSince?: string | Date | null;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
} = {}): Promise<SyncStats> {
  const limit = Math.min(Math.max(Number(params.limit || DEFAULT_SYNC_LIMIT), 1), MAX_SYNC_LIMIT);
  let offset = Math.max(Number(params.offset || 0), 0);
  const stats: SyncStats = { requested: 0, uploaded: 0, skipped: 0, deleted: 0, failed: 0, errors: [] };

  do {
    const query: OnecLpAppQuery = {
      productGuid: params.productGuid,
      changedSince: params.changedSince instanceof Date ? params.changedSince.toISOString() : params.changedSince || undefined,
      includeDeleted: params.includeDeleted ?? true,
      limit,
      offset,
    };
    const payload = await getOnecLpAppNomenclatureImages(query);
    const page = readItems(payload);
    const items = page.items.flatMap((item) => {
      const meta = mapOnecImageMetadata(item);
      return meta ? [meta] : [];
    });

    stats.requested += items.length;
    for (const meta of items) {
      try {
        const result = await syncImage(meta);
        if (result === 'uploaded') stats.uploaded += 1;
        else if (result === 'deleted') stats.deleted += 1;
        else stats.skipped += 1;
      } catch (error) {
        stats.failed += 1;
        stats.errors.push(`${meta.productGuid}/${meta.fileGuid}: ${onecImageErrorMessage(error)}`);
        await markImageError(meta, error);
      }
    }

    if (!page.hasMore || params.productGuid) break;
    offset += limit;
  } while (true);

  return stats;
}

export function enqueueProductImageSync(productGuid: string) {
  if (!productGuid || pendingProductSyncs.has(productGuid)) return;
  pendingProductSyncs.add(productGuid);
  setTimeout(() => {
    syncProductImages({ productGuid, limit: 20, includeDeleted: true })
      .catch((error) => {
        console.warn('[client-orders:product-images] lazy sync failed', {
          productGuid,
          error: onecImageErrorMessage(error),
        });
      })
      .finally(() => {
        pendingProductSyncs.delete(productGuid);
      });
  }, 0);
}

export async function getProductImagesMap(productGuids: string[]) {
  const unique = [...new Set(productGuids.filter(Boolean))];
  if (!unique.length) return new Map<string, ProductImageDto[]>();

  try {
    const rows = await prisma.productImage.findMany({
      where: {
        productGuid: { in: unique },
        deletedAt: null,
        syncState: ProductImageSyncState.SYNCED,
        s3KeyThumb: { not: '' },
        s3KeyPreview: { not: '' },
      },
      orderBy: [{ isMain: 'desc' }, { syncedAt: 'desc' }],
    });

    const result = new Map<string, ProductImageDto[]>();
    for (const row of rows) {
      const [thumbUrl, previewUrl] = await Promise.all([
        resolveObjectUrl(row.s3KeyThumb),
        resolveObjectUrl(row.s3KeyPreview),
      ]);
      if (!thumbUrl || !previewUrl) continue;
      const list = result.get(row.productGuid) ?? [];
      list.push({
        id: row.id,
        fileGuid: row.fileGuid,
        thumbUrl,
        previewUrl,
        isMain: row.isMain,
        hash: row.hashSha256,
      });
      result.set(row.productGuid, list);
    }

    return result;
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn('[client-orders:product-images] image lookup failed', error);
    }
    return new Map<string, ProductImageDto[]>();
  }
}

export async function enrichProductsWithImages<T extends ProductLike>(products: T[], options: { lazySyncMissing?: boolean } = {}) {
  if (!products.length) return products;
  const imageMap = await getProductImagesMap(products.map((item) => item.guid));

  return products.map((product) => {
    const images = imageMap.get(product.guid) ?? [];
    const main = images.find((item) => item.isMain) ?? images[0] ?? null;
    if (!main && options.lazySyncMissing !== false) {
      enqueueProductImageSync(product.guid);
    }

    return {
      ...product,
      images,
      imageThumbUrl: main?.thumbUrl ?? null,
      imagePreviewUrl: main?.previewUrl ?? null,
      imageHash: main?.hash ?? null,
    };
  });
}

export async function enrichOrderItemsWithImages<T extends { items?: Array<{ product?: ProductLike | null }> }>(order: T): Promise<T> {
  const items = Array.isArray(order.items) ? order.items : [];
  const products = items.flatMap((item) => (item.product?.guid ? [item.product as ProductLike] : []));
  if (!products.length) return order;
  const imageMap = await getProductImagesMap(products.map((item) => item.guid));

  return {
    ...order,
    items: items.map((item) => {
      if (!item.product?.guid) return item;
      const images = imageMap.get(item.product.guid) ?? [];
      const main = images.find((image) => image.isMain) ?? images[0] ?? null;
      if (!main) enqueueProductImageSync(item.product.guid);
      return {
        ...item,
        product: {
          ...item.product,
          images,
          imageThumbUrl: main?.thumbUrl ?? null,
          imagePreviewUrl: main?.previewUrl ?? null,
          imageHash: main?.hash ?? null,
        },
      };
    }),
  };
}

export async function getProductImagesStatus() {
  try {
    const [total, synced, pending, failed, deleted, lastSynced] = await Promise.all([
      prisma.productImage.count(),
      prisma.productImage.count({ where: { syncState: ProductImageSyncState.SYNCED, deletedAt: null } }),
      prisma.productImage.count({ where: { syncState: ProductImageSyncState.PENDING } }),
      prisma.productImage.count({ where: { syncState: ProductImageSyncState.ERROR } }),
      prisma.productImage.count({ where: { OR: [{ syncState: ProductImageSyncState.DELETED }, { deletedAt: { not: null } }] } }),
      prisma.productImage.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true, lastError: true } }),
    ]);

    return {
      total,
      synced,
      pending,
      failed,
      deleted,
      lastSyncedAt: lastSynced?.syncedAt ?? null,
      lastError: lastSynced?.lastError ?? null,
      pendingLazySyncs: pendingProductSyncs.size,
    };
  } catch (error) {
    if (isMissingTableError(error)) {
      return {
        total: 0,
        synced: 0,
        pending: 0,
        failed: 0,
        deleted: 0,
        lastSyncedAt: null,
        lastError: 'ProductImage table is not migrated yet',
        pendingLazySyncs: pendingProductSyncs.size,
      };
    }
    throw error;
  }
}

export async function cleanupProductImages(retentionDays = 14) {
  const cutoff = new Date(Date.now() - Math.max(retentionDays, 1) * 24 * 60 * 60 * 1000);
  const rows = await prisma.productImage.findMany({
    where: { deletedAt: { lt: cutoff } },
    take: 100,
  });
  let deleted = 0;
  let failed = 0;

  for (const row of rows) {
    const keys = [row.s3KeyThumb, row.s3KeyPreview, row.s3KeyOriginal].filter(Boolean) as string[];
    try {
      await Promise.all(keys.map((key) => deleteObject(key).catch(() => null)));
      await prisma.productImage.delete({ where: { id: row.id } });
      deleted += 1;
    } catch {
      failed += 1;
    }
  }

  return { scanned: rows.length, deleted, failed };
}
