import {
  OrderEventSource,
  OrderSource,
  OrderStatus,
  OrderSyncState,
  Prisma,
  SyncDirection,
  SyncEntityType,
  SyncItemStatus,
  SyncStatus,
} from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';
import prisma from '../../prisma/client';
import { cacheDelPrefix } from '../../utils/cache';
import { appendOrderEvent } from '../orders/orderEvents';
import {
  agreementsBatchSchema,
  counterpartiesBatchSchema,
  nomenclatureBatchSchema,
  organizationsBatchSchema,
  orderAckSchema,
  ordersSnapshotBatchSchema,
  ordersStatusBatchSchema,
  productPricesBatchSchema,
  sessionCompleteSchema,
  sessionStartSchema,
  specialPricesBatchSchema,
  stockBatchSchema,
  warehousesBatchSchema,
} from './onec.schemas';
import { onecSchemaResponse } from './onec.schema.response';
import {
  completeOnecSyncSession,
  resolveBatchSession,
  stageAgreementsBatch,
  stageCounterpartiesBatch,
  stageNomenclatureBatch,
  stageOrganizationsBatch,
  stageProductPricesBatch,
  stageSpecialPricesBatch,
  stageStockBatch,
  stageWarehousesBatch,
  startOnecSyncSession,
} from './onec.sync';

type BatchResult = { key: string; status: 'ok' | 'error'; error?: string };
type ClearEntityCode =
  | 'nomenclature'
  | 'organizations'
  | 'warehouses'
  | 'counterparties'
  | 'agreements'
  | 'product-prices'
  | 'special-prices'
  | 'stock';

const STOCK_BALANCES_CACHE_PREFIX = 'stock-balances:';

const toDecimal = (value?: number | null) =>
  value === undefined || value === null ? undefined : new Prisma.Decimal(value);

const decimalToNumber = (value: Prisma.Decimal | number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
};

const now = () => new Date();
const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};
const toBatchKeyPart = (value: string | Date | null | undefined): string => {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return value.toISOString();
  return value;
};
const buildBatchKey = (parts: Array<[string, string | Date | null | undefined]>): string =>
  parts.map(([label, value]) => `${label}=${toBatchKeyPart(value)}`).join('|');

const mapItemStatus = (status: BatchResult['status']): SyncItemStatus =>
  status === 'ok' ? SyncItemStatus.OK : SyncItemStatus.ERROR;

const calcRunStatus = (successCount: number, errorCount: number): SyncStatus => {
  if (errorCount === 0) return SyncStatus.COMPLETED;
  if (successCount === 0) return SyncStatus.FAILED;
  return SyncStatus.PARTIAL;
};

async function startSyncRun(entity: SyncEntityType, direction: SyncDirection, meta?: Prisma.JsonObject) {
  const requestId = randomUUID();
  return prisma.syncRun.create({
    data: {
      requestId,
      entity,
      direction,
      status: SyncStatus.STARTED,
      meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
    },
    select: { id: true, requestId: true },
  });
}

async function completeSyncRun(
  runId: string,
  results: BatchResult[],
  meta?: Prisma.JsonObject,
  notes?: string
) {
  const successCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.length - successCount;
  const status = calcRunStatus(successCount, errorCount);

  if (results.length > 0) {
    await prisma.syncRunItem.createMany({
      data: results.map((r) => ({
        runId,
        key: r.key,
        status: mapItemStatus(r.status),
        error: r.error,
      })),
    });
  }

  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      totalCount: results.length,
      successCount,
      errorCount,
      status,
      notes,
      meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
      finishedAt: now(),
    },
  });
}

async function failSyncRun(runId: string, error: unknown, meta?: Prisma.JsonObject) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      status: SyncStatus.FAILED,
      notes: message,
      meta: meta
        ? ({ ...meta, error: message } as Prisma.InputJsonValue)
        : ({ error: message } as Prisma.InputJsonValue),
      finishedAt: now(),
    },
  });
}

async function safeCompleteSyncRun(
  runId: string | undefined,
  results: BatchResult[],
  meta?: Prisma.JsonObject,
  notes?: string
) {
  if (!runId) return;
  try {
    await completeSyncRun(runId, results, meta, notes);
  } catch (e) {
    console.error('Failed to complete sync run', e);
  }
}

