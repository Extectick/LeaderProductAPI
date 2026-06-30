import {
  OrderEventSource,
  OrderSource,
  OrderStatus,
  OrderSyncState,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../prisma/client';
import { getRedis } from '../lib/redis';
import {
  buildQueuedOrderPayload,
  clientOrderDirectPushLockKey,
  queuedOrderSelect,
type QueuedOrderForExport,
} from '../modules/onec/onec.orderQueuePayload';
import {
  OnecLpAppConfigError,
  OnecLpAppHttpError,
  OnecLpAppNetworkError,
  postOnecLpAppClientOrder,
  putOnecLpAppClientOrder,
} from '../modules/onec/onec.lpApp.client';
import { appendOrderEvent } from '../modules/orders/orderEvents';
import { getLiveProductsByGuids } from '../modules/clientOrders/clientOrders.onecLive';

const LOCK_KEY = 'client-orders:export-worker:lock';
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BACKOFF_BASE_MS = 10_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;

let timer: NodeJS.Timeout | null = null;
let wakeupTimer: NodeJS.Timeout | null = null;
let inMemoryLock = false;
let isStarted = false;
let directPushPausedUntil = 0;
let lastPauseLogAt = 0;

type ExportFailureContext = {
  requestId: string;
  transport: 'POST' | 'PUT_FALLBACK' | 'UNKNOWN';
  payload: unknown;
};

class ClientOrderExportFailure extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly context: ExportFailureContext
  ) {
    super(errorMessage(cause));
    this.name = 'ClientOrderExportFailure';
  }
}

type ClientOrderExportItemError = {
  code: 'INSUFFICIENT_STOCK';
  lineGuid: string | null;
  productGuid: string;
  productName: string;
  requiredBase: number;
  available: number;
  message: string;
};

class ClientOrderExportValidationError extends Error {
  constructor(
    message: string,
    public readonly itemErrors: ClientOrderExportItemError[] = []
  ) {
    super(message);
    this.name = 'ClientOrderExportValidationError';
  }
}

function envInt(name: string, fallback: number, min = 1) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.trunc(raw) : fallback;
}

function getIntervalMs() {
  return envInt('CLIENT_ORDERS_EXPORT_WORKER_INTERVAL_MS', DEFAULT_INTERVAL_MS, 1000);
}

function getBatchSize() {
  return envInt('CLIENT_ORDERS_EXPORT_BATCH_SIZE', DEFAULT_BATCH_SIZE, 1);
}

