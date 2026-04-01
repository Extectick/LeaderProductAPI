import {
  OrderStatus,
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
import {
  agreementsBatchSchema,
  counterpartiesBatchSchema,
  nomenclatureBatchSchema,
  organizationsBatchSchema,
  orderAckSchema,
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

  const statuses = includeSent ? [OrderStatus.QUEUED, OrderStatus.SENT_TO_1C] : [OrderStatus.QUEUED];
  const baseMeta = { includeSent, limit, statuses };
  let runId: string | undefined;

  try {
    runId = (await startSyncRun(SyncEntityType.ORDERS_EXPORT, SyncDirection.EXPORT, baseMeta)).id;
  } catch (e) {
    console.error('Failed to start sync run for orders export', e);
  }

  try {
    const orders = await prisma.order.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: {
        id: true,
        guid: true,
        status: true,
        queuedAt: true,
        sentTo1cAt: true,
        deliveryDate: true,
        comment: true,
        currency: true,
        totalAmount: true,
        exportAttempts: true,
        lastExportError: true,
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
        items: {
          orderBy: [{ createdAt: 'asc' }],
          select: {
            id: true,
            quantity: true,
            quantityBase: true,
            price: true,
            discountPercent: true,
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
      status: order.status,
      queuedAt: order.queuedAt,
      sentTo1cAt: order.sentTo1cAt,
      deliveryDate: order.deliveryDate,
      comment: order.comment,
      currency: order.currency,
      totalAmount: decimalToNumber(order.totalAmount),
      exportAttempts: order.exportAttempts,
      lastExportError: order.lastExportError,
      counterparty: order.counterparty,
      agreement: order.agreement,
      contract: order.contract,
      warehouse: order.warehouse,
      deliveryAddress: order.deliveryAddress,
      items: order.items.map((item) => ({
        id: item.id,
        product: item.product,
        package: item.package,
        unit: item.unit,
        quantity: decimalToNumber(item.quantity),
        quantityBase: decimalToNumber(item.quantityBase),
        price: decimalToNumber(item.price),
        discountPercent: decimalToNumber(item.discountPercent),
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
    const order = await prisma.order.findUnique({ where: { guid: orderGuid }, select: { id: true, guid: true } });

    if (!order) {
      const results: BatchResult[] = [{ key: orderGuid, status: 'error', error: 'Order not found' }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order not found');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (parsed.error) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.QUEUED,
          exportAttempts: { increment: 1 },
          lastExportError: parsed.error,
          sentTo1cAt: null,
          lastSyncedAt: syncedAt,
          sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
        },
      });
      const results: BatchResult[] = [{ key: order.guid ?? orderGuid, status: 'error', error: parsed.error }];
      await safeCompleteSyncRun(runId, results, baseMeta, 'Order export acknowledged with error');
      return res.json({ success: true, acknowledged: true, error: parsed.error });
    }

    const nextStatus = parsed.status ?? OrderStatus.SENT_TO_1C;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        number1c: parsed.number1c ?? undefined,
        date1c: parsed.date1c ?? undefined,
        sentTo1cAt: parsed.sentTo1cAt ?? syncedAt,
        lastStatusSyncAt: syncedAt,
        exportAttempts: { increment: 1 },
        lastExportError: null,
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: parsed.sourceUpdatedAt ?? syncedAt,
      },
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

        const data: Prisma.OrderUpdateInput = {
          status: item.status,
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