async function safeFailSyncRun(runId: string | undefined, error: unknown, meta?: Prisma.JsonObject) {
  if (!runId) return;
  try {
    await failSyncRun(runId, error, meta);
  } catch (e) {
    console.error('Failed to fail sync run', e);
  }
}

const handleValidationError = (error: ZodError<unknown>, res: Response) => {
  const validationError = fromZodError(error as any);
  return res.status(400).json({
    error: 'Validation error',
    details: (validationError as any).details ?? validationError.message,
  });
};

async function completeImplicitSessionIfNeeded(
  implicit: boolean,
  sessionId: string | undefined,
  results: BatchResult[]
) {
  if (!implicit || !sessionId) {
    return undefined;
  }

  try {
    const outcome = await completeOnecSyncSession({
      secret: process.env.ONEC_SECRET ?? '',
      sessionId,
    });
    return outcome;
  } catch (error) {
    console.error(`Failed to auto-complete implicit sync session ${sessionId}`, error);
    const message = error instanceof Error ? error.message : 'Failed to complete sync session';
    results.push({ key: sessionId, status: 'error', error: message });
    return undefined;
  }
}

export const onecAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const rawSecret = (req.body?.secret ?? req.query?.secret) as unknown;
  const secret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
  if (!secret || secret !== process.env.ONEC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
};

const normalizeCounterpartyString = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const digitsOnly = (value: string | null | undefined): string | undefined => {
  const prepared = normalizeCounterpartyString(value);
  if (!prepared) return undefined;
  const digits = prepared.replace(/\D+/g, '');
  return digits.length > 0 ? digits : undefined;
};

const normalizeInn = (value: string | null | undefined): string | undefined => {
  const digits = digitsOnly(value);
  if (!digits) return undefined;
  return digits.length === 10 || digits.length === 12 ? digits : undefined;
};

const normalizeKpp = (value: string | null | undefined): string | undefined => {
  const digits = digitsOnly(value);
  if (!digits) return undefined;
  return digits.length === 9 ? digits : undefined;
};

const normalizePhone = (value: string | null | undefined): string | undefined => {
  const prepared = normalizeCounterpartyString(value);
  if (!prepared) return undefined;
  const digits = prepared.replace(/\D+/g, '');
  if (digits.length < 6) return undefined;
  return prepared.startsWith('+') ? `+${digits}` : digits;
};

const clearOnecEntity = async (entity: ClearEntityCode) => {
  await prisma.$transaction(async (tx) => {
    switch (entity) {
      case 'stock':
        await tx.stockBalance.deleteMany({});
        return;
      case 'organizations':
        await tx.stockBalance.deleteMany({});
        await tx.organization.deleteMany({});
        return;
      case 'special-prices':
        await tx.specialPrice.deleteMany({});
        return;
      case 'product-prices':
        await tx.productPrice.deleteMany({});
        return;
      case 'agreements':
        await tx.specialPrice.deleteMany({ where: { agreementId: { not: null } } });
        await tx.clientAgreement.deleteMany({});
        await tx.clientContract.deleteMany({});
        await tx.priceType.deleteMany({});
        return;
      case 'counterparties':
        await tx.specialPrice.deleteMany({ where: { counterpartyId: { not: null } } });
        await tx.clientAgreement.deleteMany({});
        await tx.clientContract.deleteMany({});
        await tx.deliveryAddress.deleteMany({});
        await tx.counterparty.deleteMany({});
        return;
      case 'warehouses':
        await tx.stockBalance.deleteMany({});
        await tx.clientAgreement.deleteMany({ where: { warehouseId: { not: null } } });
        await tx.warehouse.deleteMany({});
        return;
      case 'nomenclature':
        await tx.stockBalance.deleteMany({});
        await tx.specialPrice.deleteMany({});
        await tx.productPrice.deleteMany({});
        await tx.productPackage.deleteMany({});
        await tx.product.deleteMany({});
        await tx.productGroup.deleteMany({});
        return;
      default:
        throw new Error(`Unsupported clear entity: ${entity}`);
    }
  });
};

export const handleSchema = async (_req: Request, res: Response) => {
  return res.status(200).json(onecSchemaResponse);
};