function getBackoffMs(attempts: number) {
  if (attempts <= 0) return 0;
  const base = envInt('CLIENT_ORDERS_EXPORT_BACKOFF_BASE_MS', DEFAULT_BACKOFF_BASE_MS, 1000);
  const max = envInt('CLIENT_ORDERS_EXPORT_BACKOFF_MAX_MS', DEFAULT_BACKOFF_MAX_MS, base);
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function pauseDirectPush(ms: number, reason: string) {
  const until = Date.now() + ms;
  directPushPausedUntil = Math.max(directPushPausedUntil, until);
  const nowMs = Date.now();
  if (nowMs - lastPauseLogAt > 30_000) {
    lastPauseLogAt = nowMs;
    console.warn('[client-orders-export-worker] direct push paused', {
      pauseMs: ms,
      until: new Date(directPushPausedUntil).toISOString(),
      reason,
    });
  }
}

function pauseDirectPushIfNeeded(error: unknown) {
  if (error instanceof OnecLpAppHttpError && (error.upstreamStatus === 404 || error.upstreamStatus === 405)) {
    pauseDirectPush(
      envInt('CLIENT_ORDERS_EXPORT_UNSUPPORTED_PAUSE_MS', 300_000, 10_000),
      `1C endpoint does not support direct push yet: HTTP ${error.upstreamStatus}`
    );
    return true;
  }
  if (error instanceof OnecLpAppConfigError) {
    pauseDirectPush(
      envInt('CLIENT_ORDERS_EXPORT_CONFIG_ERROR_PAUSE_MS', 60_000, 10_000),
      error.message
    );
    return true;
  }
  return false;
}

function shouldAttempt(order: QueuedOrderForExport, nowMs: number) {
  const attempts = order.exportAttempts ?? 0;
  if (attempts <= 0) return true;
  const lastAttemptAt = order.sourceUpdatedAt ?? order.updatedAt ?? order.queuedAt ?? order.createdAt;
  return nowMs - lastAttemptAt.getTime() >= getBackoffMs(attempts);
}

async function acquireLock() {
  const lockId = randomUUID();
  const ttlMs = envInt('CLIENT_ORDERS_EXPORT_LOCK_TTL_MS', DEFAULT_LOCK_TTL_MS, 5000);

  try {
    const redis = getRedis();
    if (redis.isOpen) {
      const acquired = await redis.set(LOCK_KEY, lockId, { NX: true, PX: ttlMs });
      if (acquired !== 'OK') return null;
      return async () => {
        try {
          const current = await redis.get(LOCK_KEY);
          if (current === lockId) await redis.del(LOCK_KEY);
        } catch {
          // Lock cleanup is best-effort. TTL is the final guard.
        }
      };
    }
  } catch {
    // Redis is optional here; single-process fallback keeps local development working.
  }

  if (inMemoryLock) return null;
  inMemoryLock = true;
  return async () => {
    inMemoryLock = false;
  };
}

async function acquireOrderLock(orderGuid: string) {
  const lockId = randomUUID();
  const ttlMs = envInt('CLIENT_ORDERS_EXPORT_ORDER_LOCK_TTL_MS', 60_000, 5000);

  try {
    const redis = getRedis();
    if (!redis.isOpen) return async () => {};

    const key = clientOrderDirectPushLockKey(orderGuid);
    const acquired = await redis.set(key, lockId, { NX: true, PX: ttlMs });
    if (acquired !== 'OK') return null;

    return async () => {
      try {
        const current = await redis.get(key);
        if (current === lockId) await redis.del(key);
      } catch {
        // Order lock cleanup is best-effort. TTL is the final guard.
      }
    };
  } catch {
    return async () => {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readDate(source: Record<string, unknown> | null, keys: string[]) {
  const value = readString(source, keys);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractSavedOrder(payload: unknown) {
  const root = asRecord(payload);
  const item = asRecord(root?.item) ?? root;
  return {
    number1c: readString(item, ['number1c', 'number', 'Номер']),
    date1c: readDate(item, ['date1c', 'date', 'Дата']),
    documentGuid: readString(item, ['documentGuid', 'guid', 'id', 'Ссылка']),
    currentState: readString(item, ['currentState', 'statusLabel', 'status', 'ТекущееСостояние']),
  };
}

function extractSavedOrderItems(payload: unknown): unknown[] | null {
  const root = asRecord(payload);
  const item = asRecord(root?.item) ?? root;
  const directItems = item?.items;
  if (Array.isArray(directItems)) return directItems;

  const data = asRecord(root?.data);
  const dataItems = data?.items;
  if (Array.isArray(dataItems)) return dataItems;

  const order = asRecord(data?.order) ?? asRecord(root?.order);
  const orderItems = order?.items;
  if (Array.isArray(orderItems)) return orderItems;

  return null;
}

function assertSavedOrderDidNotLoseItems(order: QueuedOrderForExport, payload: unknown) {
  const localItemsCount = Array.isArray(order.items) ? order.items.length : 0;
  const savedItems = extractSavedOrderItems(payload);
  if (localItemsCount > 0 && savedItems !== null && savedItems.length === 0) {
    throw new Error(
      `1С вернула успешный ответ без строк товаров; локально в заказе ${localItemsCount} строк. Заказ оставлен в очереди, чтобы не потерять данные.`
    );
  }
}

function errorMessage(error: unknown) {
  if (error instanceof OnecLpAppHttpError) {
    return `1С HTTP ${error.upstreamStatus}: ${error.message}`;
  }
  if (error instanceof OnecLpAppNetworkError || error instanceof OnecLpAppConfigError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function serializeDebugPayload(payload: unknown) {
  const maxChars = envInt('CLIENT_ORDERS_EXPORT_DEBUG_PAYLOAD_MAX_CHARS', 20_000, 1000);
  let json = '';
  try {
    json = JSON.stringify(payload);
  } catch {
    json = JSON.stringify({ serializationError: 'Failed to serialize export payload' });
  }
  const truncated = json.length > maxChars;
  return {
    json: truncated ? json.slice(0, maxChars) : json,
    bytes: Buffer.byteLength(json, 'utf8'),
    truncated,
    maxChars,
  };
}

function buildPayloadSummary(payload: unknown) {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : [];
  return {
    requestId: typeof record.requestId === 'string' ? record.requestId : null,
    guid: typeof record.guid === 'string' ? record.guid : null,
    appGuid: typeof record.appGuid === 'string' ? record.appGuid : null,
    revision: typeof record.revision === 'number' ? record.revision : null,
    itemsCount: items.length,
    totalAmount: record.totalAmount ?? null,
    organizationGuid:
      record.organization && typeof record.organization === 'object'
        ? (record.organization as Record<string, unknown>).guid ?? null
        : null,
    counterpartyGuid:
      record.counterparty && typeof record.counterparty === 'object'
        ? (record.counterparty as Record<string, unknown>).guid ?? null
        : null,
  };
}

function upstreamPayloadForDebug(error: unknown) {
  if (error instanceof OnecLpAppHttpError) {
    return error.payload;
  }
  return null;
}

function isCancelExportOrder(order: Pick<QueuedOrderForExport, 'status' | 'syncState'>) {
  return order.status === OrderStatus.CANCELLED || order.syncState === OrderSyncState.CANCEL_REQUESTED;
}

function validateOrderReadyForExport(order: QueuedOrderForExport) {
  if (isCancelExportOrder(order)) return;

  const errors: string[] = [];
  if (!order.organization?.guid) errors.push('организация');
  if (!order.counterparty?.guid) errors.push('контрагент');
  if (!order.agreement?.guid) errors.push('соглашение');
  if (!order.contract?.guid) errors.push('договор');
  if (!order.warehouse?.guid) errors.push('склад');
  if (!order.deliveryAddress?.guid) errors.push('адрес доставки');
  if (!order.deliveryDate) errors.push('дата отгрузки');

  const activeItems = order.items.filter((item) => !item.isCancelled);
  if (!activeItems.length) {
    errors.push('активные строки товаров');
  }

  activeItems.forEach((item, index) => {
    const linePrefix = `строка ${index + 1}`;
    if (!item.product?.guid) errors.push(`${linePrefix}: номенклатура`);
    if (item.quantity.lte(0)) errors.push(`${linePrefix}: количество должно быть больше 0`);
    if (item.basePrice === null || item.basePrice.lte(0)) errors.push(`${linePrefix}: цена должна быть больше 0`);
  });

  if (errors.length) {
    throw new ClientOrderExportValidationError(`Заказ не отправлен в 1С: заполните ${errors.join(', ')}.`);
  }
}

function numberOrZero(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return value.toNumber();
}

function formatStockNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
}

async function validateOrderStockBeforeExport(order: QueuedOrderForExport) {
  if (isCancelExportOrder(order)) return;
  if (process.env.CLIENT_ORDERS_EXPORT_STOCK_PREFLIGHT_DISABLED === '1') return;
  if (!order.warehouse?.guid) return;

  const activeItems = order.items.filter((item) => !item.isCancelled && item.product?.guid);
  if (!activeItems.length) return;

  const requiredByProduct = new Map<string, { productGuid: string; productName: string; requiredBase: number }>();
  for (const item of activeItems) {
    const productGuid = item.product!.guid;
    const current = requiredByProduct.get(productGuid) ?? {
      productGuid,
      productName: item.product!.name,
      requiredBase: 0,
    };
    current.requiredBase += numberOrZero(item.quantityBase) || numberOrZero(item.quantity);
    requiredByProduct.set(productGuid, current);
  }

  const products = await getLiveProductsByGuids({
    productGuids: [...requiredByProduct.keys()],
    organizationGuid: order.organization?.guid ?? undefined,
    counterpartyGuid: order.counterparty?.guid ?? undefined,
    agreementGuid: order.agreement?.guid ?? undefined,
    warehouseGuid: order.warehouse.guid,
  });
  const liveByGuid = new Map(products.map((product) => [product.guid.toLowerCase(), product]));
  const deficits: string[] = [];
  const itemErrors: ClientOrderExportItemError[] = [];

  for (const item of requiredByProduct.values()) {
    const liveProduct = liveByGuid.get(item.productGuid.toLowerCase());
    const available = liveProduct?.stock?.available;
    if (available === null || available === undefined) continue;
    if (available + 0.000001 < item.requiredBase) {
      deficits.push(
        `${item.productName}: требуется ${formatStockNumber(item.requiredBase)}, доступно ${formatStockNumber(available)}`
      );
    }
  }

  if (deficits.length) {
    for (const line of activeItems) {
      const productGuid = line.product!.guid;
      const total = requiredByProduct.get(productGuid);
      const liveProduct = liveByGuid.get(productGuid.toLowerCase());
      const available = liveProduct?.stock?.available;
      if (!total || available === null || available === undefined || available + 0.000001 >= total.requiredBase) continue;
      const lineRequired = numberOrZero(line.quantityBase) || numberOrZero(line.quantity);
      itemErrors.push({
        code: 'INSUFFICIENT_STOCK',
        lineGuid: line.lineGuid ?? null,
        productGuid,
        productName: line.product!.name,
        requiredBase: lineRequired,
        available,
        message: `Недостаточно остатка: требуется ${formatStockNumber(lineRequired)}, доступно ${formatStockNumber(available)}.`,
      });
    }
    throw new ClientOrderExportValidationError(
      `Заказ не отправлен в 1С: недостаточно доступного остатка на складе ${order.warehouse.name}. ${deficits.join('; ')}.`,
      itemErrors
    );
  }
}

async function markOrderExportSuccess(order: QueuedOrderForExport, payload: unknown, requestId: string, transport: string) {
  assertSavedOrderDidNotLoseItems(order, payload);
  const saved = extractSavedOrder(payload);
  const syncedAt = new Date();
  const isCancelExport = isCancelExportOrder(order);

  await prisma.$transaction(async (tx) => {
    const current = await tx.order.findFirst({
      where: {
        id: order.id,
        status: isCancelExport ? OrderStatus.CANCELLED : OrderStatus.QUEUED,
        syncState: isCancelExport ? OrderSyncState.CANCEL_REQUESTED : OrderSyncState.QUEUED,
      },
      select: { revision: true },
    });
    if (!current) return;

    const nextRevision = current.revision + 1;
    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: isCancelExport ? OrderStatus.CANCELLED : OrderStatus.SENT_TO_1C,
        syncState: OrderSyncState.SYNCED,
        number1c: saved.number1c ?? undefined,
        date1c: saved.date1c ?? undefined,
        sentTo1cAt: syncedAt,
        cancelRequestedAt: isCancelExport ? null : undefined,
        lastStatusSyncAt: syncedAt,
        lastSyncedAt: syncedAt,
        sourceUpdatedAt: syncedAt,
        lastExportError: null,
        last1cError: null,
        last1cSnapshot: asRecord(payload) ? (payload as Prisma.InputJsonValue) : undefined,
        exportAttempts: { increment: 1 },
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.ONEC_ACK,
      eventType: isCancelExport ? 'ONEC_ORDER_CANCEL_PUSH_OK' : 'ONEC_ORDER_PUSH_OK',
      payload: {
        requestId,
        transport,
        number1c: saved.number1c ?? null,
        date1c: saved.date1c?.toISOString() ?? null,
        documentGuid: saved.documentGuid ?? null,
        currentState: saved.currentState ?? null,
      } as Prisma.InputJsonValue,
    });
  });
}

async function markOrderExportFailure(order: QueuedOrderForExport, error: unknown, context?: ExportFailureContext) {
  const failedAt = new Date();
  const message = errorMessage(error).slice(0, 1000);
  const nextAttempts = (order.exportAttempts ?? 0) + 1;
  const debugPayload = context ? serializeDebugPayload(context.payload) : null;
  const isCancelExport = isCancelExportOrder(order);
  const isValidationError = error instanceof ClientOrderExportValidationError;

  await prisma.$transaction(async (tx) => {
    const current = await tx.order.findFirst({
      where: {
        id: order.id,
        status: isCancelExport ? OrderStatus.CANCELLED : OrderStatus.QUEUED,
        syncState: isCancelExport ? OrderSyncState.CANCEL_REQUESTED : OrderSyncState.QUEUED,
      },
      select: { revision: true },
    });
    if (!current) return;

    await tx.order.update({
      where: { id: order.id },
      data: {
        // Keep the operation exportable so the legacy 1C pull channel remains a reliable fallback.
        syncState: isValidationError
          ? OrderSyncState.ERROR
          : isCancelExport
            ? OrderSyncState.CANCEL_REQUESTED
            : OrderSyncState.QUEUED,
        exportAttempts: nextAttempts,
        lastExportError: message,
        last1cError: message,
        sourceUpdatedAt: failedAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: current.revision,
      source: OrderEventSource.SYSTEM,
      eventType: 'ONEC_ORDER_PUSH_ERROR',
      payload: {
        requestId: context?.requestId ?? null,
        transport: context?.transport ?? null,
        attempts: nextAttempts,
        willRetry: !isValidationError,
        nextRetryBackoffMs: isValidationError ? null : getBackoffMs(nextAttempts),
        error: message,
        validationError: isValidationError,
        itemErrors: isValidationError ? error.itemErrors : [],
        upstreamStatus: error instanceof OnecLpAppHttpError ? error.upstreamStatus : null,
        upstreamPayload: upstreamPayloadForDebug(error) as Prisma.InputJsonValue,
        requestSummary: context ? buildPayloadSummary(context.payload) : null,
        requestBodyBytes: debugPayload?.bytes ?? null,
        requestBodyTruncated: debugPayload?.truncated ?? null,
        requestBodyJson: debugPayload?.json ?? null,
      } as Prisma.InputJsonValue,
    });
  });
}

async function loadExportCandidates() {
  const take = Math.max(getBatchSize() * 3, getBatchSize());
  const orders = await prisma.order.findMany({
    where: {
      source: OrderSource.MANAGER_APP,
      OR: [
        { status: OrderStatus.QUEUED, syncState: OrderSyncState.QUEUED },
        { status: OrderStatus.CANCELLED, syncState: OrderSyncState.CANCEL_REQUESTED },
      ],
      guid: { not: null },
    },
    orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }],
    take,
    select: queuedOrderSelect,
  });

  const nowMs = Date.now();
  return orders.filter((order) => shouldAttempt(order, nowMs)).slice(0, getBatchSize());
}

async function exportOrder(order: QueuedOrderForExport) {
  const requestId = randomUUID();
  const payload = { ...buildQueuedOrderPayload(order), requestId };
  const releaseOrderLock = await acquireOrderLock(String(payload.guid));
  if (!releaseOrderLock) return;
  let transport: ExportFailureContext['transport'] = 'POST';

  try {
    validateOrderReadyForExport(order);
    await validateOrderStockBeforeExport(order);
    console.info('[client-orders-export-worker] pushing order to 1C', {
      requestId,
      guid: payload.guid,
      revision: payload.revision,
      attempts: order.exportAttempts,
      itemsCount: Array.isArray(payload.items) ? payload.items.length : 0,
    });

    let response: unknown;
    try {
      response = await postOnecLpAppClientOrder(payload);
    } catch (error) {
      if (error instanceof OnecLpAppHttpError && (error.upstreamStatus === 404 || error.upstreamStatus === 405)) {
        transport = 'PUT_FALLBACK';
        console.warn('[client-orders-export-worker] 1C POST endpoint unavailable, falling back to PUT by appGuid', {
          requestId,
          guid: payload.guid,
          status: error.upstreamStatus,
        });
        response = await putOnecLpAppClientOrder(String(payload.guid), payload);
      } else {
        throw error;
      }
    }
    await markOrderExportSuccess(order, response, requestId, transport);

    console.info('[client-orders-export-worker] order pushed to 1C', {
      requestId,
      guid: payload.guid,
      number1c: extractSavedOrder(response).number1c,
    });
  } catch (error) {
    throw new ClientOrderExportFailure(error, {
      requestId,
      transport,
      payload,
    });
  } finally {
    await releaseOrderLock();
  }
}

async function runOnce() {
  if (Date.now() < directPushPausedUntil) return;

  const release = await acquireLock();
  if (!release) return;

  try {
    const orders = await loadExportCandidates();
    if (orders.length === 0) return;

    for (const order of orders) {
      try {
        await exportOrder(order);
      } catch (error) {
        const originalError = error instanceof ClientOrderExportFailure ? error.cause : error;
        const context = error instanceof ClientOrderExportFailure ? error.context : undefined;
        console.error('[client-orders-export-worker] order push failed', {
          requestId: context?.requestId ?? null,
          guid: order.guid ?? order.id,
          error: errorMessage(originalError),
        });
        await markOrderExportFailure(order, originalError, context);
        if (pauseDirectPushIfNeeded(originalError)) break;
      }
    }
  } catch (error) {
    console.error('[client-orders-export-worker] run failed', error);
  } finally {
    await release();
  }
}

function scheduleNext() {
  if (!isStarted) return;
  timer = setTimeout(async () => {
    await runOnce();
    scheduleNext();
  }, getIntervalMs());
}

export function startClientOrdersExportWorker() {
  if (isStarted || process.env.CLIENT_ORDERS_EXPORT_WORKER_DISABLED === '1') return;
  isStarted = true;
  console.log('[client-orders-export-worker] started', {
    intervalMs: getIntervalMs(),
    batchSize: getBatchSize(),
    backoffBaseMs: envInt('CLIENT_ORDERS_EXPORT_BACKOFF_BASE_MS', DEFAULT_BACKOFF_BASE_MS, 1000),
    backoffMaxMs: envInt('CLIENT_ORDERS_EXPORT_BACKOFF_MAX_MS', DEFAULT_BACKOFF_MAX_MS, DEFAULT_BACKOFF_BASE_MS),
  });
  void runOnce();
  scheduleNext();
}

export function stopClientOrdersExportWorker() {
  isStarted = false;
  if (timer) clearTimeout(timer);
  if (wakeupTimer) clearTimeout(wakeupTimer);
  timer = null;
  wakeupTimer = null;
}

export function requestClientOrdersExportWakeup() {
  if (!isStarted || process.env.CLIENT_ORDERS_EXPORT_WORKER_DISABLED === '1') return;
  if (wakeupTimer) return;
  wakeupTimer = setTimeout(async () => {
    wakeupTimer = null;
    await runOnce();
  }, envInt('CLIENT_ORDERS_EXPORT_WAKEUP_DELAY_MS', 500, 0));
}