export const handleSyncSessionStart = async (req: Request, res: Response) => {
  try {
    const parsed = sessionStartSchema.parse(req.body);
    const session = await startOnecSyncSession(parsed);
    return res.json({ success: true, session });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in sync session start', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleSyncSessionComplete = async (req: Request, res: Response) => {
  try {
    const parsed = sessionCompleteSchema.parse(req.body);
    const outcome = await completeOnecSyncSession(parsed);
    return res.json({ success: true, session: outcome });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(error, res);
    }
    console.error('Unexpected error in sync session complete', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleEntityClear = async (req: Request, res: Response) => {
  const entity = toSingleString(req.params.entity) as ClearEntityCode | undefined;
  if (
    entity !== 'nomenclature' &&
    entity !== 'organizations' &&
    entity !== 'warehouses' &&
    entity !== 'counterparties' &&
    entity !== 'agreements' &&
    entity !== 'product-prices' &&
    entity !== 'special-prices' &&
    entity !== 'stock'
  ) {
    return res.status(400).json({ error: 'Unsupported entity for clear' });
  }

  try {
    await clearOnecEntity(entity);
    if (entity === 'stock' || entity === 'nomenclature' || entity === 'warehouses' || entity === 'organizations') {
      await cacheDelPrefix(STOCK_BALANCES_CACHE_PREFIX);
    }
    return res.json({ success: true, entity });
  } catch (error) {
    console.error(`Unexpected error while clearing ${entity}`, error);
    const message = error instanceof Error ? error.message : 'Failed to clear entity';
    return res.status(500).json({ error: message });
  }
};

export const handleNomenclatureBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.NOMENCLATURE, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for nomenclature', e);
  }

  try {
    const parsed = nomenclatureBatchSchema.parse(req.body);
    const session = await resolveBatchSession('nomenclature', parsed.sessionId);
    const results = await stageNomenclatureBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in nomenclature batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleStockBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.STOCK, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for stock', e);
  }

  try {
    const parsed = stockBatchSchema.parse(req.body);
    const session = await resolveBatchSession('stock', parsed.sessionId);
    const results = await stageStockBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in stock batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleOrganizationsBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORGANIZATIONS, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for organizations', e);
  }

  try {
    const parsed = organizationsBatchSchema.parse(req.body);
    const session = await resolveBatchSession('organizations', parsed.sessionId);
    const results = await stageOrganizationsBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in organizations batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleCounterpartiesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.COUNTERPARTIES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for counterparties', e);
  }

  try {
    const parsed = counterpartiesBatchSchema.parse(req.body);
    const session = await resolveBatchSession('counterparties', parsed.sessionId);
    const results = await stageCounterpartiesBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in counterparties batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleWarehousesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.WAREHOUSES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for warehouses', e);
  }

  try {
    const parsed = warehousesBatchSchema.parse(req.body);
    const session = await resolveBatchSession('warehouses', parsed.sessionId);
    const results = await stageWarehousesBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in warehouses batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleAgreementsBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.AGREEMENTS, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for agreements', e);
  }

  try {
    const parsed = agreementsBatchSchema.parse(req.body);
    const session = await resolveBatchSession('agreements', parsed.sessionId);
    const results = await stageAgreementsBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in agreements batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleSpecialPricesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.SPECIAL_PRICES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for special prices', e);
  }

  try {
    const parsed = specialPricesBatchSchema.parse(req.body);
    const session = await resolveBatchSession('special-prices', parsed.sessionId);
    const results = await stageSpecialPricesBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in special prices batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleProductPricesBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.PRODUCT_PRICES, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for product prices', e);
  }

  try {
    const parsed = productPricesBatchSchema.parse(req.body);
    const session = await resolveBatchSession('product-prices', parsed.sessionId);
    const results = await stageProductPricesBatch(session.sessionId, parsed.items);
    const outcome = await completeImplicitSessionIfNeeded(session.implicit, session.sessionId, results);

    await safeCompleteSyncRun(runId, results, {
      rawCount,
      parsedCount: parsed.items.length,
      sessionId: session.sessionId,
      sessionStatus: outcome?.status,
    });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in product prices batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
export const handleOrdersQueued = async (req: Request, res: Response) => {
  const includeSentRaw = String(req.query.includeSent ?? '').toLowerCase();
  const includeSent = includeSentRaw === '1' || includeSentRaw === 'true' || includeSentRaw === 'yes';
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 50;

  const statuses = includeSent ? [OrderStatus.QUEUED, OrderStatus.SENT_TO_1C, OrderStatus.CANCELLED] : [OrderStatus.QUEUED, OrderStatus.CANCELLED];
  const syncStates = includeSent
    ? [OrderSyncState.QUEUED, OrderSyncState.CANCEL_REQUESTED, OrderSyncState.SYNCED]
    : [OrderSyncState.QUEUED, OrderSyncState.CANCEL_REQUESTED];
  const baseMeta = { includeSent, limit, statuses, syncStates };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_EXPORT, SyncDirection.EXPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders export', e);
  }

  try {
    const orders = await prisma.order.findMany({
      where: {
        source: { in: [OrderSource.MANAGER_APP, OrderSource.MARKETPLACE_CLIENT] },
        status: { in: statuses },
        syncState: { in: syncStates },
      },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: {
        id: true,
        guid: true,
        source: true,
        revision: true,
        syncState: true,
        status: true,
        queuedAt: true,
        sentTo1cAt: true,
        deliveryDate: true,
        comment: true,
        currency: true,
        totalAmount: true,
        generalDiscountPercent: true,
        generalDiscountAmount: true,
        exportAttempts: true,
        lastExportError: true,
        isPostedIn1c: true,
        postedAt1c: true,
        cancelRequestedAt: true,
        cancelReason: true,
        last1cError: true,
        counterparty: {
          select: { guid: true, name: true, inn: true, kpp: true, isActive: true },
        },
        agreement: {
          select: { guid: true, name: true, isActive: true },
        },
        contract: {
          select: { guid: true, number: true, date: true, isActive: true },
        },
        warehouse: {
          select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
        },
        deliveryAddress: {
          select: { guid: true, name: true, fullAddress: true, isActive: true },
        },
        organization: {
          select: { guid: true, name: true, code: true, isActive: true },
        },
        items: {
          orderBy: [{ createdAt: 'asc' }],
          select: {
            id: true,
            quantity: true,
            quantityBase: true,
            basePrice: true,
            price: true,
            isManualPrice: true,
            manualPrice: true,
            priceSource: true,
            discountPercent: true,
            appliedDiscountPercent: true,
            lineAmount: true,
            comment: true,
            product: { select: { guid: true, name: true, sku: true, article: true, isActive: true } },
            package: { select: { guid: true, name: true, isDefault: true } },
            unit: { select: { guid: true, name: true, symbol: true } },
          },
        },
      },
    });

    const payload = orders.map((order) => ({
      guid: order.guid ?? order.id,
      source: order.source,
      revision: order.revision,
      syncState: order.syncState,
      status: order.status,
      queuedAt: order.queuedAt,
      sentTo1cAt: order.sentTo1cAt,
      deliveryDate: order.deliveryDate,
      comment: order.comment,
      currency: order.currency,
      totalAmount: decimalToNumber(order.totalAmount),
      generalDiscountPercent: decimalToNumber(order.generalDiscountPercent),
      generalDiscountAmount: decimalToNumber(order.generalDiscountAmount),
      exportAttempts: order.exportAttempts,
      lastExportError: order.lastExportError,
      isPostedIn1c: order.isPostedIn1c,
      postedAt1c: order.postedAt1c,
      cancelRequestedAt: order.cancelRequestedAt,
      cancelReason: order.cancelReason,
      last1cError: order.last1cError,
      counterparty: order.counterparty,
      agreement: order.agreement,
      contract: order.contract,
      warehouse: order.warehouse,
      deliveryAddress: order.deliveryAddress,
      organization: order.organization,
      items: order.items.map((item) => ({
        id: item.id,
        product: item.product,
        package: item.package,
        unit: item.unit,
        quantity: decimalToNumber(item.quantity),
        quantityBase: decimalToNumber(item.quantityBase),
        basePrice: decimalToNumber(item.basePrice),
        price: decimalToNumber(item.price),
        isManualPrice: item.isManualPrice,
        manualPrice: decimalToNumber(item.manualPrice),
        priceSource: item.priceSource,
        discountPercent: decimalToNumber(item.discountPercent),
        appliedDiscountPercent: decimalToNumber(item.appliedDiscountPercent),
        lineAmount: decimalToNumber(item.lineAmount),
        comment: item.comment,
      })),
    }));

    const results: BatchResult[] = payload.map((order) => ({ key: String(order.guid), status: 'ok' }));
    await safeCompleteSyncRun(runId, results, { ...baseMeta, exportedCount: payload.length });

    return res.json({
      success: true,
      count: payload.length,
      orders: payload,
    });
  } catch (error) {
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in orders queued export', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleOrderAck = async (req: Request, res: Response) => {
  const orderGuid = toSingleString(req.params.guid);
  if (!orderGuid) {
    return res.status(400).json({ error: 'Invalid order guid' });
  }
  const baseMeta = { orderGuid };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_EXPORT, SyncDirection.EXPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for order ack', e);
  }

  try {
    const parsed = orderAckSchema.parse(req.body);
    const syncedAt = now();
    const order = await prisma.order.findUnique({
      where: { guid: orderGuid },
      select: { id: true, guid: true, revision: true },
    });

    if (!order) {
      const results: BatchResult[] = [{ key: orderGuid, status: 'error', error: 'Order not found' }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order not found');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (parsed.error) {
      await prisma.$transaction(async (tx) => {
        const nextRevision = order.revision + 1;
        await tx.order.update({
          where: { id: order.id },
          data: {
            revision: nextRevision,
            status: OrderStatus.QUEUED,
            syncState: OrderSyncState.ERROR,
            exportAttempts: { increment: 1 },
            lastExportError: parsed.error,
            last1cError: parsed.error,
            sentTo1cAt: null,
            lastSyncedAt: syncedAt,
            sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
          },
        });
        await appendOrderEvent(tx, {
          orderId: order.id,
          revision: nextRevision,
          source: OrderEventSource.ONEC_ACK,
          eventType: 'ONEC_ORDER_ACK_ERROR',
          payload: {
            error: parsed.error,
            sourceUpdatedAt: (parsed.sourceUpdatedAt ?? syncedAt).toISOString(),
          },
          note: parsed.error,
        });
      });
      const results: BatchResult[] = [{ key: order.guid ?? orderGuid, status: 'error', error: parsed.error }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order export acknowledged with error');
      return res.json({ success: true, acknowledged: true, error: parsed.error });
    }

    const nextStatus = parsed.status ?? OrderStatus.SENT_TO_1C;
    await prisma.$transaction(async (tx) => {
      const nextRevision = order.revision + 1;
      await tx.order.update({
        where: { id: order.id },
        data: {
          revision: nextRevision,
          status: nextStatus,
          syncState: OrderSyncState.SYNCED,
          number1c: parsed.number1c ?? undefined,
          date1c: parsed.date1c ?? undefined,
          sentTo1cAt: parsed.sentTo1cAt ?? syncedAt,
          lastStatusSyncAt: syncedAt,
          exportAttempts: { increment: 1 },
          lastExportError: null,
          last1cError: null,
          lastSyncedAt: syncedAt,
          sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
        },
      });
      await appendOrderEvent(tx, {
        orderId: order.id,
        revision: nextRevision,
        source: OrderEventSource.ONEC_ACK,
        eventType: 'ONEC_ORDER_ACK_OK',
        payload: {
          status: nextStatus,
          number1c: parsed.number1c ?? null,
          date1c: parsed.date1c?.toISOString?.() ?? null,
          sentTo1cAt: (parsed.sentTo1cAt ?? syncedAt).toISOString(),
        },
      });
    });

    const results: BatchResult[] = [{ key: order.guid ?? orderGuid, status: 'ok' }];
    await safeCompleteSyncRun(runId, results, { ...baseMeta, status: nextStatus });

    return res.json({ success: true, acknowledged: true, status: nextStatus });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in order ack', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleOrdersStatusBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_STATUS, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders status', e);
  }

  try {
    const parsed = ordersStatusBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        const order = await tx.order.findUnique({
          where: { guid: item.guid },
          select: { id: true, guid: true },
        });

        if (!order) {
          results.push({ key: item.guid, status: 'error', error: 'Order not found' });
          continue;
        }

        const current = await tx.order.findUnique({
          where: { id: order.id },
          select: { revision: true },
        });

        const data: Prisma.OrderUpdateInput = {
          revision: (current?.revision ?? 0) + 1,
          status: item.status,
          syncState: OrderSyncState.SYNCED,
          isPostedIn1c: item.status === OrderStatus.CONFIRMED ? true : undefined,
          postedAt1c: item.status === OrderStatus.CONFIRMED ? syncedAt : undefined,
          lastStatusSyncAt: syncedAt,
          lastSyncedAt: syncedAt,
          sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
        };

        if (item.number1c !== undefined) data.number1c = item.number1c;
        if (item.date1c !== undefined) data.date1c = item.date1c;
        if (item.comment !== undefined) data.comment = item.comment ?? null;
        if (item.totalAmount !== undefined) data.totalAmount = toDecimal(item.totalAmount);
        if (item.currency !== undefined) data.currency = item.currency;

        try {
          await tx.order.update({ where: { id: order.id }, data });
          await appendOrderEvent(tx, {
            orderId: order.id,
            revision: (current?.revision ?? 0) + 1,
            source: item.status === OrderStatus.CONFIRMED ? OrderEventSource.ONEC_POST : OrderEventSource.ONEC_EDIT,
            eventType: 'ONEC_ORDER_STATUS_SYNC',
            payload: {
              status: item.status,
              number1c: item.number1c ?? null,
              date1c: item.date1c?.toISOString?.() ?? null,
              comment: item.comment ?? null,
              totalAmount: item.totalAmount ?? null,
              currency: item.currency ?? null,
            },
          });
          results.push({ key: order.guid ?? item.guid, status: 'ok' });
        } catch (err) {
          console.error(`Failed to update order status ${item.guid}`, err);
          results.push({ key: item.guid, status: 'error', error: 'Failed to update order status' });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in orders status batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

async function upsertSnapshotOrganization(
  tx: Prisma.TransactionClient,
  organization?: { guid: string; name: string; code?: string }
) {
  if (!organization) return null;
  const record = await tx.organization.upsert({
    where: { guid: organization.guid },
    update: {
      name: organization.name,
      code: organization.code ?? undefined,
      isActive: true,
      sourceUpdatedAt: now(),
      lastSyncedAt: now(),
    },
    create: {
      guid: organization.guid,
      name: organization.name,
      code: organization.code ?? null,
      isActive: true,
      sourceUpdatedAt: now(),
      lastSyncedAt: now(),
    },
    select: { id: true },
  });
  return record.id;
}

async function replaceOrderItemsFromSnapshot(
  tx: Prisma.TransactionClient,
  orderId: string,
  items: Array<{
    product: { guid: string };
    package?: { guid?: string | undefined } | null;
    unit?: { guid?: string | undefined } | null;
    quantity: number;
    quantityBase?: number | undefined;
    basePrice?: number | null | undefined;
    price?: number | null | undefined;
    isManualPrice?: boolean | undefined;
    manualPrice?: number | null | undefined;
    priceSource?: string | undefined;
    discountPercent?: number | null | undefined;
    appliedDiscountPercent?: number | null | undefined;
    lineAmount?: number | null | undefined;
    comment?: string | null | undefined;
  }>
) {
  await tx.orderItem.deleteMany({ where: { orderId } });

  let computedTotal = new Prisma.Decimal(0);

  for (const item of items) {
    const product = await tx.product.findUnique({
      where: { guid: item.product.guid },
      select: {
        id: true,
        guid: true,
        baseUnit: { select: { id: true, guid: true } },
      },
    });

    if (!product) {
      throw new Error(`Product ${item.product.guid} not found for order snapshot`);
    }

    const packageRecord = item.package?.guid
      ? await tx.productPackage.findFirst({
          where: { guid: item.package.guid, productId: product.id },
          select: { id: true, unitId: true, multiplier: true },
        })
      : null;

    const explicitUnit = item.unit?.guid
      ? await tx.unit.findUnique({ where: { guid: item.unit.guid }, select: { id: true } })
      : null;

    const quantity = toDecimal(item.quantity) ?? new Prisma.Decimal(item.quantity);
    const quantityBase =
      item.quantityBase !== undefined && item.quantityBase !== null
        ? new Prisma.Decimal(item.quantityBase)
        : packageRecord?.multiplier
          ? quantity.mul(packageRecord.multiplier)
          : quantity;
    const price =
      item.price !== undefined && item.price !== null
        ? new Prisma.Decimal(item.price)
        : item.basePrice !== undefined && item.basePrice !== null
          ? new Prisma.Decimal(item.basePrice)
          : new Prisma.Decimal(0);
    const lineAmount =
      item.lineAmount !== undefined && item.lineAmount !== null
        ? new Prisma.Decimal(item.lineAmount)
        : quantityBase.mul(price);

    computedTotal = computedTotal.add(lineAmount);

    await tx.orderItem.create({
      data: {
        orderId,
        productId: product.id,
        packageId: packageRecord?.id ?? null,
        unitId: explicitUnit?.id ?? packageRecord?.unitId ?? product.baseUnit?.id ?? null,
        quantity,
        quantityBase,
        basePrice: item.basePrice !== undefined && item.basePrice !== null ? new Prisma.Decimal(item.basePrice) : null,
        price,
        isManualPrice: item.isManualPrice ?? false,
        manualPrice: item.manualPrice !== undefined && item.manualPrice !== null ? new Prisma.Decimal(item.manualPrice) : null,
        priceSource: item.priceSource ?? null,
        discountPercent:
          item.discountPercent !== undefined && item.discountPercent !== null
            ? new Prisma.Decimal(item.discountPercent)
            : null,
        appliedDiscountPercent:
          item.appliedDiscountPercent !== undefined && item.appliedDiscountPercent !== null
            ? new Prisma.Decimal(item.appliedDiscountPercent)
            : null,
        lineAmount,
        comment: item.comment ?? null,
        sourceUpdatedAt: now(),
      },
    });
  }

  return computedTotal;
}

export const handleOrdersSnapshotBatch = async (req: Request, res: Response) => {
  const rawCount = Array.isArray(req.body?.items) ? req.body.items.length : 0;
  const baseMeta = { rawCount };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_SNAPSHOT, SyncDirection.IMPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders snapshot', e);
  }

  try {
    const parsed = ordersSnapshotBatchSchema.parse(req.body);
    const results: BatchResult[] = [];
    const syncedAt = now();

    await prisma.$transaction(async (tx) => {
      for (const item of parsed.items) {
        const order = await tx.order.findUnique({
          where: { guid: item.guid },
          select: { id: true, guid: true, revision: true, source: true },
        });

        if (!order) {
          results.push({ key: item.guid, status: 'error', error: 'Order not found' });
          continue;
        }

        if (item.baseRevision !== order.revision) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              syncState: OrderSyncState.CONFLICT,
              last1cError: `Revision conflict. Current=${order.revision}, snapshotBase=${item.baseRevision}`,
              last1cSnapshot: item as unknown as Prisma.InputJsonValue,
              lastSyncedAt: syncedAt,
            },
          });
          await appendOrderEvent(tx, {
            orderId: order.id,
            revision: order.revision,
            source: OrderEventSource.ONEC_EDIT,
            eventType: 'ONEC_ORDER_SNAPSHOT_CONFLICT',
            payload: item as unknown as Prisma.InputJsonValue,
            note: `Revision conflict. Current=${order.revision}, snapshotBase=${item.baseRevision}`,
          });
          results.push({ key: item.guid, status: 'error', error: 'Revision conflict' });
          continue;
        }

        try {
          const organizationId = await upsertSnapshotOrganization(tx, item.organization);
          const computedTotal = await replaceOrderItemsFromSnapshot(tx, order.id, item.items);
          const nextRevision = item.revision ?? order.revision + 1;
          const nextStatus = item.status;
          const nextSyncState =
            item.syncState ??
            (nextStatus === OrderStatus.CANCELLED ? OrderSyncState.SYNCED : OrderSyncState.SYNCED);

          await tx.order.update({
            where: { id: order.id },
            data: {
              revision: nextRevision,
              status: nextStatus,
              syncState: nextSyncState,
              number1c: item.number1c ?? undefined,
              date1c: item.date1c ?? undefined,
              isPostedIn1c: item.isPostedIn1c ?? false,
              postedAt1c: item.postedAt1c ?? undefined,
              organizationId: organizationId ?? undefined,
              comment: item.comment ?? null,
              deliveryDate: item.deliveryDate ?? null,
              currency: item.currency ?? undefined,
              totalAmount:
                item.totalAmount !== undefined && item.totalAmount !== null
                  ? new Prisma.Decimal(item.totalAmount)
                  : computedTotal,
              generalDiscountPercent:
                item.generalDiscountPercent !== undefined && item.generalDiscountPercent !== null
                  ? new Prisma.Decimal(item.generalDiscountPercent)
                  : null,
              generalDiscountAmount:
                item.generalDiscountAmount !== undefined && item.generalDiscountAmount !== null
                  ? new Prisma.Decimal(item.generalDiscountAmount)
                  : null,
              cancelReason: item.cancelReason ?? null,
              last1cError: item.last1cError ?? null,
              last1cSnapshot: item as unknown as Prisma.InputJsonValue,
              lastStatusSyncAt: syncedAt,
              lastSyncedAt: syncedAt,
              sourceUpdatedAt: item.sourceUpdatedAt ?? syncedAt,
            },
          });

          await appendOrderEvent(tx, {
            orderId: order.id,
            revision: nextRevision,
            source: item.isPostedIn1c ? OrderEventSource.ONEC_POST : OrderEventSource.ONEC_EDIT,
            eventType: 'ONEC_ORDER_SNAPSHOT_APPLIED',
            payload: item as unknown as Prisma.InputJsonValue,
          });

          results.push({ key: order.guid ?? item.guid, status: 'ok' });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to apply order snapshot';
          await tx.order.update({
            where: { id: order.id },
            data: {
              syncState: OrderSyncState.ERROR,
              last1cError: message,
              last1cSnapshot: item as unknown as Prisma.InputJsonValue,
              lastSyncedAt: syncedAt,
            },
          });
          await appendOrderEvent(tx, {
            orderId: order.id,
            revision: order.revision,
            source: OrderEventSource.ONEC_IMPORT,
            eventType: 'ONEC_ORDER_SNAPSHOT_ERROR',
            payload: item as unknown as Prisma.InputJsonValue,
            note: message,
          });
          results.push({ key: item.guid, status: 'error', error: message });
        }
      }
    });

    await safeCompleteSyncRun(runId, results, { rawCount, parsedCount: parsed.items.length });
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    if (error instanceof ZodError) {
      await safeFailSyncRun(runId, error, baseMeta);
      return handleValidationError(error, res);
    }
    await safeFailSyncRun(runId, error, baseMeta);
    console.error('Unexpected error in orders snapshot batch', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const parseEnum = <T extends Record<string, string>>(value: unknown, enumObj: T): T[keyof T] | undefined => {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const str = String(raw);
  return Object.values(enumObj).includes(str) ? (str as T[keyof T]) : undefined;
};

export const handleSyncRunsList = async (req: Request, res: Response) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 50;

  const entity = parseEnum(req.query.entity, SyncEntityType);
  const direction = parseEnum(req.query.direction, SyncDirection);
  const status = parseEnum(req.query.status, SyncStatus);

  if (req.query.entity && !entity) {
    return res.status(400).json({ error: 'Invalid entity value' });
  }
  if (req.query.direction && !direction) {
    return res.status(400).json({ error: 'Invalid direction value' });
  }
  if (req.query.status && !status) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  const where: Prisma.SyncRunWhereInput = {
    ...(entity ? { entity } : {}),
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
  };

  try {
    const runs = await prisma.syncRun.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }],
      take: limit,
      select: {
        id: true,
        requestId: true,
        entity: true,
        direction: true,
        status: true,
        totalCount: true,
        successCount: true,
        errorCount: true,
        startedAt: true,
        finishedAt: true,
        notes: true,
        meta: true,
      },
    });

    const payload = runs.map((run) => ({
      ...run,
      itemsCount: run.totalCount,
    }));

    return res.json({ success: true, count: payload.length, runs: payload });
  } catch (error) {
    console.error('Unexpected error in sync runs list', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const handleSyncRunDetail = async (req: Request, res: Response) => {
  const runId = toSingleString(req.params.runId);
  if (!runId) {
    return res.status(400).json({ error: 'Invalid run id' });
  }
  const includeItemsRaw = String(req.query.includeItems ?? '').toLowerCase();
  const includeItems =
    includeItemsRaw === '1' || includeItemsRaw === 'true' || includeItemsRaw === 'yes';
  const requestedLimit = Number(req.query.itemsLimit);
  const itemsLimit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
    : 200;

  try {
    const run = await prisma.syncRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        requestId: true,
        entity: true,
        direction: true,
        status: true,
        totalCount: true,
        successCount: true,
        errorCount: true,
        startedAt: true,
        finishedAt: true,
        notes: true,
        meta: true,
        items: includeItems
          ? {
              take: itemsLimit,
              orderBy: [{ createdAt: 'desc' }],
              select: {
                id: true,
                key: true,
                status: true,
                error: true,
                createdAt: true,
              },
            }
          : false,
      },
    });

    if (!run) {
      return res.status(404).json({ error: 'Sync run not found' });
    }

    const payload = {
      ...run,
      itemsCount: run.totalCount,
    };

    return res.json({ success: true, run: payload });
  } catch (error) {
    console.error('Unexpected error in sync run detail', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
