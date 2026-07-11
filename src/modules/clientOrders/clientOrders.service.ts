import {
  ClientOrderDeliveryDateMode,
  OrderEventSource,
  OrderSource,
  OrderStatus,
  OrderSyncState,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../../prisma/client';
import { requestClientOrdersExportWakeup } from '../../services/clientOrdersExportWorker';
import { ErrorCodes } from '../../utils/apiResponse';
import { appendOrderEvent } from '../orders/orderEvents';
import { decimalToNumber, mapOrderDetail, orderDetailSelect, toDecimal } from '../orders/orderModel';
import { MarketplaceError } from '../marketplace/marketplace.service';
import {
  OnecLpAppConfigError,
  OnecLpAppHttpError,
  OnecLpAppNetworkError,
} from '../onec/onec.lpApp.client';
import {
  CLIENT_ORDERS_CACHE_TTL,
  ClientOrdersOnecCircuitOpenError,
  readThroughClientOrdersCache,
} from './clientOrders.cache';
import {
  cleanupProductImages,
  enrichOrderItemsWithImages,
  enrichProductsWithImages,
  getProductImagesStatus,
  syncProductImages,
} from './clientOrders.productImages';
import {
  findLiveAgreement,
  findLiveContract,
  findLiveCounterparty,
  findLiveDeliveryAddress,
  findLiveOrganization,
  findLivePriceType,
  findLiveWarehouse,
  getLiveAgreements,
  getLiveContracts,
  getLiveCounterparties,
  getLiveDeliveryAddresses,
  findLiveClientOrder,
  getLiveClientOrder,
  getLiveClientOrders,
  getLiveClientOrderDefaults,
  getLiveOrganizations,
  getLivePriceTypes,
  getLiveProducts,
  getLiveProductsByGuids,
  getLiveReferenceData,
  getLiveReferenceDetails,
  getLiveWarehouses,
  type LiveAgreement,
  type LiveContract,
  type LiveCounterparty,
  type LiveDeliveryAddress,
  type LiveClientOrder,
  type LiveClientOrderDefaults,
  type LiveOrganization,
  type LivePriceType,
  type LiveProduct,
  type LiveProductPackage,
  type LiveWarehouse,
} from './clientOrders.onecLive';
import type {
  ClientOrderCancelBody,
  ClientOrderCopyBody,
  ClientOrderCreateBody,
  ClientOrderDefaultsQuery,
  ClientOrderReferenceDetailsParams,
  ClientOrderRestoreBody,
  ClientOrderSettingsUpdateBody,
  ClientOrderSubmitBody,
  ClientOrderUnqueueBody,
  ClientOrderUpdateBody,
  ClientOrdersBatchProductsBody,
  ClientOrdersAgreementsQuery,
  ClientOrdersContractsQuery,
  ClientOrdersCounterpartiesQuery,
  ClientOrdersDeliveryAddressesQuery,
  ClientOrdersListQuery,
  ClientOrdersPriceTypesQuery,
  ClientOrdersProductsQuery,
  ClientOrdersReferenceDataQuery,
  ClientOrdersWarehousesQuery,
} from './clientOrders.schemas';

type ClientOrdersErrorCode =
  | ErrorCodes.NOT_FOUND
  | ErrorCodes.VALIDATION_ERROR
  | ErrorCodes.INTERNAL_ERROR
  | ErrorCodes.CONFLICT
  | ErrorCodes.FORBIDDEN;

type Tx = Prisma.TransactionClient;

type PagedResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore?: boolean;
};

type ManagerAwareProductsQuery = ClientOrdersProductsQuery & { managerGuid?: string | null };
type ManagerAwareBatchProductsBody = ClientOrdersBatchProductsBody & { managerGuid?: string | null };
type ReferenceDetailsRow = { label: string; value: unknown };
type ReferenceDetailsSection = { title: string; rows: ReferenceDetailsRow[] };

type ManagerOrderContext = {
  organization: { id: string; guid: string; name: string; code: string | null };
  counterparty: { id: string; guid: string; name: string };
  agreement: {
    id: string;
    guid: string;
    name: string;
    counterpartyId: string | null;
    contractId: string | null;
    warehouseId: string | null;
    priceTypeId: string | null;
    currency: string | null;
  } | null;
  contract: { id: string; guid: string; number: string; counterpartyId: string } | null;
  warehouse: { id: string; guid: string; name: string } | null;
  deliveryAddress: { id: string; guid: string | null; fullAddress: string; counterpartyId: string } | null;
  priceType: { id: string; guid: string; name: string } | null;
};

const DEFAULT_DELIVERY_DATE_MODE = ClientOrderDeliveryDateMode.NEXT_DAY;
const DEFAULT_DELIVERY_DATE_OFFSET_DAYS = 1;
const CLIENT_ORDER_PAYMENT_FORM_OPTIONS = [
  { code: null, name: 'Любая', label: 'Любая' },
  { code: 'Наличная', name: 'Наличная', label: 'Наличная' },
];
const CLIENT_ORDER_DELIVERY_METHOD_TO_CLIENT = 'ДоКлиента';
const CLIENT_ORDER_DELIVERY_METHOD_PICKUP = 'Самовывоз';
const CLIENT_ORDER_DELIVERY_METHOD_OPTIONS = [
  { code: CLIENT_ORDER_DELIVERY_METHOD_TO_CLIENT, name: CLIENT_ORDER_DELIVERY_METHOD_TO_CLIENT, label: 'Наша доставка' },
  { code: CLIENT_ORDER_DELIVERY_METHOD_PICKUP, name: CLIENT_ORDER_DELIVERY_METHOD_PICKUP, label: 'Самовывоз' },
];

function clientOrderPaymentFormOptions() {
  return CLIENT_ORDER_PAYMENT_FORM_OPTIONS.map((item) => ({ ...item }));
}

function clientOrderDeliveryMethodOptions() {
  return CLIENT_ORDER_DELIVERY_METHOD_OPTIONS.map((item) => ({ ...item }));
}

type PreparedOrderLine = {
  create: Prisma.OrderItemUncheckedCreateWithoutOrderInput;
  snapshot: Prisma.InputJsonObject;
};

type PreparedOrderPayload = {
  items: PreparedOrderLine[];
  totalAmount: Prisma.Decimal;
  generalDiscountAmount: Prisma.Decimal;
};

type DeliveryDateResolution = {
  resolvedDate: Date | null;
  issue: 'FIXED_DATE_REQUIRED' | 'FIXED_DATE_IN_PAST' | null;
};

type ReceiptPriceInfo = {
  value: number;
  minQty: number | null;
  priceType: { id: string; guid: string; name: string };
};

type ProductPriceLookupPair = {
  productId: string;
  priceTypeId: string;
};

const clientOrderSummarySelect = {
  id: true,
  guid: true,
  number1c: true,
  date1c: true,
  source: true,
  revision: true,
  syncState: true,
  status: true,
  comment: true,
  deliveryDate: true,
  paymentForm: true,
  deliveryMethod: true,
  totalAmount: true,
  currency: true,
  queuedAt: true,
  sentTo1cAt: true,
  lastStatusSyncAt: true,
  lastExportError: true,
  last1cError: true,
  isPostedIn1c: true,
  hasRealization: true,
  realizationDetectedAt: true,
  cancelRequestedAt: true,
  createdAt: true,
  updatedAt: true,
  counterparty: { select: { guid: true, name: true } },
  organization: { select: { guid: true, name: true, code: true, isActive: true } },
  warehouse: { select: { guid: true, name: true, code: true } },
  priceType: { select: { guid: true, name: true } },
  items: { where: { isCancelled: false }, select: { id: true } },
  _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

type ClientOrderSummaryRecord = Prisma.OrderGetPayload<{ select: typeof clientOrderSummarySelect }>;

function isOrderQueued(order: Pick<ClientOrderSummaryRecord, 'status' | 'syncState'>) {
  return order.syncState === OrderSyncState.QUEUED || order.syncState === OrderSyncState.CANCEL_REQUESTED;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function jsonNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function resolveActiveTrackingOrderSnapshot(tx: Tx, userId: number) {
  const activeRoute = await tx.userRoute.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      startedAt: true,
    },
  });
  if (!activeRoute) return null;

  const point = await tx.routePoint.findFirst({
    where: { userId, routeId: activeRoute.id },
    orderBy: { recordedAt: 'desc' },
    select: {
      id: true,
      routeId: true,
      latitude: true,
      longitude: true,
      recordedAt: true,
      recordedTimeZone: true,
      recordedTimezoneOffsetMinutes: true,
      eventType: true,
      accuracy: true,
      speed: true,
      heading: true,
      sequence: true,
    },
  });
  if (!point) return null;

  const snapshot: Prisma.InputJsonObject = {
    routeId: activeRoute.id,
    routeStartedAt: activeRoute.startedAt.toISOString(),
    routePointId: point.id,
    latitude: point.latitude,
    longitude: point.longitude,
    recordedAt: point.recordedAt.toISOString(),
    recordedTimeZone: point.recordedTimeZone ?? null,
    recordedTimezoneOffsetMinutes: point.recordedTimezoneOffsetMinutes ?? null,
    eventType: point.eventType,
    accuracy: point.accuracy ?? null,
    speed: point.speed ?? null,
    heading: point.heading ?? null,
    sequence: point.sequence ?? null,
    capturedAt: now().toISOString(),
  };

  return {
    routePointId: point.id,
    snapshot,
  };
}

export function normalizeClientOrderPublicError(value: unknown) {
  const message = String(value || '').trim();
  if (!message) return null;

  const lower = message.toLocaleLowerCase('ru');
  if (lower.includes('недостаточно доступного остатка') || lower.includes('не хватает остатка')) {
    return 'Недостаточно остатка по одной или нескольким позициям.';
  }

  if (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('1с недоступ') ||
    lower.includes('1c недоступ')
  ) {
    return '1С временно недоступна. Очередь повторит отправку автоматически.';
  }

  if (
    lower.includes('ошибка прямого push заказа') ||
    lower.includes('step=write-document') ||
    lower.includes('не удалось провести') ||
    lower.includes('http 500') ||
    lower.includes('непредвиденная ошибка')
  ) {
    return '1С не смогла провести заказ. Проверьте реквизиты, товары и остатки, затем отправьте повторно.';
  }

  if (
    lower.includes('errorid=') ||
    lower.includes('internal_error') ||
    lower.includes('поле объекта не обнаружено') ||
    lower.includes('метод объекта не обнаружен') ||
    lower.includes('stack') ||
    lower.includes('{')
  ) {
    return 'Документ требует проверки. Откройте заказ и отправьте повторно.';
  }

  return message.length > 300 ? `${message.slice(0, 297).trimEnd()}...` : message;
}

function latestExportValidationFromEvents(events: Array<{ eventType: string; payload: unknown }>) {
  for (const event of events) {
    if (event.eventType !== 'ONEC_ORDER_PUSH_ERROR') continue;
    const payload = jsonRecord(event.payload);
    if (!payload) continue;
    const itemErrors = Array.isArray(payload.itemErrors)
      ? payload.itemErrors.flatMap((item) => {
          const record = jsonRecord(item);
          const lineGuid = jsonString(record?.lineGuid);
          const message = jsonString(record?.message);
          if (!record || !lineGuid || !message) return [];
          return [{
            code: jsonString(record.code) ?? 'EXPORT_VALIDATION',
            lineGuid,
            productGuid: jsonString(record.productGuid),
            productName: jsonString(record.productName),
            requiredBase: jsonNumber(record.requiredBase),
            available: jsonNumber(record.available),
            message,
          }];
        })
      : [];
    const message = jsonString(payload.error);
    if (itemErrors.length || message) {
      return {
        message,
        itemErrors,
      };
    }
  }
  return null;
}

function queueMapKey(guid?: string | null) {
  return guid?.trim().toLowerCase() || '';
}

function normalizeLineGuid(value?: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}

function ensureLineGuid(value?: string | null) {
  return normalizeLineGuid(value) ?? randomUUID();
}

async function loadQueuedOrderPositions() {
  const rows = await prisma.order.findMany({
    where: {
      source: OrderSource.MANAGER_APP,
      syncState: { in: [OrderSyncState.QUEUED, OrderSyncState.CANCEL_REQUESTED] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { guid: true, queuedAt: true, createdAt: true, id: true },
  });
  rows.sort((a, b) => {
    const aTime = (a.queuedAt ?? a.createdAt).getTime();
    const bTime = (b.queuedAt ?? b.createdAt).getTime();
    return aTime - bTime || String(a.id).localeCompare(String(b.id));
  });
  return new Map(
    rows.flatMap((row, index) => {
      const key = queueMapKey(row.guid);
      return key ? [[key, index + 1] as const] : [];
    })
  );
}

function resolveQueuePosition(
  order: Pick<ClientOrderSummaryRecord, 'guid' | 'status' | 'syncState'>,
  queuePositions?: Map<string, number>
) {
  if (!isOrderQueued(order)) return null;
  return queuePositions?.get(queueMapKey(order.guid)) ?? null;
}

function mapClientOrderSummary(order: ClientOrderSummaryRecord, queuePositions?: Map<string, number>) {
  return {
    guid: order.guid,
    appGuid: order.guid,
    documentGuid: order.guid,
    number1c: order.number1c,
    date1c: order.date1c,
    source: order.source,
    origin: 'local',
    readOnly: order.hasRealization,
    readOnlyReason: order.hasRealization ? 'По заказу создана проведенная реализация товаров и услуг.' : null,
    revision: order.revision,
    syncState: order.syncState,
    status: order.status,
    queuePosition: resolveQueuePosition(order, queuePositions),
    comment: order.comment,
    deliveryDate: order.deliveryDate,
    paymentForm: order.paymentForm,
    deliveryMethod: order.deliveryMethod,
    totalAmount: decimalToNumber(order.totalAmount),
    currency: order.currency,
    queuedAt: order.queuedAt,
    sentTo1cAt: order.sentTo1cAt,
    lastStatusSyncAt: order.lastStatusSyncAt,
    lastExportError: normalizeClientOrderPublicError(order.lastExportError),
    last1cError: normalizeClientOrderPublicError(order.last1cError),
    isPostedIn1c: order.isPostedIn1c,
    hasRealization: order.hasRealization,
    realizationDetectedAt: order.realizationDetectedAt,
    cancelRequestedAt: order.cancelRequestedAt,
    counterparty: order.counterparty,
    organization: order.organization,
    warehouse: order.warehouse,
    priceType: order.priceType,
    itemsCount: order.items.length,
    items: [],
    events: [],
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

class ClientOrdersError extends Error {
  public readonly status: number;
  public readonly code: ClientOrdersErrorCode;

  constructor(status: number, code: ClientOrdersErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isOnecLpAppError(error: unknown) {
  return (
    error instanceof OnecLpAppHttpError ||
    error instanceof OnecLpAppNetworkError ||
    error instanceof OnecLpAppConfigError
  );
}

function formatOnecLpAppHttpError(error: OnecLpAppHttpError) {
  const errorIdMatch = error.message.match(/errorId=([^;\s]+)/i);
  if (errorIdMatch?.[1]) {
    return `1С вернула внутреннюю ошибку. Код для журнала 1С: ${errorIdMatch[1]}.`;
  }
  return `1С вернула HTTP ${error.upstreamStatus}: ${error.message}`;
}

function throwClientOrdersOnecError(error: unknown, message = '1С временно недоступна'): never {
  if (!isOnecLpAppError(error)) {
    throw error;
  }

  const detail =
    error instanceof OnecLpAppConfigError
      ? 'Не настроено подключение к 1С.'
      : error instanceof OnecLpAppNetworkError
        ? 'Не удалось подключиться к 1С.'
        : error instanceof OnecLpAppHttpError
          ? formatOnecLpAppHttpError(error)
          : 'Неизвестная ошибка 1С.';
  throw new ClientOrdersError(502, ErrorCodes.INTERNAL_ERROR, `${message}: ${detail}`);
}

async function onecLive<T>(
  operation: () => Promise<T>,
  message?: string,
  options: { allowCachedWhenCircuitOpen?: boolean } = {}
): Promise<T> {
  void options;

  try {
    const result = await operation();
    return result;
  } catch (error) {
    if (error instanceof ClientOrdersOnecCircuitOpenError) {
      throw new ClientOrdersError(
        502,
        ErrorCodes.INTERNAL_ERROR,
        `${message ?? '1С временно недоступна'}: недавняя ошибка подключения к 1С, повторите запрос через несколько секунд.`
      );
    }
    throwClientOrdersOnecError(error, message);
  }
}

function shouldOpenClientOrdersOnecCircuit(error: unknown) {
  if (error instanceof OnecLpAppHttpError) {
    return [502, 503, 504].includes(error.upstreamStatus);
  }
  return true;
}

const DEFAULT_ORDER_CURRENCY = 'RUB';
const SMART_SEARCH_TRIGRAM_THRESHOLD = 0.18;
const ACTIVE_CONTRACT_STATUS = 'Действует';
const CLOSED_AGREEMENT_STATUS = 'Закрыто';
const CLOSED_CONTRACT_STATUS = 'Закрыт';
const REALIZATION_CONTRACT_PURPOSE = 'Реализация';
const RECEIPT_PRICE_TYPE_TOKEN = '\u0446\u0435\u043d\u0430\u043f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u044f';
const now = () => new Date();

const agreementNotClosedWhere = (): Prisma.ClientAgreementWhereInput => ({
  OR: [{ status: null }, { status: { not: CLOSED_AGREEMENT_STATUS } }],
});

const contractSelectableWhere = (): Prisma.ClientContractWhereInput => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);

  return {
    status: ACTIVE_CONTRACT_STATUS,
    purpose: REALIZATION_CONTRACT_PURPOSE,
    OR: [{ validFrom: null }, { validFrom: { lte: endOfToday } }],
    AND: [{ OR: [{ validTo: null }, { validTo: { gte: today } }] }],
  };
};

const activeAgreementWhere = (): Prisma.ClientAgreementWhereInput => ({ isActive: true, AND: [agreementNotClosedWhere()] });
const activeContractWhere = (): Prisma.ClientContractWhereInput => ({ isActive: true, AND: [contractSelectableWhere()] });

function normalizedRu(value?: string | null) {
  return value?.trim().toLocaleLowerCase('ru') ?? '';
}

function isClosedAgreementStatus(status?: string | null) {
  return normalizedRu(status) === normalizedRu(CLOSED_AGREEMENT_STATUS);
}

function isClosedContractStatus(status?: string | null) {
  return normalizedRu(status) === normalizedRu(CLOSED_CONTRACT_STATUS);
}

function isActiveContractStatus(status?: string | null) {
  return normalizedRu(status) === normalizedRu(ACTIVE_CONTRACT_STATUS);
}

function isRealizationContractPurpose(purpose?: string | null) {
  const normalized = normalizedRu(purpose);
  return normalized === normalizedRu(REALIZATION_CONTRACT_PURPOSE) || normalized === 'спокупателем';
}

function parseDateOnly(value?: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isContractDateRangeActive(validFrom?: string | Date | null, validTo?: string | Date | null, at: Date = now()) {
  const today = new Date(at);
  today.setHours(0, 0, 0, 0);
  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);

  const from = parseDateOnly(validFrom);
  if (from && from > endOfToday) return false;

  const to = parseDateOnly(validTo);
  if (to && to < today) return false;

  return true;
}

function isSelectableContract(contract?: {
  isActive?: boolean | null;
  status?: string | null;
  purpose?: string | null;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
} | null) {
  if (!contract) return false;
  return (
    contract.isActive !== false &&
    isActiveContractStatus(contract.status) &&
    isRealizationContractPurpose(contract.purpose) &&
    isContractDateRangeActive(contract.validFrom, contract.validTo)
  );
}

function filterSelectableContracts<T extends {
  items: Array<{
    isActive?: boolean | null;
    status?: string | null;
    purpose?: string | null;
    validFrom?: string | Date | null;
    validTo?: string | Date | null;
  }>;
  total: number;
}>(result: T): T {
  const items = result.items.filter((item) => isSelectableContract(item));
  return { ...result, items, total: items.length };
}

function ensureEditable(order: { status: OrderStatus; hasRealization?: boolean | null; source: OrderSource }) {
  if (order.source !== OrderSource.MANAGER_APP) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Заказ менеджера не найден');
  }
  if (order.hasRealization) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'По заказу создана реализация товаров и услуг. Документ доступен только для чтения');
  }
}

function assertRevision(currentRevision: number, expectedRevision: number) {
  if (currentRevision !== expectedRevision) {
    throw new ClientOrdersError(
      409,
      ErrorCodes.CONFLICT,
      `Версия заказа устарела. Актуальная revision: ${currentRevision}`
    );
  }
}

function normalizeSearch(search?: string) {
  const trimmed = search?.trim();
  return trimmed ? trimmed : undefined;
}

function searchTokens(search?: string) {
  return normalizeSearch(search)
    ?.split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean) ?? [];
}

function buildReferenceWhere(includeInactive: boolean) {
  return includeInactive ? {} : { isActive: true };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likeSearchPatterns(search: string) {
  const lowered = search.toLowerCase();
  return {
    exact: lowered,
    prefix: `${escapeLike(lowered)}%`,
    contains: `%${escapeLike(lowered)}%`,
  };
}

function asNumberCount(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function isSmartSearchExtensionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('similarity') || message.includes('unaccent') || message.includes('pg_trgm');
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function defaultDeliveryDate() {
  return startOfDay(addDays(startOfDay(now()), DEFAULT_DELIVERY_DATE_OFFSET_DAYS));
}

function ensureValidDeliveryDateSettings(
  deliveryDateMode: ClientOrderDeliveryDateMode,
  deliveryDateOffsetDays: number,
  fixedDeliveryDate: Date | null
) {
  if (deliveryDateMode === ClientOrderDeliveryDateMode.OFFSET_DAYS && deliveryDateOffsetDays < 0) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Смещение даты отгрузки не может быть отрицательным');
  }
  if (deliveryDateMode === ClientOrderDeliveryDateMode.FIXED_DATE && !fixedDeliveryDate) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Для фиксированной даты нужно указать дату отгрузки');
  }
}

function resolveDeliveryDateSettings(settings?: {
  deliveryDateMode: ClientOrderDeliveryDateMode;
  deliveryDateOffsetDays: number;
  fixedDeliveryDate: Date | null;
} | null): DeliveryDateResolution {
  void settings;
  return {
    resolvedDate: defaultDeliveryDate(),
    issue: null,
  };
}

function formatDeliveryDateIssue(issue: DeliveryDateResolution['issue']) {
  switch (issue) {
    case 'FIXED_DATE_REQUIRED':
      return 'В настройках заказов клиентов не задана фиксированная дата отгрузки.';
    case 'FIXED_DATE_IN_PAST':
      return 'Фиксированная дата отгрузки в настройках уже в прошлом. Обновите настройки.';
    default:
      return null;
  }
}

function mapOrganizationSummary(organization: { guid: string; name: string; code: string | null } | null | undefined) {
  if (!organization) return null;
  return {
    guid: organization.guid,
    name: organization.name,
    code: organization.code,
  };
}

function mapAgreementSummary(
  agreement:
    | {
        guid: string;
        name: string;
        currency: string | null;
        organizationGuid?: string | null;
        organization?: { guid: string; name: string; code?: string | null } | null;
        managerGuid?: string | null;
        managerName?: string | null;
        manager?: { guid?: string | null; name?: string | null } | null;
        isActive?: boolean;
        contract?: { guid: string; number: string } | null;
        warehouse?: { guid: string; name: string } | null;
        priceType?: { guid: string; name: string } | null;
      }
    | null
    | undefined
) {
  if (!agreement) return null;
  return {
    guid: agreement.guid,
    name: agreement.name,
    currency: agreement.currency,
    organizationGuid: agreement.organizationGuid ?? agreement.organization?.guid ?? null,
    organization: agreement.organization ?? null,
    managerGuid: agreement.managerGuid ?? agreement.manager?.guid ?? null,
    managerName: agreement.managerName ?? agreement.manager?.name ?? null,
    manager: agreement.manager ?? (agreement.managerGuid || agreement.managerName ? { guid: agreement.managerGuid ?? null, name: agreement.managerName ?? null } : null),
    isActive: agreement.isActive ?? true,
    contract: agreement.contract ?? null,
    warehouse: agreement.warehouse ?? null,
    priceType: agreement.priceType ?? null,
  };
}

function mapContractSummary(
  contract:
    | {
        guid: string;
        number: string;
        date?: Date | string | null;
        validFrom?: Date | string | null;
        validTo?: Date | string | null;
        organizationGuid?: string | null;
        organization?: { guid: string; name: string; code?: string | null } | null;
        managerGuid?: string | null;
        managerName?: string | null;
        manager?: { guid?: string | null; name?: string | null } | null;
        status?: string | null;
        purpose?: string | null;
        isActive?: boolean;
      }
    | null
    | undefined
) {
  if (!contract) return null;
  return {
    guid: contract.guid,
    number: contract.number,
    date: contract.date ?? null,
    validFrom: contract.validFrom ?? null,
    validTo: contract.validTo ?? null,
    organizationGuid: contract.organizationGuid ?? contract.organization?.guid ?? null,
    organization: contract.organization ?? null,
    managerGuid: contract.managerGuid ?? contract.manager?.guid ?? null,
    managerName: contract.managerName ?? contract.manager?.name ?? null,
    manager: contract.manager ?? (contract.managerGuid || contract.managerName ? { guid: contract.managerGuid ?? null, name: contract.managerName ?? null } : null),
    status: contract.status ?? null,
    purpose: contract.purpose ?? null,
    isActive: contract.isActive ?? true,
  };
}

function mapWarehouseSummary(
  warehouse:
    | {
        guid: string;
        name: string;
        code?: string | null;
        isDefault?: boolean;
        isPickup?: boolean;
        isActive?: boolean;
      }
    | null
    | undefined
) {
  if (!warehouse) return null;
  return {
    guid: warehouse.guid,
    name: warehouse.name,
    code: warehouse.code ?? null,
    isDefault: warehouse.isDefault ?? false,
    isPickup: warehouse.isPickup ?? false,
    isActive: warehouse.isActive ?? true,
  };
}

function formatProductLabel(product: { guid: string; name?: string | null; code?: string | null }) {
  const code = product.code?.trim();
  const name = product.name?.trim();
  if (code && name) return `${name} (${code})`;
  return name || code || product.guid;
}

function mapDeliveryAddressSummary(
  address:
    | {
        guid: string | null;
        name?: string | null;
        fullAddress: string;
        deliveryNumber?: string | null;
        number?: string | null;
        comment?: string | null;
        deliveryComment?: string | null;
        kindName?: string | null;
        contactInfoKind?: string | null;
        isDefault?: boolean;
        isActive?: boolean;
      }
    | null
    | undefined
) {
  if (!address) return null;
  return {
    guid: address.guid,
    name: address.name ?? null,
    fullAddress: address.fullAddress,
    deliveryNumber: address.deliveryNumber ?? address.number ?? null,
    number: address.number ?? address.deliveryNumber ?? null,
    comment: address.comment ?? address.deliveryComment ?? null,
    deliveryComment: address.deliveryComment ?? address.comment ?? null,
    kindName: address.kindName ?? address.contactInfoKind ?? null,
    contactInfoKind: address.contactInfoKind ?? address.kindName ?? null,
    isDefault: address.isDefault ?? false,
    isActive: address.isActive ?? true,
  };
}

function pickFirst<T>(...values: Array<T | null | undefined>) {
  for (const value of values) {
    if (value) return value;
  }
  return null;
}

function formatBoolean(value?: boolean | null) {
  if (value === null || value === undefined) return null;
  return value ? 'Да' : 'Нет';
}

function formatDate(value?: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function compactRows(rows: ReferenceDetailsRow[]) {
  return rows.filter((row) => row.value !== null && row.value !== undefined && row.value !== '');
}

function section(title: string, rows: ReferenceDetailsRow[]): ReferenceDetailsSection | null {
  const nextRows = compactRows(rows);
  return nextRows.length ? { title, rows: nextRows } : null;
}

function sections(...items: Array<ReferenceDetailsSection | null>) {
  return items.filter(Boolean) as ReferenceDetailsSection[];
}

function relationLabel(value?: { name?: string | null; number?: string | null; fullAddress?: string | null; code?: string | null } | null) {
  if (!value) return null;
  return value.name || value.number || value.fullAddress || value.code || null;
}

function normalizeNamedToken(value?: string | null) {
  return value?.trim().toLocaleLowerCase('ru').replace(/\s+/g, '') ?? '';
}

function isReceiptPriceType(value?: { code?: string | null; name?: string | null } | null) {
  if (!value) return false;
  return normalizeNamedToken(value.code) === RECEIPT_PRICE_TYPE_TOKEN || normalizeNamedToken(value.name) === RECEIPT_PRICE_TYPE_TOKEN;
}

async function loadReceiptPriceInfoByProductId(
  client: Pick<Tx, 'priceType' | 'productPrice'>,
  productIds: string[],
  at: Date
) {
  const result = new Map<string, ReceiptPriceInfo>();
  if (!productIds.length) return result;

  const receiptPriceTypes = await client.priceType.findMany({
    where: { isActive: true },
    select: { id: true, guid: true, code: true, name: true },
  });
  const receiptPriceTypesById = new Map(receiptPriceTypes.filter(isReceiptPriceType).map((item) => [item.id, item]));
  const receiptPriceTypeIds = [...receiptPriceTypesById.keys()];
  if (!receiptPriceTypeIds.length) return result;

  const rows = await client.productPrice.findMany({
    where: {
      isActive: true,
      productId: { in: productIds },
      priceTypeId: { in: receiptPriceTypeIds },
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: at } }] },
        { OR: [{ endDate: null }, { endDate: { gte: at } }] },
      ],
    },
    orderBy: [
      { productId: 'asc' },
      { startDate: 'desc' },
      { sourceUpdatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    select: {
      productId: true,
      price: true,
      minQty: true,
      priceTypeId: true,
    },
  });

  for (const row of rows) {
    if (result.has(row.productId) || !row.priceTypeId) continue;
    const priceType = receiptPriceTypesById.get(row.priceTypeId);
    if (!priceType) continue;
    result.set(row.productId, {
      value: decimalToNumber(row.price) ?? 0,
      minQty: decimalToNumber(row.minQty),
      priceType: { id: priceType.id, guid: priceType.guid, name: priceType.name },
    });
  }

  return result;
}

async function loadProductPriceInfoByProductAndPriceTypeId(
  client: Pick<Tx, 'productPrice'>,
  pairs: ProductPriceLookupPair[],
  at: Date
) {
  const result = new Map<string, ReceiptPriceInfo>();
  const uniquePairs = Array.from(
    new Map(pairs.map((pair) => [`${pair.productId}|${pair.priceTypeId}`, pair])).values()
  );
  if (!uniquePairs.length) return result;

  const productIds = [...new Set(uniquePairs.map((pair) => pair.productId))];
  const priceTypeIds = [...new Set(uniquePairs.map((pair) => pair.priceTypeId))];
  const allowedKeys = new Set(uniquePairs.map((pair) => `${pair.productId}|${pair.priceTypeId}`));

  const rows = await client.productPrice.findMany({
    where: {
      isActive: true,
      productId: { in: productIds },
      priceTypeId: { in: priceTypeIds },
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: at } }] },
        { OR: [{ endDate: null }, { endDate: { gte: at } }] },
      ],
    },
    orderBy: [
      { productId: 'asc' },
      { priceTypeId: 'asc' },
      { startDate: 'desc' },
      { sourceUpdatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    select: {
      productId: true,
      price: true,
      minQty: true,
      priceTypeId: true,
      priceType: { select: { id: true, guid: true, name: true } },
    },
  });

  for (const row of rows) {
    if (!row.priceTypeId || !row.priceType) continue;
    const key = `${row.productId}|${row.priceTypeId}`;
    if (!allowedKeys.has(key) || result.has(key)) continue;
    result.set(key, {
      value: decimalToNumber(row.price) ?? 0,
      minQty: decimalToNumber(row.minQty),
      priceType: {
        id: row.priceType.id,
        guid: row.priceType.guid,
        name: row.priceType.name,
      },
    });
  }

  return result;
}

async function loadStockByProductIdForWarehouse(
  client: Pick<Tx, 'warehouse' | 'stockBalance'>,
  warehouseGuid: string | null | undefined,
  productIds: string[]
) {
  const result = new Map<string, { quantity: number | null; reserved: number | null; available: number | null }>();
  if (!warehouseGuid || !productIds.length) return result;

  const warehouse = await client.warehouse.findUnique({
    where: { guid: warehouseGuid },
    select: { id: true },
  });
  if (!warehouse) return result;

  const rows = await client.stockBalance.groupBy({
    by: ['productId'],
    where: { warehouseId: warehouse.id, productId: { in: productIds } },
    _sum: { quantity: true, reserved: true, available: true },
  });

  rows.forEach((item) => {
    result.set(item.productId, {
      quantity: decimalToNumber(item._sum.quantity),
      reserved: decimalToNumber(item._sum.reserved),
      available: decimalToNumber(item._sum.available),
    });
  });

  return result;
}

function referenceDetailsResponse(args: {
  kind: ClientOrderReferenceDetailsParams['kind'];
  guid: string;
  title: string;
  subtitle?: string | null;
  sections: ReferenceDetailsSection[];
  debug: unknown;
}) {
  return args;
}

async function fetchManagerOrderOrThrow(guid: string) {
  const order = await prisma.order.findFirst({
    where: { guid, source: OrderSource.MANAGER_APP },
    select: orderDetailSelect,
  });

  if (!order) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }

  return order;
}

async function loadOrganizationByGuid(tx: Tx, guid: string) {
  const organization = await tx.organization.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, code: true, isActive: true },
  });

  if (!organization) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Организация ${guid} не найдена`);
  }
  if (organization.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Организация ${guid} неактивна`);
  }

  return organization;
}

async function loadCounterpartyByGuid(tx: Tx, guid: string) {
  const counterparty = await tx.counterparty.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${guid} не найден`);
  }
  if (counterparty.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${guid} неактивен`);
  }

  return counterparty;
}

async function loadAgreementByGuid(tx: Tx, guid: string) {
  const agreement = await tx.clientAgreement.findUnique({
    where: { guid },
    select: {
      id: true,
      guid: true,
      name: true,
      counterpartyId: true,
      contractId: true,
      warehouseId: true,
      priceTypeId: true,
      currency: true,
      isActive: true,
      status: true,
    },
  });

  if (!agreement) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Соглашение ${guid} не найдено`);
  }
  if (agreement.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${guid} неактивно`);
  }

  if (isClosedAgreementStatus(agreement.status)) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${guid} закрыто и не может использоваться в заказе`);
  }

  return agreement;
}

async function loadContractByGuid(tx: Tx, guid: string) {
  const contract = await tx.clientContract.findUnique({
    where: { guid },
    select: {
      id: true,
      guid: true,
      number: true,
      counterpartyId: true,
      isActive: true,
      status: true,
      purpose: true,
      validFrom: true,
      validTo: true,
    },
  });

  if (!contract) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Договор ${guid} не найден`);
  }
  if (contract.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Договор ${guid} неактивен`);
  }

  if (isClosedContractStatus(contract.status)) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Договор ${guid} закрыт и не может использоваться в заказе`);
  }
  if (!isActiveContractStatus(contract.status) || !isRealizationContractPurpose(contract.purpose) || !isContractDateRangeActive(contract.validFrom, contract.validTo)) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Договор ${guid} не подходит для реализации или не действует`);
  }

  return contract;
}

async function loadWarehouseByGuid(tx: Tx, guid: string) {
  const warehouse = await tx.warehouse.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!warehouse) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Склад ${guid} не найден`);
  }
  if (warehouse.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Склад ${guid} неактивен`);
  }

  return warehouse;
}

async function loadDeliveryAddressByGuid(tx: Tx, guid: string) {
  const address = await tx.deliveryAddress.findFirst({
    where: { OR: [{ guid }, { id: guid }] },
    select: {
      id: true,
      guid: true,
      fullAddress: true,
      counterpartyId: true,
      isActive: true,
    },
  });

  if (!address) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Адрес доставки ${guid} не найден`);
  }
  if (address.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Адрес доставки ${guid} неактивен`);
  }

  return address;
}

async function loadPriceTypeById(tx: Tx, id: string) {
  const priceType = await tx.priceType.findUnique({
    where: { id },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!priceType) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Тип цены не найден');
  }
  if (priceType.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Тип цены ${priceType.guid} неактивен`);
  }

  return priceType;
}

async function loadPriceTypeByGuid(tx: Tx, guid: string) {
  const priceType = await tx.priceType.findUnique({
    where: { guid },
    select: { id: true, guid: true, name: true, isActive: true },
  });

  if (!priceType) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Тип цены ${guid} не найден`);
  }
  if (priceType.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Тип цены ${guid} неактивен`);
  }

  return priceType;
}

function parseLiveDate(value?: string | Date | null, fallback: Date | null = null) {
  if (!value) return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function safeLiveName(value: string | null | undefined, fallback: string) {
  const prepared = value?.trim();
  return prepared || fallback;
}

function normalizeLiveUnitToken(value?: string | null) {
  const token = String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/[().]/g, '')
    .replace(/\s+/g, '');
  if (!token) return '';
  if (['pce', 'pc', 'pcs', 'piece', 'pieces', 'шт', 'штука', 'штуки', 'штук'].includes(token)) return 'piece';
  if (['kg', 'kgs', 'кг', 'килограмм', 'килограмма', 'килограммы'].includes(token)) return 'kg';
  return token;
}

function liveUnitLabelIdentities(unit: LiveProductPackage['unit'] | LiveProduct['baseUnit']) {
  const labels = [
    normalizeLiveUnitToken(unit?.symbol),
    normalizeLiveUnitToken(unit?.name),
    normalizeLiveUnitToken(`${unit?.symbol ?? ''}${unit?.name ?? ''}`),
  ].filter(Boolean);
  return new Set(labels);
}

function sameLiveUnitIdentity(left: LiveProductPackage['unit'] | LiveProduct['baseUnit'], right: LiveProductPackage['unit'] | LiveProduct['baseUnit']) {
  const leftGuid = left?.guid?.trim().toLocaleLowerCase('ru');
  const rightGuid = right?.guid?.trim().toLocaleLowerCase('ru');
  if (leftGuid && rightGuid && leftGuid === rightGuid) return true;
  const leftLabels = liveUnitLabelIdentities(left);
  const rightLabels = liveUnitLabelIdentities(right);
  for (const label of leftLabels) {
    if (rightLabels.has(label)) return true;
  }
  return false;
}

function isLiveBaseUnitPackage(pack: LiveProductPackage, baseUnit: LiveProduct['baseUnit']) {
  if (!baseUnit) return false;
  const multiplier = Number(pack.multiplier ?? 1);
  const sameMultiplier = !Number.isFinite(multiplier) || multiplier <= 0 || Math.abs(multiplier - 1) < 0.000001;
  return sameMultiplier && (!pack.unit || sameLiveUnitIdentity(pack.unit, baseUnit));
}

function mapProductPackagesForClient(product: { baseUnit?: LiveProduct['baseUnit']; packages: Array<any> }) {
  return product.packages
    .filter((pack) => !isLiveBaseUnitPackage({ ...pack, multiplier: decimalToNumber(pack.multiplier) } as LiveProductPackage, product.baseUnit ?? null))
    .map((pack) => ({
      ...pack,
      multiplier: decimalToNumber(pack.multiplier),
    }));
}

async function upsertLiveOrganization(tx: Tx, item: LiveOrganization | null, sourceUpdatedAt: Date) {
  if (!item) return null;
  return tx.organization.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, code: true, isActive: true },
  });
}

async function upsertLiveCounterparty(tx: Tx, item: LiveCounterparty | null, sourceUpdatedAt: Date) {
  if (!item) return null;
  return tx.counterparty.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      fullName: item.fullName ?? null,
      inn: item.inn ?? null,
      kpp: item.kpp ?? null,
      phone: item.phone ?? null,
      email: item.email ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      fullName: item.fullName ?? null,
      inn: item.inn ?? null,
      kpp: item.kpp ?? null,
      phone: item.phone ?? null,
      email: item.email ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, isActive: true },
  });
}

async function upsertLiveWarehouse(tx: Tx, item: LiveWarehouse | null, sourceUpdatedAt: Date) {
  if (!item) return null;
  return tx.warehouse.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      address: item.address ?? null,
      isDefault: item.isDefault,
      isPickup: item.isPickup,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      address: item.address ?? null,
      isDefault: item.isDefault,
      isPickup: item.isPickup,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, isActive: true },
  });
}

async function upsertLivePriceType(
  tx: Tx,
  item: LivePriceType | { guid: string; name: string; code?: string | null; isActive?: boolean } | null,
  sourceUpdatedAt: Date
) {
  if (!item?.guid) return null;
  return tx.priceType.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      isActive: item.isActive ?? true,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      isActive: item.isActive ?? true,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, isActive: true },
  });
}

async function upsertLiveContract(
  tx: Tx,
  item: LiveContract | null,
  counterpartyId: string | null,
  organizationId: string | null,
  sourceUpdatedAt: Date
) {
  if (!item || !counterpartyId) return null;
  const date = parseLiveDate(item.date, sourceUpdatedAt) ?? sourceUpdatedAt;
  const isActive = isSelectableContract(item);
  return tx.clientContract.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      counterpartyId,
      organizationId,
      name: item.name ?? item.number,
      number: safeLiveName(item.number, item.guid),
      date,
      validFrom: parseLiveDate(item.validFrom),
      validTo: parseLiveDate(item.validTo),
      currency: item.currency ?? null,
      status: item.status ?? null,
      purpose: item.purpose ?? null,
      isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      counterpartyId,
      organizationId,
      name: item.name ?? item.number,
      number: safeLiveName(item.number, item.guid),
      date,
      validFrom: parseLiveDate(item.validFrom),
      validTo: parseLiveDate(item.validTo),
      currency: item.currency ?? null,
      status: item.status ?? null,
      purpose: item.purpose ?? null,
      isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, number: true, counterpartyId: true, isActive: true, status: true, purpose: true, validFrom: true, validTo: true },
  });
}

async function upsertLiveAgreement(
  tx: Tx,
  item: LiveAgreement | null,
  counterpartyId: string | null,
  organizationId: string | null,
  contractId: string | null,
  warehouseId: string | null,
  priceTypeId: string | null,
  sourceUpdatedAt: Date
) {
  if (!item) return null;
  return tx.clientAgreement.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      number: item.number ?? null,
      date: parseLiveDate(item.date),
      counterpartyId,
      organizationId,
      contractId,
      warehouseId,
      priceTypeId,
      currency: item.currency ?? DEFAULT_ORDER_CURRENCY,
      status: item.status ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      number: item.number ?? null,
      date: parseLiveDate(item.date),
      counterpartyId,
      organizationId,
      contractId,
      warehouseId,
      priceTypeId,
      currency: item.currency ?? DEFAULT_ORDER_CURRENCY,
      status: item.status ?? null,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: {
      id: true,
      guid: true,
      name: true,
      counterpartyId: true,
      contractId: true,
      warehouseId: true,
      priceTypeId: true,
      currency: true,
      isActive: true,
      status: true,
    },
  });
}

async function upsertLiveDeliveryAddress(
  tx: Tx,
  item: LiveDeliveryAddress | null,
  counterpartyId: string | null,
  sourceUpdatedAt: Date
) {
  if (!item?.guid || !counterpartyId) return null;
  return tx.deliveryAddress.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      counterpartyId,
      name: item.name ?? null,
      fullAddress: safeLiveName(item.fullAddress, item.guid),
      isDefault: item.isDefault,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      counterpartyId,
      name: item.name ?? null,
      fullAddress: safeLiveName(item.fullAddress, item.guid),
      isDefault: item.isDefault,
      isActive: item.isActive,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, fullAddress: true, counterpartyId: true, isActive: true },
  });
}

async function upsertLiveUnit(
  tx: Tx,
  unit: { guid?: string | null; name?: string | null; symbol?: string | null } | null | undefined,
  fallbackGuid: string,
  sourceUpdatedAt: Date
) {
  const guid = unit?.guid?.trim() || fallbackGuid;
  const name = safeLiveName(unit?.name, unit?.symbol || 'шт');
  return tx.unit.upsert({
    where: { guid },
    create: {
      guid,
      name,
      code: unit?.symbol ?? null,
      symbol: unit?.symbol ?? name,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name,
      code: unit?.symbol ?? null,
      symbol: unit?.symbol ?? name,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, symbol: true },
  });
}

async function upsertLiveProductPrice(
  tx: Tx,
  productId: string,
  priceType: LivePriceType | { guid: string; name: string; code?: string | null } | null,
  price: number | null | undefined,
  currency: string | null | undefined,
  sourceUpdatedAt: Date,
  minQty = 1
) {
  if (!priceType || price === null || price === undefined) return;
  const materializedPriceType = await upsertLivePriceType(tx, priceType, sourceUpdatedAt);
  if (!materializedPriceType) return;

  const startDate = new Date(0);
  await tx.productPrice.upsert({
    where: {
      productId_priceTypeId_startDate: {
        productId,
        priceTypeId: materializedPriceType.id,
        startDate,
      },
    },
    create: {
      productId,
      priceTypeId: materializedPriceType.id,
      price: toDecimal(price)!,
      currency: currency ?? DEFAULT_ORDER_CURRENCY,
      startDate,
      minQty: toDecimal(minQty),
      isActive: true,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      price: toDecimal(price)!,
      currency: currency ?? DEFAULT_ORDER_CURRENCY,
      minQty: toDecimal(minQty),
      isActive: true,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
  });
}

async function upsertLiveProduct(tx: Tx, item: LiveProduct | null, warehouseId: string | null, sourceUpdatedAt: Date) {
  if (!item) return null;
  const baseUnit = await upsertLiveUnit(tx, item.baseUnit, `default-unit-${item.guid}`, sourceUpdatedAt);
  const product = await tx.product.upsert({
    where: { guid: item.guid },
    create: {
      guid: item.guid,
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      article: item.article ?? null,
      sku: item.sku ?? null,
      isWeight: item.isWeight,
      isActive: item.isActive,
      baseUnitId: baseUnit.id,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    update: {
      name: safeLiveName(item.name, item.guid),
      code: item.code ?? null,
      article: item.article ?? null,
      sku: item.sku ?? null,
      isWeight: item.isWeight,
      isActive: item.isActive,
      baseUnitId: baseUnit.id,
      sourceUpdatedAt,
      lastSyncedAt: sourceUpdatedAt,
    },
    select: { id: true, guid: true, name: true, code: true, article: true, isActive: true },
  });

  for (const pack of item.packages) {
    if (!pack.guid) continue;
    if (isLiveBaseUnitPackage(pack, item.baseUnit)) {
      await tx.productPackage.deleteMany({ where: { productId: product.id, guid: pack.guid } });
      continue;
    }
    const unit = await upsertLiveUnit(tx, pack.unit ?? item.baseUnit, `default-unit-${item.guid}`, sourceUpdatedAt);
    await tx.productPackage.upsert({
      where: { guid: pack.guid },
      create: {
        guid: pack.guid,
        productId: product.id,
        unitId: unit.id,
        name: safeLiveName(pack.name, pack.guid),
        multiplier: toDecimal(pack.multiplier ?? 1)!,
        isDefault: pack.isDefault,
        sourceUpdatedAt,
        lastSyncedAt: sourceUpdatedAt,
      },
      update: {
        productId: product.id,
        unitId: unit.id,
        name: safeLiveName(pack.name, pack.guid),
        multiplier: toDecimal(pack.multiplier ?? 1)!,
        isDefault: pack.isDefault,
        sourceUpdatedAt,
        lastSyncedAt: sourceUpdatedAt,
      },
    });
  }

  await upsertLiveProductPrice(tx, product.id, item.priceType, item.basePrice, item.currency, sourceUpdatedAt);
  await upsertLiveProductPrice(
    tx,
    product.id,
    { guid: 'receipt-price-type', name: 'ЦенаПоступления', code: 'ЦенаПоступления' },
    item.receiptPrice,
    item.currency,
    sourceUpdatedAt
  );

  if (warehouseId && item.stock) {
    const sharedAvailable = item.stock.freeAvailable ?? item.stock.available ?? null;
    const sharedQuantity = item.stock.quantity ?? sharedAvailable ?? 0;
    await tx.stockBalance.upsert({
      where: { syncKey: `${warehouseId}|${product.id}` },
      create: {
        syncKey: `${warehouseId}|${product.id}`,
        productId: product.id,
        warehouseId,
        quantity: toDecimal(sharedQuantity)!,
        reserved: item.stock.reserved !== null && item.stock.reserved !== undefined ? toDecimal(item.stock.reserved) : null,
        available: sharedAvailable !== null && sharedAvailable !== undefined ? toDecimal(sharedAvailable) : null,
        updatedAt: sourceUpdatedAt,
        sourceUpdatedAt,
        lastSyncedAt: sourceUpdatedAt,
      },
      update: {
        quantity: toDecimal(sharedQuantity)!,
        reserved: item.stock.reserved !== null && item.stock.reserved !== undefined ? toDecimal(item.stock.reserved) : null,
        available: sharedAvailable !== null && sharedAvailable !== undefined ? toDecimal(sharedAvailable) : null,
        updatedAt: sourceUpdatedAt,
        sourceUpdatedAt,
        lastSyncedAt: sourceUpdatedAt,
      },
    });
  }

  return product;
}

type LiveOrderMaterialization = {
  organization: LiveOrganization | null;
  counterparty: LiveCounterparty | null;
  agreement: LiveAgreement | null;
  contract: LiveContract | null;
  warehouse: LiveWarehouse | null;
  deliveryAddress: LiveDeliveryAddress | null;
  explicitPriceTypes: LivePriceType[];
  products: LiveProduct[];
  productsSource: 'live' | 'local-fallback';
};

async function loadLiveReferenceWithCache<T>(
  operation: () => Promise<T | null>,
  fallback: () => Promise<T | null>,
  message: string
) {
  try {
    const liveValue = await operation();
    if (liveValue) return liveValue;
  } catch (error) {
    if (error instanceof ClientOrdersOnecCircuitOpenError) {
      return fallback();
    }
    if (!isOnecLpAppError(error)) throw error;
    const cachedValue = await fallback();
    if (cachedValue) return cachedValue;
    throwClientOrdersOnecError(error, message);
  }

  return fallback();
}

async function loadLiveDeliveryAddressForOrderMaterialization(guid: string, counterpartyGuid: string) {
  try {
    const liveValue = await findLiveDeliveryAddress(guid, counterpartyGuid);
    if (liveValue) return liveValue;
  } catch (error) {
    if (error instanceof ClientOrdersOnecCircuitOpenError) {
      return findCachedDeliveryAddress(guid);
    }
    if (!isOnecLpAppError(error)) throw error;
    const cachedValue = await findCachedDeliveryAddress(guid);
    if (cachedValue) return cachedValue;
    throwClientOrdersOnecError(error, 'Ошибка получения адреса доставки из 1С');
  }

  throw new ClientOrdersError(
    400,
    ErrorCodes.VALIDATION_ERROR,
    'Адрес доставки не найден в 1С. Обновите список адресов и выберите адрес заново.'
  );
}

async function findCachedOrganization(guid: string): Promise<LiveOrganization | null> {
  const item = await prisma.organization.findUnique({
    where: { guid },
    select: { guid: true, name: true, code: true, isActive: true },
  });
  return item ? { guid: item.guid, name: item.name, code: item.code, isActive: item.isActive } : null;
}

async function findCachedCounterparty(guid: string): Promise<LiveCounterparty | null> {
  const item = await prisma.counterparty.findUnique({
    where: { guid },
    select: {
      guid: true,
      name: true,
      fullName: true,
      inn: true,
      kpp: true,
      phone: true,
      email: true,
      isActive: true,
    },
  });
  return item
    ? {
        guid: item.guid,
        name: item.name,
        fullName: item.fullName,
        inn: item.inn,
        kpp: item.kpp,
        phone: item.phone,
        email: item.email,
        isActive: item.isActive,
      }
    : null;
}

async function findCachedWarehouse(guid: string): Promise<LiveWarehouse | null> {
  const item = await prisma.warehouse.findUnique({
    where: { guid },
    select: { guid: true, name: true, code: true, address: true, isDefault: true, isPickup: true, isActive: true },
  });
  return item
    ? {
        guid: item.guid,
        name: item.name,
        code: item.code,
        address: item.address,
        isDefault: item.isDefault,
        isPickup: item.isPickup,
        isActive: item.isActive,
      }
    : null;
}

async function findCachedPriceType(guid: string): Promise<LivePriceType | null> {
  const item = await prisma.priceType.findUnique({
    where: { guid },
    select: { guid: true, name: true, code: true, isActive: true },
  });
  return item ? { guid: item.guid, name: item.name, code: item.code, isActive: item.isActive } : null;
}

async function findCachedContract(guid: string): Promise<LiveContract | null> {
  const item = await prisma.clientContract.findUnique({
    where: { guid },
    select: {
      guid: true,
      number: true,
      name: true,
      date: true,
      validFrom: true,
      validTo: true,
      status: true,
      purpose: true,
      currency: true,
      managerGuid: true,
      isActive: true,
      counterparty: { select: { guid: true } },
      organization: { select: { guid: true, name: true, code: true } },
    },
  });
  return item
    ? {
        guid: item.guid,
        number: item.number,
        name: item.name,
        date: item.date,
        validFrom: item.validFrom,
        validTo: item.validTo,
        counterpartyGuid: item.counterparty?.guid ?? null,
        organizationGuid: item.organization?.guid ?? null,
        organization: item.organization,
        managerGuid: item.managerGuid,
        managerName: null,
        manager: item.managerGuid ? { guid: item.managerGuid, name: null } : null,
        status: item.status,
        purpose: item.purpose,
        currency: item.currency,
        isActive: item.isActive,
      }
    : null;
}

async function findCachedAgreement(guid: string): Promise<LiveAgreement | null> {
  const item = await prisma.clientAgreement.findUnique({
    where: { guid },
    select: {
      guid: true,
      name: true,
      number: true,
      date: true,
      currency: true,
      status: true,
      managerGuid: true,
      isActive: true,
      counterparty: { select: { guid: true } },
      organization: { select: { guid: true, name: true, code: true } },
      contract: { select: { guid: true, number: true } },
      warehouse: { select: { guid: true, name: true } },
      priceType: { select: { guid: true, name: true } },
    },
  });
  return item
    ? {
        guid: item.guid,
        name: item.name,
        number: item.number,
        date: item.date,
        counterpartyGuid: item.counterparty?.guid ?? null,
        organizationGuid: item.organization?.guid ?? null,
        organization: item.organization,
        managerGuid: item.managerGuid,
        managerName: null,
        manager: item.managerGuid ? { guid: item.managerGuid, name: null } : null,
        contractGuid: item.contract?.guid ?? null,
        warehouseGuid: item.warehouse?.guid ?? null,
        priceTypeGuid: item.priceType?.guid ?? null,
        currency: item.currency,
        status: item.status,
        isActive: item.isActive,
        contract: item.contract,
        warehouse: item.warehouse,
        priceType: item.priceType,
      }
    : null;
}

async function findCachedDeliveryAddress(guid: string): Promise<LiveDeliveryAddress | null> {
  const item = await prisma.deliveryAddress.findUnique({
    where: { guid },
    select: {
      guid: true,
      name: true,
      fullAddress: true,
      isDefault: true,
      isActive: true,
      counterparty: { select: { guid: true } },
    },
  });
  return item
    ? {
        guid: item.guid,
        name: item.name,
        fullAddress: item.fullAddress,
        counterpartyGuid: item.counterparty.guid,
        isDefault: item.isDefault,
        isActive: item.isActive,
      }
    : null;
}

async function loadLiveProductsForOrderMaterialization(
  body: ClientOrderCreateBody,
  productGuids: string[],
  managerGuid?: string | null
): Promise<{ products: LiveProduct[]; source: LiveOrderMaterialization['productsSource'] }> {
  const batchBody: ManagerAwareBatchProductsBody = {
    productGuids,
    organizationGuid: body.organizationGuid,
    counterpartyGuid: body.counterpartyGuid,
    agreementGuid: body.agreementGuid ?? undefined,
    warehouseGuid: body.warehouseGuid ?? undefined,
    priceTypeGuid: body.priceTypeGuid ?? undefined,
    managerGuid: managerGuid ?? undefined,
  };
  try {
    const products = await readThroughClientOrdersCache(
      'products:batch',
      {
        ...batchBody,
        productGuids: productGuids.slice().sort(),
      },
      CLIENT_ORDERS_CACHE_TTL.productsBatch,
      () => getLiveProductsByGuids(batchBody),
      { shouldOpenCircuit: shouldOpenClientOrdersOnecCircuit }
    );

    return { products: products.filter(Boolean), source: 'live' };
  } catch (error) {
    if (error instanceof ClientOrdersOnecCircuitOpenError || isOnecLpAppError(error)) {
      return { products: [], source: 'local-fallback' };
    }
    throw error;
  }
}

async function loadLiveOrderMaterialization(
  body: ClientOrderCreateBody,
  managerGuid?: string | null
): Promise<LiveOrderMaterialization> {
  const explicitPriceTypeGuids = [
    ...new Set(
      [body.priceTypeGuid, ...body.items.map((item) => item.priceTypeGuid)].filter(Boolean) as string[]
    ),
  ];
  const productGuids = [...new Set(body.items.map((item) => item.productGuid))];
  const [organization, counterparty, agreement, contract, warehouse, deliveryAddress, explicitPriceTypes, productsResult] =
    await Promise.all([
      loadLiveReferenceWithCache(
        () => readThroughClientOrdersCache(
          'reference:organization',
          { guid: body.organizationGuid },
          CLIENT_ORDERS_CACHE_TTL.referenceDetails,
          () => findLiveOrganization(body.organizationGuid)
        ),
        () => findCachedOrganization(body.organizationGuid),
        'Ошибка получения организации из 1С'
      ),
      loadLiveReferenceWithCache(
        () => readThroughClientOrdersCache(
          'reference:counterparty',
          { guid: body.counterpartyGuid },
          CLIENT_ORDERS_CACHE_TTL.referenceDetails,
          () => findLiveCounterparty(body.counterpartyGuid)
        ),
        () => findCachedCounterparty(body.counterpartyGuid),
        'Ошибка получения контрагента из 1С'
      ),
      body.agreementGuid
        ? loadLiveReferenceWithCache(
            () => readThroughClientOrdersCache(
              'reference:agreement',
              { guid: body.agreementGuid, counterpartyGuid: body.counterpartyGuid },
              CLIENT_ORDERS_CACHE_TTL.referenceDetails,
              () => findLiveAgreement(body.agreementGuid!, body.counterpartyGuid)
            ),
            () => findCachedAgreement(body.agreementGuid!),
            'Ошибка получения соглашения из 1С'
          )
        : Promise.resolve(null),
      body.contractGuid
        ? loadLiveReferenceWithCache(
            () => readThroughClientOrdersCache(
              'reference:contract',
              { guid: body.contractGuid, counterpartyGuid: body.counterpartyGuid },
              CLIENT_ORDERS_CACHE_TTL.referenceDetails,
              () => findLiveContract(body.contractGuid!, body.counterpartyGuid)
            ),
            () => findCachedContract(body.contractGuid!),
            'Ошибка получения договора из 1С'
          )
        : Promise.resolve(null),
      body.warehouseGuid
        ? loadLiveReferenceWithCache(
            () => readThroughClientOrdersCache(
              'reference:warehouse',
              { guid: body.warehouseGuid },
              CLIENT_ORDERS_CACHE_TTL.referenceDetails,
              () => findLiveWarehouse(body.warehouseGuid!)
            ),
            () => findCachedWarehouse(body.warehouseGuid!),
            'Ошибка получения склада из 1С'
          )
        : Promise.resolve(null),
      body.deliveryAddressGuid
        ? loadLiveDeliveryAddressForOrderMaterialization(body.deliveryAddressGuid, body.counterpartyGuid)
        : Promise.resolve(null),
      Promise.all(
        explicitPriceTypeGuids.map((guid) =>
          loadLiveReferenceWithCache(
            () => readThroughClientOrdersCache(
              'reference:price-type',
              { guid },
              CLIENT_ORDERS_CACHE_TTL.referenceDetails,
              () => findLivePriceType(guid)
            ),
            () => findCachedPriceType(guid),
            'Ошибка получения вида цены из 1С'
          )
        )
      ),
      loadLiveProductsForOrderMaterialization(body, productGuids, managerGuid),
    ]);

  return {
    organization,
    counterparty,
    agreement,
    contract,
    warehouse,
    deliveryAddress,
    explicitPriceTypes: explicitPriceTypes.filter(Boolean) as LivePriceType[],
    products: productsResult.products,
    productsSource: productsResult.source,
  };
}

async function materializeLiveOrderReferences(tx: Tx, data: LiveOrderMaterialization, body: ClientOrderCreateBody, sourceUpdatedAt: Date) {
  const organization = await upsertLiveOrganization(tx, data.organization, sourceUpdatedAt);
  const counterparty = await upsertLiveCounterparty(tx, data.counterparty, sourceUpdatedAt);
  const warehouse = await upsertLiveWarehouse(tx, data.warehouse, sourceUpdatedAt);

  const materializedPriceTypeGuids = new Set<string>();
  for (const priceType of [
    ...data.explicitPriceTypes,
    ...data.products.map((product) => product.priceType).filter(Boolean) as LivePriceType[],
  ]) {
    if (materializedPriceTypeGuids.has(priceType.guid)) continue;
    materializedPriceTypeGuids.add(priceType.guid);
    await upsertLivePriceType(tx, priceType, sourceUpdatedAt);
  }

  const agreementPriceType = data.agreement?.priceType ?? null;
  const materializedAgreementPriceType = await upsertLivePriceType(tx, agreementPriceType, sourceUpdatedAt);
  const agreementWarehouse =
    !warehouse && data.agreement?.warehouseGuid
      ? await upsertLiveWarehouse(
          tx,
          data.agreement.warehouse
            ? {
                guid: data.agreement.warehouse.guid,
                name: data.agreement.warehouse.name,
                code: null,
                isDefault: false,
                isPickup: false,
                isActive: true,
              }
            : null,
          sourceUpdatedAt
        )
      : warehouse;
  const contract = await upsertLiveContract(
    tx,
    data.contract,
    counterparty?.id ?? null,
    organization?.id ?? null,
    sourceUpdatedAt
  );
  await upsertLiveAgreement(
    tx,
    data.agreement,
    counterparty?.id ?? null,
    organization?.id ?? null,
    contract?.id ?? null,
    agreementWarehouse?.id ?? warehouse?.id ?? null,
    materializedAgreementPriceType?.id ?? null,
    sourceUpdatedAt
  );
  await upsertLiveDeliveryAddress(tx, data.deliveryAddress, counterparty?.id ?? null, sourceUpdatedAt);

  const effectiveWarehouse = warehouse ?? agreementWarehouse;
  for (const product of data.products) {
    await upsertLiveProduct(tx, product, effectiveWarehouse?.id ?? null, sourceUpdatedAt);
  }

  if (data.productsSource === 'live') {
    const missingProduct = body.items.find((item) => !data.products.some((product) => product.guid === item.productGuid));
    if (missingProduct) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Товар ${missingProduct.productGuid} не найден в 1С`);
    }
  }
}

async function materializeLiveDefaultsReferences(defaults: LiveClientOrderDefaults) {
  const sourceUpdatedAt = now();
  await prisma.$transaction(async (tx) => {
    const organization = await upsertLiveOrganization(tx, defaults.organization, sourceUpdatedAt);
    const counterparty = await upsertLiveCounterparty(tx, defaults.counterparty, sourceUpdatedAt);
    const warehouse = await upsertLiveWarehouse(tx, defaults.warehouse, sourceUpdatedAt);
    const agreementPriceType = await upsertLivePriceType(tx, defaults.priceType ?? defaults.agreement?.priceType ?? null, sourceUpdatedAt);
    const contract = await upsertLiveContract(
      tx,
      defaults.contract,
      counterparty?.id ?? null,
      organization?.id ?? null,
      sourceUpdatedAt
    );
    await upsertLiveAgreement(
      tx,
      defaults.agreement,
      counterparty?.id ?? null,
      organization?.id ?? null,
      contract?.id ?? null,
      warehouse?.id ?? null,
      agreementPriceType?.id ?? null,
      sourceUpdatedAt
    );
    await upsertLiveDeliveryAddress(tx, defaults.deliveryAddress, counterparty?.id ?? null, sourceUpdatedAt);
  });
}

async function resolveManagerOrderContext(tx: Tx, body: ClientOrderCreateBody): Promise<ManagerOrderContext> {
  const [organization, counterparty, agreement, contract, warehouse, deliveryAddress, explicitPriceType] = await Promise.all([
    loadOrganizationByGuid(tx, body.organizationGuid),
    loadCounterpartyByGuid(tx, body.counterpartyGuid),
    body.agreementGuid ? loadAgreementByGuid(tx, body.agreementGuid) : Promise.resolve(null),
    body.contractGuid ? loadContractByGuid(tx, body.contractGuid) : Promise.resolve(null),
    body.warehouseGuid ? loadWarehouseByGuid(tx, body.warehouseGuid) : Promise.resolve(null),
    body.deliveryAddressGuid ? loadDeliveryAddressByGuid(tx, body.deliveryAddressGuid) : Promise.resolve(null),
    body.priceTypeGuid ? loadPriceTypeByGuid(tx, body.priceTypeGuid) : Promise.resolve(null),
  ]);

  if (agreement?.counterpartyId && agreement.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Соглашение не принадлежит выбранному контрагенту');
  }

  if (contract?.counterpartyId !== undefined && contract.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не принадлежит выбранному контрагенту');
  }
  if (agreement?.contractId && contract && agreement.contractId !== contract.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не соответствует выбранному соглашению');
  }

  if (agreement?.warehouseId && warehouse && agreement.warehouseId !== warehouse.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Склад не соответствует выбранному соглашению');
  }

  if (deliveryAddress && deliveryAddress.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Адрес доставки не принадлежит выбранному контрагенту');
  }

  const agreementPriceTypeId = agreement?.priceTypeId ?? null;
  const agreementPriceType = agreementPriceTypeId ? await loadPriceTypeById(tx, agreementPriceTypeId) : null;
  const priceType = explicitPriceType ?? agreementPriceType;

  return {
    organization: {
      id: organization.id,
      guid: organization.guid,
      name: organization.name,
      code: organization.code ?? null,
    },
    counterparty: { id: counterparty.id, guid: counterparty.guid, name: counterparty.name },
    agreement: agreement
      ? {
          id: agreement.id,
          guid: agreement.guid,
          name: agreement.name,
          counterpartyId: agreement.counterpartyId,
          contractId: agreement.contractId,
          warehouseId: agreement.warehouseId,
          priceTypeId: agreement.priceTypeId,
          currency: agreement.currency,
        }
      : null,
    contract: contract
      ? {
          id: contract.id,
          guid: contract.guid,
          number: contract.number,
          counterpartyId: contract.counterpartyId,
        }
      : null,
    warehouse: warehouse ? { id: warehouse.id, guid: warehouse.guid, name: warehouse.name } : null,
    deliveryAddress: deliveryAddress
      ? {
          id: deliveryAddress.id,
          guid: deliveryAddress.guid ?? null,
          fullAddress: deliveryAddress.fullAddress,
          counterpartyId: deliveryAddress.counterpartyId,
        }
      : null,
    priceType: priceType ? { id: priceType.id, guid: priceType.guid, name: priceType.name } : null,
  };
}

async function prepareOrderItems(
  tx: Tx,
  body: ClientOrderCreateBody,
  context: ManagerOrderContext,
  sourceUpdatedAt: Date
): Promise<PreparedOrderPayload> {
  const preparedItems: PreparedOrderLine[] = [];
  let totalAmount = new Prisma.Decimal(0);
  let generalDiscountAmount = new Prisma.Decimal(0);
  const generalDiscountPercent = body.generalDiscountPercent ?? null;
  const usedLineGuids = new Set<string>();
  const productGuids = [...new Set(body.items.map((item) => item.productGuid))];
  const products = await tx.product.findMany({
    where: { guid: { in: productGuids } },
    select: {
      id: true,
      guid: true,
      name: true,
      code: true,
      article: true,
      isActive: true,
      isWeight: true,
      baseUnit: { select: { id: true, guid: true, name: true, symbol: true } },
    },
  });
  const productByGuid = new Map(products.map((product) => [product.guid, product]));
  const packageGuids = [...new Set(body.items.map((item) => item.packageGuid).filter(Boolean) as string[])];
  const packages = packageGuids.length
    ? await tx.productPackage.findMany({
        where: { guid: { in: packageGuids } },
        select: {
          id: true,
          guid: true,
          name: true,
          productId: true,
          unitId: true,
          multiplier: true,
          unit: { select: { guid: true, name: true, symbol: true } },
        },
      })
    : [];
  const packageByProductAndGuid = new Map(
    packages.map((pack) => [`${pack.productId}|${pack.guid}`, pack])
  );
  const explicitPriceTypeGuids = [
    ...new Set(body.items.map((item) => item.priceTypeGuid).filter(Boolean) as string[]),
  ];
  const explicitPriceTypes = explicitPriceTypeGuids.length
    ? await tx.priceType.findMany({
        where: { guid: { in: explicitPriceTypeGuids } },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : [];
  const priceTypeByGuid = new Map(explicitPriceTypes.map((priceType) => [priceType.guid, priceType]));
  const productPricePairs = body.items.flatMap((item) => {
    if (item.manualPrice !== null && item.manualPrice !== undefined) return [];
    const product = productByGuid.get(item.productGuid);
    if (!product) return [];
    const linePriceType = item.priceTypeGuid
      ? priceTypeByGuid.get(item.priceTypeGuid) ?? null
      : context.priceType;
    return linePriceType ? [{ productId: product.id, priceTypeId: linePriceType.id }] : [];
  });
  const productPriceByProductAndPriceTypeId = await loadProductPriceInfoByProductAndPriceTypeId(
    tx,
    productPricePairs,
    sourceUpdatedAt
  );

  for (const item of body.items) {
    const product = productByGuid.get(item.productGuid);

    if (!product) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Товар ${item.productGuid} не найден`);
    }
    if (product.isActive === false) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Товар ${formatProductLabel(product)} неактивен`);
    }

    const packageRecord = item.packageGuid
      ? packageByProductAndGuid.get(`${product.id}|${item.packageGuid}`) ?? null
      : null;

    if (item.packageGuid) {
      if (!packageRecord) {
        throw new ClientOrdersError(
          404,
          ErrorCodes.NOT_FOUND,
          `Упаковка ${item.packageGuid} для товара ${formatProductLabel(product)} не найдена`
        );
      }
    }

    const quantity = new Prisma.Decimal(item.quantity);
    const multiplier = packageRecord?.multiplier ?? new Prisma.Decimal(1);
    const quantityBase = quantity.mul(multiplier);
    const isManualPrice = item.manualPrice !== null && item.manualPrice !== undefined;
    const manualPrice = isManualPrice ? toDecimal(item.manualPrice)! : null;
    const isCancelled = item.isCancelled ?? false;

    let linePriceType = item.priceTypeGuid
      ? priceTypeByGuid.get(item.priceTypeGuid) ?? null
      : isManualPrice
        ? null
        : context.priceType;
    if (item.priceTypeGuid && !linePriceType) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Тип цены ${item.priceTypeGuid} не найден`);
    }
    if (linePriceType && 'isActive' in linePriceType && linePriceType.isActive === false) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Тип цены ${linePriceType.guid} неактивен`);
    }

    let productPrice: ReceiptPriceInfo | null = null;
    if (!isManualPrice) {
      if (!linePriceType && !isCancelled) {
        throw new ClientOrdersError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `Не выбран вид цены для товара ${formatProductLabel(product)}`
        );
      }
      productPrice = linePriceType
        ? productPriceByProductAndPriceTypeId.get(`${product.id}|${linePriceType.id}`) ?? null
        : null;
    }

    const fixedBasePrice = item.basePrice !== null && item.basePrice !== undefined ? item.basePrice : null;
    const basePriceValue = isManualPrice ? item.manualPrice : fixedBasePrice ?? productPrice?.value ?? (isCancelled ? 0 : undefined);
    if (basePriceValue === null || basePriceValue === undefined) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Не найдена цена ${linePriceType?.name ?? ''} для товара ${formatProductLabel(product)}`.trim()
      );
    }

    const quantityBaseValue = decimalToNumber(quantityBase) ?? item.quantity;
    const minQty = product.isWeight ? 0.001 : (productPrice?.minQty ?? null);
    if (!isCancelled && quantityBaseValue > 0 && minQty !== null && quantityBaseValue < minQty) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Количество для товара ${formatProductLabel(product)} меньше минимального (${minQty})`
      );
    }

    const basePrice = toDecimal(basePriceValue)!;
    const lineDiscountPercent = item.discountPercent ?? null;
    const cancelledAmount =
      item.cancelledAmount !== null && item.cancelledAmount !== undefined
        ? toDecimal(item.cancelledAmount)!
        : null;
    const canApplyGeneralDiscount = !isManualPrice && (lineDiscountPercent === null || lineDiscountPercent === undefined);
    const appliedDiscountPercent = lineDiscountPercent ?? (canApplyGeneralDiscount ? generalDiscountPercent : null);

    let finalPrice = manualPrice ?? basePrice;
    if (appliedDiscountPercent !== null && appliedDiscountPercent !== undefined) {
      const multiplierPercent = new Prisma.Decimal(100).minus(new Prisma.Decimal(appliedDiscountPercent)).div(100);
      const discountedPrice = finalPrice.mul(multiplierPercent);
      if (canApplyGeneralDiscount && generalDiscountPercent !== null && generalDiscountPercent !== undefined) {
        generalDiscountAmount = generalDiscountAmount.add(basePrice.minus(discountedPrice).mul(quantityBase));
      }
      finalPrice = discountedPrice;
    }

    const lineAmount = quantityBase.mul(finalPrice);
    if (!isCancelled) {
      totalAmount = totalAmount.add(lineAmount);
    }
    const lineGuid = ensureLineGuid(item.lineGuid);
    const lineGuidKey = lineGuid.toLowerCase();
    if (usedLineGuids.has(lineGuidKey)) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Дублируется идентификатор строки заказа ${lineGuid}`);
    }
    usedLineGuids.add(lineGuidKey);

    preparedItems.push({
      create: {
        lineGuid,
        productId: product.id,
        packageId: packageRecord?.id ?? null,
        unitId: packageRecord?.unitId ?? product.baseUnit?.id ?? null,
        priceTypeId: linePriceType?.id ?? undefined,
        quantity,
        quantityBase,
        basePrice,
        price: finalPrice,
        isManualPrice,
        manualPrice,
        priceSource: isManualPrice
          ? 'manual'
          : productPrice
            ? `product-prices:${linePriceType?.name ?? linePriceType?.guid ?? 'price-type'}`
            : `client-fixed:${linePriceType?.name ?? linePriceType?.guid ?? 'price-type'}`,
        isCancelled,
        cancelReasonGuid: item.cancelReasonGuid ?? null,
        cancelReasonName: item.cancelReasonName ?? null,
        cancelReason: item.cancelReason ?? null,
        cancelledAmount: cancelledAmount ?? (isCancelled ? lineAmount : null),
        discountPercent: lineDiscountPercent !== null && lineDiscountPercent !== undefined ? toDecimal(lineDiscountPercent)! : null,
        appliedDiscountPercent:
          appliedDiscountPercent !== null && appliedDiscountPercent !== undefined
            ? toDecimal(appliedDiscountPercent)!
            : null,
        lineAmount,
        comment: item.comment ?? null,
        sourceUpdatedAt,
      },
      snapshot: {
        lineGuid,
        appLineGuid: lineGuid,
        product: {
          guid: product.guid,
          name: product.name,
          code: product.code,
          article: product.article,
          isWeight: product.isWeight,
        },
        package: packageRecord
          ? {
              guid: packageRecord.guid,
              name: packageRecord.name,
              multiplier: decimalToNumber(packageRecord.multiplier),
            }
          : null,
        unit: packageRecord
          ? packageRecord.unit
          : product.baseUnit
            ? {
                guid: product.baseUnit.guid,
                name: product.baseUnit.name,
                symbol: product.baseUnit.symbol,
              }
            : null,
        priceType: linePriceType ? { guid: linePriceType.guid, name: linePriceType.name } : null,
        quantity: item.quantity,
        quantityBase: decimalToNumber(quantityBase),
        basePrice: decimalToNumber(basePrice),
        manualPrice: decimalToNumber(manualPrice),
        isManualPrice,
        price: decimalToNumber(finalPrice),
        priceSource: isManualPrice
          ? 'manual'
          : productPrice
            ? `product-prices:${linePriceType?.name ?? linePriceType?.guid ?? 'price-type'}`
            : `client-fixed:${linePriceType?.name ?? linePriceType?.guid ?? 'price-type'}`,
        isCancelled,
        cancelReasonGuid: item.cancelReasonGuid ?? null,
        cancelReasonName: item.cancelReasonName ?? null,
        cancelReason: item.cancelReason ?? null,
        cancelledAmount: decimalToNumber(cancelledAmount ?? (isCancelled ? lineAmount : null)),
        discountPercent: lineDiscountPercent,
        appliedDiscountPercent,
        lineAmount: decimalToNumber(lineAmount),
        comment: item.comment ?? null,
      },
    });
  }

  return {
    items: preparedItems,
    totalAmount,
    generalDiscountAmount,
  };
}

async function getActiveOrganizations() {
  const query = { limit: 100, offset: 0 };
  const result = await onecLive(
    () => readThroughClientOrdersCache(
      'organizations',
      query,
      CLIENT_ORDERS_CACHE_TTL.warehouses,
      () => getLiveOrganizations(query)
    ),
    'Ошибка получения организаций из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
  return result.items;
}

async function getValidatedPreferredOrganization(
  preferredOrganizationId: string | null | undefined
): Promise<{ guid: string; name: string; code: string | null } | null> {
  if (!preferredOrganizationId) return null;
  const organization = await prisma.organization.findFirst({
    where: { id: preferredOrganizationId, isActive: true },
    select: { guid: true, name: true, code: true },
  });
  return organization ?? null;
}

async function getRawClientOrderSettings(userId: number) {
  return prisma.clientOrderUserSettings.findUnique({
    where: { userId },
    select: {
      userId: true,
      preferredOrganizationId: true,
      deliveryDateMode: true,
      deliveryDateOffsetDays: true,
      fixedDeliveryDate: true,
    },
  });
}

function buildSettingsResponse(args: {
  organizations: Array<{ guid: string; name: string; code: string | null; isActive: boolean }>;
  preferredOrganization: { guid: string; name: string; code: string | null } | null;
  settings:
    | {
        deliveryDateMode: ClientOrderDeliveryDateMode;
        deliveryDateOffsetDays: number;
        fixedDeliveryDate: Date | null;
      }
    | null;
}) {
  const settings = {
    deliveryDateMode: DEFAULT_DELIVERY_DATE_MODE,
    deliveryDateOffsetDays: DEFAULT_DELIVERY_DATE_OFFSET_DAYS,
    fixedDeliveryDate: null,
  };
  const deliveryDate = resolveDeliveryDateSettings(settings);
  return {
    organizations: args.organizations.map((item) => ({
      guid: item.guid,
      name: item.name,
      code: item.code,
      isActive: item.isActive,
    })),
    preferredOrganization: args.preferredOrganization,
    deliveryDateMode: settings.deliveryDateMode,
    deliveryDateOffsetDays: settings.deliveryDateOffsetDays,
    fixedDeliveryDate: settings.fixedDeliveryDate,
    resolvedDeliveryDate: deliveryDate.resolvedDate,
    deliveryDateIssue: deliveryDate.issue,
    deliveryDateIssueMessage: formatDeliveryDateIssue(deliveryDate.issue),
    currency: DEFAULT_ORDER_CURRENCY,
  };
}

async function saveUserCounterpartyDefaults(tx: Tx, userId: number, guid: string) {
  const order = await tx.order.findFirst({
    where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
    select: {
      organizationId: true,
      counterpartyId: true,
      agreementId: true,
      contractId: true,
      warehouseId: true,
      deliveryAddressId: true,
    },
  });

  if (!order?.organizationId || !order.counterpartyId) {
    return;
  }

  await tx.clientOrderUserCounterpartyDefaults.upsert({
    where: {
      userId_organizationId_counterpartyId: {
        userId,
        organizationId: order.organizationId,
        counterpartyId: order.counterpartyId,
      },
    },
    create: {
      userId,
      organizationId: order.organizationId,
      counterpartyId: order.counterpartyId,
      agreementId: order.agreementId,
      contractId: order.contractId,
      warehouseId: order.warehouseId,
      deliveryAddressId: order.deliveryAddressId,
      lastUsedAt: now(),
    },
    update: {
      agreementId: order.agreementId,
      contractId: order.contractId,
      warehouseId: order.warehouseId,
      deliveryAddressId: order.deliveryAddressId,
      lastUsedAt: now(),
    },
  });
}

const PINNED_LOCAL_STATUSES: OrderStatus[] = [
  OrderStatus.DRAFT,
  OrderStatus.QUEUED,
  OrderStatus.REJECTED,
];

const PINNED_LOCAL_SYNC_STATES: OrderSyncState[] = [
  OrderSyncState.DRAFT,
  OrderSyncState.QUEUED,
  OrderSyncState.ERROR,
  OrderSyncState.CONFLICT,
  OrderSyncState.CANCEL_REQUESTED,
];

const LOCAL_ORDER_STATUS_VALUES = new Set<string>(Object.values(OrderStatus));
const LIVE_STATUS_FILTER_SCAN_LIMIT = 300;

function getOrderStatusFilters(query: Pick<ClientOrdersListQuery, 'status' | 'statuses'>) {
  return Array.from(new Set([
    ...(Array.isArray(query.statuses) ? query.statuses : []),
    ...(query.status ? [query.status] : []),
  ].filter(Boolean)));
}

function mapOnecOrderStatusForFilter(value?: string | null) {
  const normalized = (value || '').trim().toLocaleLowerCase('ru').replace(/\s+/g, '');
  if (!normalized) return null;
  if (normalized.includes('ожидаетсясоглас')) return 'AWAITING_APPROVAL';
  if (normalized.includes('ожидаетсяавансдообеспеч')) return 'AWAITING_ADVANCE_BEFORE_SUPPLY';
  if (normalized.includes('готовкобеспеч')) return 'READY_FOR_SUPPLY';
  if (normalized.includes('ожидаетсяпредоплатадоотгруз')) return 'AWAITING_PREPAYMENT_BEFORE_SHIPMENT';
  if (normalized.includes('ожидаетсяобеспеч')) return 'AWAITING_SUPPLY';
  if (normalized.includes('готовкотгруз')) return 'READY_FOR_SHIPMENT';
  if (normalized.includes('впроцессеотгруз')) return 'SHIPPING_IN_PROGRESS';
  if (normalized.includes('ожидаетсяоплатапослеотгруз')) return 'AWAITING_PAYMENT_AFTER_SHIPMENT';
  if (normalized.includes('готовкзакры')) return 'READY_TO_CLOSE';
  if (normalized.includes('котгруз')) return 'TO_SHIP';
  if (normalized.includes('кобеспеч')) return 'TO_SUPPLY';
  if (normalized.includes('резерв')) return 'IN_RESERVE';
  if (normalized.includes('квыполн')) return 'TO_FULFILLMENT';
  if (normalized.includes('отмен')) return 'CANCELLED';
  if (normalized.includes('отклон')) return 'REJECTED';
  if (normalized.includes('несоглас') || normalized.includes('неподтверж')) return 'NOT_CONFIRMED';
  if (normalized.includes('частич')) return 'PARTIAL';
  if (normalized.includes('выполн')) return 'COMPLETED';
  if (normalized.includes('закры')) return 'CLOSED';
  if (normalized.includes('подтверж')) return 'CONFIRMED';
  return null;
}

function getOrderDisplayStatusForFilter(order: {
  status?: string | null;
  number1c?: string | null;
  origin?: string | null;
  status1c?: string | null;
  currentState1c?: string | null;
}) {
  const onecText = order.currentState1c || order.status1c;
  const isOnecBacked = Boolean(order.number1c || order.origin === 'onec' || order.origin === 'merged');
  if (isOnecBacked && onecText) return mapOnecOrderStatusForFilter(onecText) || order.status || onecText;
  return order.status || mapOnecOrderStatusForFilter(onecText) || OrderStatus.DRAFT;
}

function normalizedGuid(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function sameGuid(left?: string | null, right?: string | null) {
  const leftGuid = normalizedGuid(left);
  const rightGuid = normalizedGuid(right);
  return !!leftGuid && !!rightGuid && leftGuid === rightGuid;
}

function orderDateTime(value?: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function endOfDateTime(value: Date) {
  const next = new Date(value);
  next.setHours(23, 59, 59, 999);
  return next.getTime();
}

function liveOrderHasProblem(order: {
  lastExportError?: unknown;
  last1cError?: unknown;
  cancelRequestedAt?: Date | string | null;
  syncState?: string | null;
}) {
  return !!(
    order.lastExportError ||
    order.last1cError ||
    order.cancelRequestedAt ||
    ['ERROR', 'FAILED', 'CONFLICT', 'CANCEL_REQUESTED'].includes(String(order.syncState || ''))
  );
}

function liveOrderHasPriceType(order: {
  priceType?: { guid?: string | null } | null;
  items?: Array<{ priceType?: { guid?: string | null } | null }>;
}, priceTypeGuid?: string | null) {
  if (!priceTypeGuid) return true;
  if (sameGuid(order.priceType?.guid, priceTypeGuid)) return true;
  return (order.items || []).some((item) => sameGuid(item.priceType?.guid, priceTypeGuid));
}

function orderMatchesListQuery(
  order: LiveClientOrder & {
    origin?: string | null;
    syncState?: string | null;
    lastExportError?: unknown;
    last1cError?: unknown;
    cancelRequestedAt?: Date | string | null;
  },
  query: ClientOrdersListQuery,
  statusFilters: string[]
) {
  if (statusFilters.length) {
    const status = String(getOrderDisplayStatusForFilter(order));
    if (!statusFilters.includes(status)) return false;
  }
  if (query.counterpartyGuid && !sameGuid(order.counterparty?.guid, query.counterpartyGuid)) return false;
  if (query.organizationGuid && !sameGuid(order.organization?.guid, query.organizationGuid)) return false;
  if (query.warehouseGuid && !sameGuid(order.warehouse?.guid, query.warehouseGuid)) return false;
  if (query.priceTypeGuid && !liveOrderHasPriceType(order, query.priceTypeGuid)) return false;
  if (query.syncState && order.syncState !== query.syncState) return false;
  if (query.onlyProblems && !liveOrderHasProblem(order)) return false;
  if (query.hasNumber1c === 'yes' && !order.number1c) return false;
  if (query.hasNumber1c === 'no' && order.number1c) return false;

  const amount = Number(order.totalAmount || 0);
  if (query.amountMin !== undefined && amount < query.amountMin) return false;
  if (query.amountMax !== undefined && amount > query.amountMax) return false;

  const itemsCount = Number(order.itemsCount ?? order.items?.length ?? 0);
  if (query.itemsMin !== undefined && itemsCount < query.itemsMin) return false;
  if (query.itemsMax !== undefined && itemsCount > query.itemsMax) return false;

  const deliveryDate = orderDateTime(order.deliveryDate);
  if (query.deliveryDateFrom && (deliveryDate === null || deliveryDate < query.deliveryDateFrom.getTime())) return false;
  if (query.deliveryDateTo && (deliveryDate === null || deliveryDate > endOfDateTime(query.deliveryDateTo))) return false;

  const updatedDate = orderDateTime(order.updatedAt || order.sentTo1cAt || order.createdAt);
  if (query.updatedFrom && (updatedDate === null || updatedDate < query.updatedFrom.getTime())) return false;
  if (query.updatedTo && (updatedDate === null || updatedDate > endOfDateTime(query.updatedTo))) return false;

  const tokens = searchTokens(query.search || '').map((token) => token.toLocaleLowerCase('ru'));
  if (tokens.length) {
    const values = [
      order.guid,
      order.appGuid,
      order.number1c,
      order.comment,
      order.organization?.name,
      order.counterparty?.name,
      order.warehouse?.name,
      order.status,
      order.status1c,
      order.currentState1c,
      order.documentStatus1c,
    ];
    if (!tokens.every((token) => values.some((value) => String(value || '').toLocaleLowerCase('ru').includes(token)))) {
      return false;
    }
  }

  return true;
}

type LocalOrderWhereBuildResult = {
  where: Prisma.OrderWhereInput;
  statusCountsWhere: Prisma.OrderWhereInput;
};

async function getManagerGuidForUser(userId: number) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { onecUserGuid: true },
  });
  return profile?.onecUserGuid?.trim() || null;
}

async function buildLocalOrdersWhere(query: ClientOrdersListQuery, userId: number): Promise<LocalOrderWhereBuildResult> {
  const search = normalizeSearch(query.search);
  const statusFilters = getOrderStatusFilters(query);
  const localStatuses = statusFilters.filter((status): status is OrderStatus => LOCAL_ORDER_STATUS_VALUES.has(status));
  const hasOnlyLiveStatuses = statusFilters.length > 0 && localStatuses.length === 0;
  const itemCountFilters = query.itemsMin !== undefined || query.itemsMax !== undefined;
  const itemCountOrderIds = itemCountFilters
    ? await prisma.orderItem.groupBy({
        by: ['orderId'],
        where: { order: { source: OrderSource.MANAGER_APP, createdByUserId: userId } },
        ...(query.itemsMin !== undefined || query.itemsMax !== undefined
          ? {
              having: {
                id: {
                  _count: {
                    ...(query.itemsMin !== undefined ? { gte: query.itemsMin } : {}),
                    ...(query.itemsMax !== undefined ? { lte: query.itemsMax } : {}),
                  },
                },
              },
            }
          : {}),
      })
    : null;
  const endOfDay = (date: Date) => {
    const next = new Date(date);
    next.setHours(23, 59, 59, 999);
    return next;
  };
  const and: Prisma.OrderWhereInput[] = [];
  if (hasOnlyLiveStatuses) {
    and.push({ guid: { equals: '__unsupported_live_status__' } });
  }
  if (query.onlyProblems) {
    and.push({
      OR: [
        { lastExportError: { not: null } },
        { last1cError: { not: null } },
        { cancelRequestedAt: { not: null } },
        { syncState: { in: [OrderSyncState.ERROR, OrderSyncState.CONFLICT, OrderSyncState.CANCEL_REQUESTED] } },
      ],
    });
  }
  const tokens = searchTokens(search);
  for (const token of tokens) {
    and.push({
      OR: [
        { guid: { contains: token, mode: 'insensitive' } },
        { number1c: { contains: token, mode: 'insensitive' } },
        { comment: { contains: token, mode: 'insensitive' } },
        { organization: { name: { contains: token, mode: 'insensitive' } } },
        { counterparty: { name: { contains: token, mode: 'insensitive' } } },
      ],
    });
  }
  const where: Prisma.OrderWhereInput = {
    source: OrderSource.MANAGER_APP,
    createdByUserId: userId,
    ...(and.length ? { AND: and } : {}),
    ...(localStatuses.length ? { status: { in: localStatuses } } : {}),
    ...(query.syncState ? { syncState: query.syncState } : {}),
    ...(query.counterpartyGuid ? { counterparty: { guid: query.counterpartyGuid } } : {}),
    ...(query.organizationGuid ? { organization: { guid: query.organizationGuid } } : {}),
    ...(query.warehouseGuid ? { warehouse: { guid: query.warehouseGuid } } : {}),
    ...(query.priceTypeGuid
      ? {
          OR: [
            { priceType: { guid: query.priceTypeGuid } },
            { items: { some: { priceType: { guid: query.priceTypeGuid } } } },
          ],
        }
      : {}),
    ...(query.amountMin !== undefined || query.amountMax !== undefined
      ? {
          totalAmount: {
            ...(query.amountMin !== undefined ? { gte: query.amountMin } : {}),
            ...(query.amountMax !== undefined ? { lte: query.amountMax } : {}),
          },
        }
      : {}),
    ...(query.deliveryDateFrom || query.deliveryDateTo
      ? {
          deliveryDate: {
            ...(query.deliveryDateFrom ? { gte: query.deliveryDateFrom } : {}),
            ...(query.deliveryDateTo ? { lte: endOfDay(query.deliveryDateTo) } : {}),
          },
        }
      : {}),
    ...(query.updatedFrom || query.updatedTo
      ? {
          updatedAt: {
            ...(query.updatedFrom ? { gte: query.updatedFrom } : {}),
            ...(query.updatedTo ? { lte: endOfDay(query.updatedTo) } : {}),
          },
        }
      : {}),
    ...(query.hasNumber1c === 'yes' ? { number1c: { not: null } } : {}),
    ...(query.hasNumber1c === 'no' ? { number1c: null } : {}),
    ...(itemCountOrderIds ? { id: { in: itemCountOrderIds.map((item) => item.orderId) } } : {}),
  };

  const statusCountsWhere: Prisma.OrderWhereInput = { ...where, status: undefined };
  return { where, statusCountsWhere };
}

function isPinnedLocalOrder(order: Pick<ClientOrderSummaryRecord, 'status' | 'syncState' | 'number1c'>) {
  return (
    PINNED_LOCAL_STATUSES.includes(order.status) ||
    PINNED_LOCAL_SYNC_STATES.includes(order.syncState) ||
    !order.number1c
  );
}

function localOrderKey(order: Pick<ClientOrderSummaryRecord, 'guid' | 'number1c'>) {
  return {
    appGuid: order.guid?.toLowerCase() || '',
    number1c: order.number1c?.trim().toLowerCase() || null,
  };
}

function liveOrderKey(order: Pick<LiveClientOrder, 'appGuid' | 'number1c'>) {
  return {
    appGuid: order.appGuid?.trim().toLowerCase() || null,
    number1c: order.number1c?.trim().toLowerCase() || null,
  };
}

function mapMergedLiveOrder(order: LiveClientOrder, local?: ClientOrderSummaryRecord | null, queuePositions?: Map<string, number>) {
  if (!local) {
    return {
      ...order,
      readOnly: true,
      readOnlyReason: order.readOnlyReason || 'Документ 1С открыт только для просмотра в приложении.',
    };
  }
  const hasRealization = order.hasRealization || local.hasRealization;
  return {
    ...order,
    guid: local.guid,
    appGuid: local.guid,
    documentGuid: order.documentGuid,
    origin: 'merged',
    source: local.source,
    revision: local.revision,
    queuedAt: local.queuedAt,
    queuePosition: resolveQueuePosition(local, queuePositions),
    sentTo1cAt: local.sentTo1cAt ?? order.sentTo1cAt,
    lastStatusSyncAt: local.lastStatusSyncAt ?? order.lastStatusSyncAt,
    lastExportError: normalizeClientOrderPublicError(local.lastExportError),
    last1cError: normalizeClientOrderPublicError(local.last1cError),
    paymentForm: local.paymentForm ?? order.paymentForm,
    deliveryMethod: local.deliveryMethod ?? order.deliveryMethod,
    cancelRequestedAt: local.cancelRequestedAt,
    hasRealization,
    realizationDetectedAt: local.realizationDetectedAt ?? null,
    readOnly: hasRealization,
    readOnlyReason: hasRealization
      ? (order.readOnlyReason || 'По заказу создана проведенная реализация товаров и услуг.')
      : order.readOnlyReason,
  };
}

function liveUnavailableMeta(error: unknown) {
  if (error instanceof ClientOrdersError && error.status === 502) {
    return { status: 'unavailable', message: error.message || '1С временно недоступна. Показаны локальные черновики.' };
  }
  if (error instanceof OnecLpAppConfigError) {
    return { status: 'not_configured', message: 'Не настроена связь с 1С для live-списка заказов.' };
  }
  if (error instanceof OnecLpAppNetworkError) {
    return { status: 'unavailable', message: '1С временно недоступна. Показаны локальные черновики.' };
  }
  if (error instanceof OnecLpAppHttpError) {
    return { status: 'error', message: `1С вернула ошибку: ${error.message}` };
  }
  return { status: 'error', message: 'Не удалось загрузить документы из 1С.' };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichLiveOrdersForWarehouseFilter(
  items: LiveClientOrder[],
  query: ClientOrdersListQuery,
  managerGuid: string
) {
  if (!query.warehouseGuid || !items.some((item) => !item.warehouse?.guid)) return items;

  const enriched = await mapWithConcurrency(items, 4, async (item) => {
    if (item.warehouse?.guid) return item;
    const detailGuid = item.documentGuid || item.guid;
    if (!detailGuid) return item;

    try {
      return await onecLive(
        () => readThroughClientOrdersCache(
          'orders:detail',
          { guid: detailGuid, managerGuid, appGuid: item.appGuid ?? undefined },
          CLIENT_ORDERS_CACHE_TTL.orderDetail,
          () => getLiveClientOrder(detailGuid, { managerGuid, appGuid: item.appGuid ?? undefined })
        ),
        'Ошибка получения detail заказа клиента из 1С для фильтра склада',
        { allowCachedWhenCircuitOpen: true }
      );
    } catch {
      return item;
    }
  });

  return enriched;
}

export async function listClientOrders(query: ClientOrdersListQuery, userId: number) {
  const { where, statusCountsWhere } = await buildLocalOrdersWhere(query, userId);
  const statusFilters = getOrderStatusFilters(query);
  const pinnedWhere: Prisma.OrderWhereInput = {
    AND: [
      where,
      {
        OR: [
          { status: { in: PINNED_LOCAL_STATUSES } },
          { syncState: { in: PINNED_LOCAL_SYNC_STATES } },
          { number1c: null },
        ],
      },
    ],
  };

  const [pinnedItems, pinnedTotal, statusRows, managerGuid, queuePositions] = await Promise.all([
    prisma.order.findMany({
      where: pinnedWhere,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: clientOrderSummarySelect,
    }),
    prisma.order.count({ where: pinnedWhere }),
    prisma.order.groupBy({
      by: ['status'],
      where: statusCountsWhere,
      orderBy: { status: 'asc' },
      _count: { _all: true },
    }),
    getManagerGuidForUser(userId),
    loadQueuedOrderPositions(),
  ]);

  const countedStatusRows = statusRows as unknown as Array<{
    status: string;
    _count: { _all: number };
  }>;
  const localStatusCounts = Object.fromEntries(
    countedStatusRows.map((row) => [row.status, row._count._all])
  );

  const localPinnedAppGuids = new Set(pinnedItems.map((item) => localOrderKey(item).appGuid));
  const localPinnedNumbers = new Set(
    pinnedItems.flatMap((item) => {
      const number1c = localOrderKey(item).number1c;
      return number1c ? [number1c] : [];
    })
  );

  let liveMeta: { status: string; message?: string } = managerGuid
    ? { status: 'ok' }
    : { status: 'not_configured', message: 'В профиле сотрудника не заполнен GUID пользователя 1С.' };
  let liveItems: LiveClientOrder[] = [];
  let liveTotal = 0;
  let liveHasMore = false;
  const liveOffset = Math.max(0, query.offset - pinnedTotal);
  const liveStatusForOnec = statusFilters.length === 1 ? statusFilters[0] : undefined;
  const livePostFilterActive = statusFilters.length > 1 ||
    Boolean(
      query.priceTypeGuid ||
      query.syncState ||
      query.amountMin !== undefined ||
      query.amountMax !== undefined ||
      query.deliveryDateFrom ||
      query.deliveryDateTo ||
      query.updatedFrom ||
      query.updatedTo ||
      query.itemsMin !== undefined ||
      query.itemsMax !== undefined ||
      query.hasNumber1c ||
      query.onlyProblems
    );
  const liveQueryOffset = livePostFilterActive ? 0 : liveOffset;
  const liveQueryLimit = livePostFilterActive
    ? Math.min(LIVE_STATUS_FILTER_SCAN_LIMIT, Math.max(liveOffset + query.limit, query.limit * 5))
    : query.limit;

  if (managerGuid) {
    try {
      const liveQuery = {
        ...query,
        status: liveStatusForOnec,
        statuses: undefined,
        managerGuid,
        offset: liveQueryOffset,
        limit: liveQueryLimit,
      };
      const livePage = await onecLive(
        () => readThroughClientOrdersCache(
          'orders:list',
          liveQuery,
          CLIENT_ORDERS_CACHE_TTL.ordersList,
          () => getLiveClientOrders(liveQuery)
        ),
        'Ошибка получения live-списка заказов из 1С',
        { allowCachedWhenCircuitOpen: true }
      );
      liveItems = await enrichLiveOrdersForWarehouseFilter(livePage.items, query, managerGuid);
      liveTotal = livePage.total;
      liveHasMore = Boolean(livePage.hasMore ?? (liveQueryOffset + livePage.items.length < livePage.total));
    } catch (error) {
      liveMeta = liveUnavailableMeta(error);
      liveItems = [];
      liveTotal = 0;
      liveHasMore = false;
    }
  }

  const liveAppGuids = liveItems.flatMap((item) => {
    const key = liveOrderKey(item).appGuid;
    return key ? [key] : [];
  });
  const liveNumbers = liveItems.flatMap((item) => {
    const key = liveOrderKey(item).number1c;
    return key ? [key] : [];
  });
  const matchingLocals = liveAppGuids.length || liveNumbers.length
    ? await prisma.order.findMany({
        where: {
          AND: [
            where,
            {
              OR: [
                ...(liveAppGuids.length ? [{ guid: { in: liveAppGuids } }] : []),
                ...(liveNumbers.length ? [{ number1c: { in: liveNumbers } }] : []),
              ],
            },
          ],
        },
        select: clientOrderSummarySelect,
      })
    : [];
  const localByAppGuid = new Map(matchingLocals.map((item) => [localOrderKey(item).appGuid, item]));
  const localByNumber = new Map(
    matchingLocals.flatMap((item) => {
      const number1c = localOrderKey(item).number1c;
      return number1c ? [[number1c, item] as const] : [];
    })
  );

  const mappedPinned = query.offset === 0 ? pinnedItems.map((item) => mapClientOrderSummary(item, queuePositions)) : [];
  const mappedLive = liveItems.flatMap((item) => {
    const key = liveOrderKey(item);
    if ((key.appGuid && localPinnedAppGuids.has(key.appGuid)) || (key.number1c && localPinnedNumbers.has(key.number1c))) {
      return [];
    }
    const local = (key.appGuid ? localByAppGuid.get(key.appGuid) : undefined) ?? (key.number1c ? localByNumber.get(key.number1c) : undefined) ?? null;
    return [mapMergedLiveOrder(item, local, queuePositions)];
  });
  const filteredLive = mappedLive.filter((item) => orderMatchesListQuery(item as LiveClientOrder & {
    origin?: string | null;
    syncState?: string | null;
    lastExportError?: unknown;
    last1cError?: unknown;
    cancelRequestedAt?: Date | string | null;
  }, query, statusFilters));
  const visibleLive = livePostFilterActive
    ? filteredLive.slice(liveOffset, liveOffset + query.limit)
    : filteredLive;
  const postFilterScanMayHaveMore = livePostFilterActive
    ? liveHasMore || liveItems.length >= liveQueryLimit
    : false;
  const hasMore = livePostFilterActive
    ? visibleLive.length > 0 && (liveOffset + visibleLive.length < filteredLive.length || postFilterScanMayHaveMore)
    : liveHasMore;

  return {
    items: [...mappedPinned, ...visibleLive],
    total: pinnedTotal + (
      livePostFilterActive
        ? liveOffset + visibleLive.length + (hasMore ? 1 : 0)
        : liveTotal
    ),
    statusCounts: liveMeta.status === 'ok' ? {} : localStatusCounts,
    limit: query.limit,
    offset: query.offset,
    hasMore,
    liveSource: liveMeta,
  };
}

export async function getClientOrderByGuid(guid: string, userId?: number) {
  const order = await prisma.order.findFirst({
    where: {
      guid,
      source: OrderSource.MANAGER_APP,
      ...(userId ? { createdByUserId: userId } : {}),
    },
    select: orderDetailSelect,
  });

  if (!order) {
    if (userId) {
      const foreignLocalOrder = await prisma.order.findFirst({
        where: { guid, source: OrderSource.MANAGER_APP },
        select: { id: true },
      });
      if (foreignLocalOrder) {
        throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
      }
    }

    if (!userId) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }
    const managerGuid = await getManagerGuidForUser(userId);
    if (!managerGuid) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'В профиле сотрудника не заполнен GUID пользователя 1С.');
    }
    const live = await onecLive(
      () => readThroughClientOrdersCache(
        'orders:detail',
        { guid, managerGuid },
        CLIENT_ORDERS_CACHE_TTL.orderDetail,
        () => getLiveClientOrder(guid, { managerGuid })
      ),
      'Ошибка получения заказа клиента из 1С',
      { allowCachedWhenCircuitOpen: true }
    );
    return enrichOrderItemsWithImages({ ...live, readOnly: true });
  }

  const mapped = {
    ...mapOrderDetail(order),
    lastExportError: normalizeClientOrderPublicError(order.lastExportError),
    last1cError: normalizeClientOrderPublicError(order.last1cError),
  };
  const exportValidation = latestExportValidationFromEvents(mapped.events);

  if (userId && order.number1c && !isPinnedLocalOrder(order)) {
    const managerGuid = await getManagerGuidForUser(userId);
    if (managerGuid) {
      try {
        const liveSummary = await onecLive(
          () => readThroughClientOrdersCache(
            'orders:find',
            { managerGuid, appGuid: order.guid, number1c: order.number1c },
            CLIENT_ORDERS_CACHE_TTL.ordersList,
            () => findLiveClientOrder({ managerGuid, appGuid: order.guid, number1c: order.number1c })
          ),
          'Ошибка поиска заказа клиента в 1С',
          { allowCachedWhenCircuitOpen: true }
        );
        if (liveSummary?.documentGuid) {
          const liveDetail = await onecLive(
            () => readThroughClientOrdersCache(
              'orders:detail',
              { documentGuid: liveSummary.documentGuid, managerGuid, appGuid: order.guid },
              CLIENT_ORDERS_CACHE_TTL.orderDetail,
              () => getLiveClientOrder(liveSummary.documentGuid, { managerGuid, appGuid: order.guid })
            ),
            'Ошибка получения заказа клиента из 1С',
            { allowCachedWhenCircuitOpen: true }
          );
          return enrichOrderItemsWithImages({
            ...liveDetail,
            guid: order.guid,
            appGuid: order.guid,
            origin: 'merged',
            source: order.source,
            revision: order.revision,
            queuePosition: null,
            lastExportError: normalizeClientOrderPublicError(order.lastExportError),
            last1cError: normalizeClientOrderPublicError(order.last1cError),
            exportValidation,
            hasRealization: liveDetail.hasRealization || order.hasRealization,
            realizationDetectedAt: order.realizationDetectedAt,
            readOnly: liveDetail.hasRealization || order.hasRealization,
            readOnlyReason: liveDetail.hasRealization || order.hasRealization
              ? (liveDetail.readOnlyReason || 'По заказу создана проведенная реализация товаров и услуг.')
              : liveDetail.readOnlyReason,
          });
        }
      } catch (error) {
        if (error instanceof ClientOrdersError && error.status === 502) {
          // Keep local snapshot usable when 1C is slow or temporarily unavailable.
        } else if (!isOnecLpAppError(error)) {
          throw error;
        }
      }
    }
  }

  const queuePositions = isOrderQueued(order) ? await loadQueuedOrderPositions() : undefined;
  const stockByProductId = await loadStockByProductIdForWarehouse(
    prisma as unknown as Tx,
    order.warehouse?.guid ?? null,
    order.items.map((item) => item.productId)
  );

  return enrichOrderItemsWithImages({
    ...mapped,
    appGuid: mapped.guid,
    documentGuid: mapped.guid,
    origin: 'local',
    queuePosition: resolveQueuePosition(order, queuePositions),
    exportValidation,
    readOnly: mapped.hasRealization,
    readOnlyReason: mapped.hasRealization
      ? (mapped.readOnlyReason || 'По заказу создана проведенная реализация товаров и услуг.')
      : mapped.readOnlyReason,
    items: mapped.items.map((item, index) => ({
      ...item,
      stock: stockByProductId.get(order.items[index]?.productId) ?? null,
    })),
  });
}

export async function getClientOrderExportDebug(guid: string, userId: number) {
  const order = await prisma.order.findFirst({
    where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
    select: {
      id: true,
      guid: true,
      revision: true,
      status: true,
      syncState: true,
      number1c: true,
      date1c: true,
      queuedAt: true,
      sentTo1cAt: true,
      exportAttempts: true,
      lastExportError: true,
      last1cError: true,
      last1cSnapshot: true,
      sourceUpdatedAt: true,
      updatedAt: true,
      items: {
        orderBy: [{ createdAt: 'asc' }],
        select: {
          lineGuid: true,
          quantity: true,
          basePrice: true,
          isManualPrice: true,
          manualPrice: true,
          isCancelled: true,
          cancelReasonGuid: true,
          cancelReasonName: true,
          cancelReason: true,
          product: { select: { guid: true, name: true } },
        },
      },
      events: {
        orderBy: [{ createdAt: 'desc' }],
        take: 20,
        select: {
          revision: true,
          source: true,
          eventType: true,
          note: true,
          payload: true,
          createdAt: true,
        },
      },
    },
  });

  if (!order) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }

  return {
    guid: order.guid,
    revision: order.revision,
    status: order.status,
    syncState: order.syncState,
    number1c: order.number1c,
    date1c: order.date1c,
    queuedAt: order.queuedAt,
    sentTo1cAt: order.sentTo1cAt,
    exportAttempts: order.exportAttempts,
    lastExportError: order.lastExportError,
    last1cError: order.last1cError,
    sourceUpdatedAt: order.sourceUpdatedAt,
    updatedAt: order.updatedAt,
    last1cSnapshot: order.last1cSnapshot,
    items: order.items.map((item) => ({
      lineGuid: item.lineGuid,
      product: item.product,
      quantity: decimalToNumber(item.quantity),
      basePrice: decimalToNumber(item.basePrice),
      isManualPrice: item.isManualPrice,
      manualPrice: decimalToNumber(item.manualPrice),
      isCancelled: item.isCancelled,
      cancelReasonGuid: item.cancelReasonGuid,
      cancelReasonName: item.cancelReasonName,
      cancelReason: item.cancelReason,
    })),
    events: order.events,
  };
}

export async function getClientOrderSettings(userId: number) {
  const [settings, organizations] = await Promise.all([getRawClientOrderSettings(userId), getActiveOrganizations()]);
  const preferredOrganization = await getValidatedPreferredOrganization(settings?.preferredOrganizationId);
  return buildSettingsResponse({
    organizations,
    preferredOrganization,
    settings,
  });
}

export async function getClientOrderReferenceDetails(params: ClientOrderReferenceDetailsParams) {
  return onecLive(
    () => readThroughClientOrdersCache(
      'reference-details',
      params,
      CLIENT_ORDERS_CACHE_TTL.referenceDetails,
      () => getLiveReferenceDetails(params)
    ),
    'Ошибка получения карточки реквизита из 1С',
    { allowCachedWhenCircuitOpen: true }
  );

  /*
  const { kind, guid } = params;

  if (kind === 'organization') {
    const item = await prisma.organization.findFirst({ where: { guid, isActive: true } });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Организация ${guid} не найдена`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid,
      title: item.name,
      subtitle: item.code ? `Код ${item.code}` : null,
      sections: sections(
        section('Основное', [
          { label: 'Наименование', value: item.name },
          { label: 'Код', value: item.code },
          { label: 'Активна', value: formatBoolean(item.isActive) },
        ]),
        section('Синхронизация', [
          { label: 'Обновлено в источнике', value: item.sourceUpdatedAt },
          { label: 'Последняя синхронизация', value: item.lastSyncedAt },
          { label: 'Создано', value: item.createdAt },
          { label: 'Изменено', value: item.updatedAt },
        ])
      ),
      debug: item,
    });
  }

  if (kind === 'counterparty') {
    const item = await prisma.counterparty.findFirst({
      where: { guid, isActive: true },
      include: {
        defaultAgreement: { select: { guid: true, name: true } },
        defaultContract: { select: { guid: true, number: true } },
        defaultWarehouse: { select: { guid: true, name: true, code: true } },
        defaultDeliveryAddress: { select: { guid: true, fullAddress: true, name: true } },
      },
    });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${guid} не найден`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid,
      title: item.name,
      subtitle: [item.inn ? `ИНН ${item.inn}` : null, item.kpp ? `КПП ${item.kpp}` : null].filter(Boolean).join(' • ') || item.fullName,
      sections: sections(
        section('Основное', [
          { label: 'Наименование', value: item.name },
          { label: 'Полное наименование', value: item.fullName },
          { label: 'ИНН', value: item.inn },
          { label: 'КПП', value: item.kpp },
          { label: 'Телефон', value: item.phone },
          { label: 'Email', value: item.email },
          { label: 'Активен', value: formatBoolean(item.isActive) },
        ]),
        section('Реквизиты 1С', [
          { label: 'Тип юр/физ', value: item.legalEntityType || item.legalOrIndividualType },
          { label: 'Партнер', value: item.partnerGuid },
          { label: 'Страна регистрации', value: item.registrationCountryGuid },
          { label: 'Головной контрагент', value: item.headCounterpartyGuid },
          { label: 'ОКПО', value: item.okpoCode },
          { label: 'Налоговый номер', value: item.taxNumber },
          { label: 'Международное наименование', value: item.internationalName },
        ]),
        section('Значения по умолчанию', [
          { label: 'Соглашение', value: relationLabel(item.defaultAgreement) },
          { label: 'Договор', value: relationLabel(item.defaultContract) },
          { label: 'Склад', value: relationLabel(item.defaultWarehouse) },
          { label: 'Адрес доставки', value: relationLabel(item.defaultDeliveryAddress) },
        ])
      ),
      debug: item,
    });
  }

  if (kind === 'agreement') {
    const item = await prisma.clientAgreement.findFirst({
      where: { guid, isActive: true },
      include: {
        organization: { select: { guid: true, name: true, code: true } },
        counterparty: { select: { guid: true, name: true, inn: true, kpp: true } },
        contract: { select: { guid: true, number: true } },
        warehouse: { select: { guid: true, name: true, code: true } },
        priceType: { select: { guid: true, name: true, code: true } },
      },
    });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Соглашение ${guid} не найдено`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid,
      title: item.name,
      subtitle: item.number ? `№ ${item.number}${item.date ? ` от ${formatDate(item.date)}` : ''}` : null,
      sections: sections(
        section('Основное', [
          { label: 'Номер', value: item.number },
          { label: 'Дата', value: formatDate(item.date) },
          { label: 'Статус', value: item.status },
          { label: 'Согласовано', value: formatBoolean(item.isAgreed) },
          { label: 'Активно', value: formatBoolean(item.isActive) },
        ]),
        section('Связи', [
          { label: 'Организация', value: relationLabel(item.organization) },
          { label: 'Контрагент', value: relationLabel(item.counterparty) },
          { label: 'Договор', value: relationLabel(item.contract) },
          { label: 'Склад', value: relationLabel(item.warehouse) },
          { label: 'Вид цены', value: relationLabel(item.priceType) },
        ]),
        section('Условия', [
          { label: 'Валюта', value: item.currency },
          { label: 'Цена включает НДС', value: formatBoolean(item.priceIncludesVat) },
          { label: 'Ограничивать ручные скидки', value: formatBoolean(item.limitManualDiscounts) },
          { label: 'Ручная скидка, %', value: decimalToNumber(item.manualDiscountPercent) },
          { label: 'Ручная наценка, %', value: decimalToNumber(item.manualMarkupPercent) },
          { label: 'Минимальная сумма заказа', value: decimalToNumber(item.minOrderAmount) },
        ]),
        section('Период', [
          { label: 'Начало действия', value: formatDate(item.validFrom) },
          { label: 'Окончание действия', value: formatDate(item.validTo) },
          { label: 'Регулярное', value: formatBoolean(item.isRegular) },
          { label: 'Период', value: item.period },
          { label: 'Количество периодов', value: item.periodCount },
        ])
      ),
      debug: item,
    });
  }

  if (kind === 'contract') {
    const item = await prisma.clientContract.findFirst({
      where: { guid, isActive: true },
      include: {
        organization: { select: { guid: true, name: true, code: true } },
        counterparty: { select: { guid: true, name: true, inn: true, kpp: true } },
      },
    });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Договор ${guid} не найден`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid,
      title: item.name || item.number,
      subtitle: item.date ? `от ${formatDate(item.date)}` : null,
      sections: sections(
        section('Основное', [
          { label: 'Номер', value: item.number },
          { label: 'Дата', value: formatDate(item.date) },
          { label: 'Наименование', value: item.name },
          { label: 'Наименование для печати', value: item.printName },
          { label: 'Статус', value: item.status },
          { label: 'Тип договора', value: item.contractType },
          { label: 'Согласован', value: formatBoolean(item.isAgreed) },
          { label: 'Активен', value: formatBoolean(item.isActive) },
        ]),
        section('Связи', [
          { label: 'Организация', value: relationLabel(item.organization) },
          { label: 'Контрагент', value: relationLabel(item.counterparty) },
          { label: 'Партнер', value: item.partnerGuid },
          { label: 'Менеджер', value: item.managerGuid },
        ]),
        section('Условия', [
          { label: 'Валюта', value: item.currency },
          { label: 'Срок оплаты установлен', value: formatBoolean(item.hasPaymentTerm) },
          { label: 'Срок оплаты, дней', value: item.paymentTermDays },
          { label: 'Запрещать просроченную задолженность', value: formatBoolean(item.forbidOverdueDebt) },
          { label: 'Ограничивать сумму задолженности', value: formatBoolean(item.limitDebtAmount) },
          { label: 'Сумма', value: decimalToNumber(item.amount) },
          { label: 'Допустимая задолженность', value: decimalToNumber(item.allowedDebtAmount) },
        ]),
        section('НДС и доставка', [
          { label: 'Налогообложение НДС', value: item.vatTaxation },
          { label: 'Ставка НДС', value: item.vatRate },
          { label: 'НДС определяется в документе', value: formatBoolean(item.vatDefinedInDocument) },
          { label: 'Способ доставки', value: item.deliveryMethod },
          { label: 'Адрес доставки', value: item.deliveryAddress },
          { label: 'Доп. информация по доставке', value: item.additionalDeliveryInfo },
        ]),
        section('Период', [
          { label: 'Начало действия', value: formatDate(item.validFrom) },
          { label: 'Окончание действия', value: formatDate(item.validTo) },
          { label: 'Комментарий', value: item.comment },
        ])
      ),
      debug: item,
    });
  }

  if (kind === 'warehouse') {
    const item = await prisma.warehouse.findFirst({ where: { guid, isActive: true } });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Склад ${guid} не найден`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid,
      title: item.name,
      subtitle: item.code ? `Код ${item.code}` : item.address,
      sections: sections(
        section('Основное', [
          { label: 'Наименование', value: item.name },
          { label: 'Код', value: item.code },
          { label: 'Адрес', value: item.address },
          { label: 'По умолчанию', value: formatBoolean(item.isDefault) },
          { label: 'Самовывоз', value: formatBoolean(item.isPickup) },
          { label: 'Активен', value: formatBoolean(item.isActive) },
        ]),
        section('Синхронизация', [
          { label: 'Обновлено в источнике', value: item.sourceUpdatedAt },
          { label: 'Последняя синхронизация', value: item.lastSyncedAt },
        ])
      ),
      debug: item,
    });
  }

  if (kind === 'delivery-address') {
    const item = await prisma.deliveryAddress.findFirst({
      where: { guid, isActive: true },
      include: { counterparty: { select: { guid: true, name: true, inn: true, kpp: true } } },
    });
    if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Адрес доставки ${guid} не найден`);
    return referenceDetailsResponse({
      kind,
      guid: item.guid || guid,
      title: item.name || item.fullAddress,
      subtitle: relationLabel(item.counterparty),
      sections: sections(
        section('Адрес', [
          { label: 'Название', value: item.name },
          { label: 'Полный адрес', value: item.fullAddress },
          { label: 'Индекс', value: item.postcode },
          { label: 'Город', value: item.city },
          { label: 'Улица', value: item.street },
          { label: 'Дом', value: item.house },
          { label: 'Корпус', value: item.building },
          { label: 'Квартира/офис', value: item.apartment },
        ]),
        section('Связи', [
          { label: 'Контрагент', value: relationLabel(item.counterparty) },
          { label: 'По умолчанию', value: formatBoolean(item.isDefault) },
          { label: 'Активен', value: formatBoolean(item.isActive) },
        ])
      ),
      debug: item,
    });
  }

  const item = await prisma.priceType.findFirst({ where: { guid, isActive: true } });
  if (!item) throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Вид цены ${guid} не найден`);
  return referenceDetailsResponse({
    kind,
    guid: item.guid,
    title: item.name,
    subtitle: item.code ? `Код ${item.code}` : null,
    sections: sections(
      section('Основное', [
        { label: 'Наименование', value: item.name },
        { label: 'Код', value: item.code },
        { label: 'Активен', value: formatBoolean(item.isActive) },
      ]),
      section('Синхронизация', [
        { label: 'Обновлено в источнике', value: item.sourceUpdatedAt },
        { label: 'Последняя синхронизация', value: item.lastSyncedAt },
      ])
    ),
    debug: item,
  });
  */
}

export async function updateClientOrderSettings(userId: number, body: ClientOrderSettingsUpdateBody) {
  const existing = await getRawClientOrderSettings(userId);

  let preferredOrganizationId = existing?.preferredOrganizationId ?? null;
  if (body.preferredOrganizationGuid !== undefined) {
    if (!body.preferredOrganizationGuid) {
      preferredOrganizationId = null;
    } else {
      const liveOrganization = await onecLive(
        () => readThroughClientOrdersCache(
          'reference:organization',
          { guid: body.preferredOrganizationGuid },
          CLIENT_ORDERS_CACHE_TTL.referenceDetails,
          () => findLiveOrganization(body.preferredOrganizationGuid!)
        ),
        'Ошибка получения организации из 1С',
        { allowCachedWhenCircuitOpen: true }
      );
      await prisma.$transaction(async (tx) => {
        await upsertLiveOrganization(tx, liveOrganization, now());
      });
      preferredOrganizationId = (await loadOrganizationByGuid(prisma as unknown as Tx, body.preferredOrganizationGuid)).id;
    }
  }

  const deliveryDateMode = DEFAULT_DELIVERY_DATE_MODE;
  const deliveryDateOffsetDays = DEFAULT_DELIVERY_DATE_OFFSET_DAYS;
  const fixedDeliveryDate: Date | null = null;

  await prisma.clientOrderUserSettings.upsert({
    where: { userId },
    create: {
      userId,
      preferredOrganizationId,
      deliveryDateMode,
      deliveryDateOffsetDays,
      fixedDeliveryDate,
    },
    update: {
      preferredOrganizationId,
      deliveryDateMode,
      deliveryDateOffsetDays,
      fixedDeliveryDate,
    },
  });

  return getClientOrderSettings(userId);
}

async function getLocalClientOrderDefaults(userId: number, query: ClientOrderDefaultsQuery) {
  const [settings, organization, counterparty, rememberedDefaults, defaultWarehouse] = await Promise.all([
    getRawClientOrderSettings(userId),
    prisma.organization.findFirst({
      where: { guid: query.organizationGuid, isActive: true },
      select: { id: true, guid: true, name: true, code: true },
    }),
    prisma.counterparty.findFirst({
      where: { guid: query.counterpartyGuid, isActive: true },
      select: {
        id: true,
        guid: true,
        name: true,
        fullName: true,
        inn: true,
        defaultAgreement: {
          where: activeAgreementWhere(),
          select: {
            guid: true,
            name: true,
            currency: true,
            isActive: true,
            contract: { where: activeContractWhere(), select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true } },
            warehouse: { select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true } },
            priceType: { select: { guid: true, name: true } },
          },
        },
        defaultContract: {
          where: activeContractWhere(),
          select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true },
        },
        defaultWarehouse: {
          where: { isActive: true },
          select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true },
        },
        defaultDeliveryAddress: {
          where: { isActive: true },
          select: { guid: true, name: true, fullAddress: true, isDefault: true, isActive: true },
        },
        addresses: {
          where: { isActive: true },
          orderBy: [{ isDefault: 'desc' }, { fullAddress: 'asc' }],
          select: { guid: true, name: true, fullAddress: true, isDefault: true, isActive: true },
        },
      },
    }),
    prisma.clientOrderUserCounterpartyDefaults.findFirst({
      where: {
        userId,
        organization: { guid: query.organizationGuid },
        counterparty: { guid: query.counterpartyGuid },
      },
      select: {
        agreement: {
          where: activeAgreementWhere(),
          select: {
            guid: true,
            name: true,
            currency: true,
            isActive: true,
            contract: { where: activeContractWhere(), select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true } },
            warehouse: { select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true } },
            priceType: { select: { guid: true, name: true } },
          },
        },
        contract: {
          where: activeContractWhere(),
          select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true },
        },
        warehouse: {
          where: { isActive: true },
          select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true },
        },
        deliveryAddress: {
          where: { isActive: true },
          select: { guid: true, name: true, fullAddress: true, isDefault: true, isActive: true },
        },
      },
    }),
    prisma.warehouse.findFirst({
      where: { isActive: true, isDefault: true },
      orderBy: [{ name: 'asc' }],
      select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true },
    }),
  ]);

  if (!organization) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Организация ${query.organizationGuid} не найдена`);
  }
  if (!counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }

  const [organizationAgreement, organizationContract] = await Promise.all([
    prisma.clientAgreement.findFirst({
      where: {
        ...activeAgreementWhere(),
        counterpartyId: counterparty.id,
        organizationId: organization.id,
      },
      orderBy: [{ isAgreed: 'desc' }, { date: 'desc' }, { name: 'asc' }],
      select: {
        guid: true,
        name: true,
        currency: true,
        isActive: true,
        contract: { where: activeContractWhere(), select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true } },
        warehouse: { select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true } },
        priceType: { select: { guid: true, name: true } },
      },
    }),
    prisma.clientContract.findFirst({
      where: {
        ...activeContractWhere(),
        counterpartyId: counterparty.id,
        organizationId: organization.id,
      },
      orderBy: [{ isAgreed: 'desc' }, { date: 'desc' }, { number: 'asc' }],
      select: { guid: true, number: true, date: true, validFrom: true, validTo: true, status: true, purpose: true, isActive: true },
    }),
  ]);

  const deliveryDateResolution = resolveDeliveryDateSettings(settings);

  const agreement = pickFirst(
    mapAgreementSummary(rememberedDefaults?.agreement ?? null),
    mapAgreementSummary(counterparty.defaultAgreement ?? null),
    mapAgreementSummary(organizationAgreement ?? null)
  );
  const contract = pickFirst(
    mapContractSummary(rememberedDefaults?.contract ?? null),
    mapContractSummary(counterparty.defaultContract ?? null),
    agreement?.contract ? mapContractSummary({ ...agreement.contract, isActive: true }) : null,
    mapContractSummary(organizationContract ?? null)
  );
  const warehouse = pickFirst(
    mapWarehouseSummary(rememberedDefaults?.warehouse ?? null),
    mapWarehouseSummary(counterparty.defaultWarehouse ?? null),
    agreement?.warehouse ? mapWarehouseSummary({ ...agreement.warehouse, isActive: true }) : null,
    mapWarehouseSummary(defaultWarehouse ?? null)
  );
  const deliveryAddress = pickFirst(
    mapDeliveryAddressSummary(rememberedDefaults?.deliveryAddress ?? null),
    mapDeliveryAddressSummary(counterparty.defaultDeliveryAddress ?? null),
    mapDeliveryAddressSummary(counterparty.addresses.find((item) => item.isDefault) ?? null),
    counterparty.addresses.length === 1 ? mapDeliveryAddressSummary(counterparty.addresses[0]) : null
  );

  return {
    organization: mapOrganizationSummary(organization),
    counterparty: {
      guid: counterparty.guid,
      name: counterparty.name,
      fullName: counterparty.fullName ?? null,
      inn: counterparty.inn ?? null,
    },
    agreement,
    contract,
    warehouse,
    deliveryAddress,
    paymentForm: null,
    paymentForms: clientOrderPaymentFormOptions(),
    deliveryMethod: CLIENT_ORDER_DELIVERY_METHOD_TO_CLIENT,
    deliveryMethods: clientOrderDeliveryMethodOptions(),
    currency: DEFAULT_ORDER_CURRENCY,
    deliveryDate: deliveryDateResolution.resolvedDate,
    deliveryDateIssue: deliveryDateResolution.issue,
    deliveryDateIssueMessage: formatDeliveryDateIssue(deliveryDateResolution.issue),
    discountsEnabled: false,
  };
}

function mapLiveDefaults(defaults: LiveClientOrderDefaults, deliveryDateResolution: DeliveryDateResolution) {
  const agreement = mapAgreementSummary(defaults.agreement);
  const contract = mapContractSummary(defaults.contract ?? agreement?.contract ?? null);
  const warehouse = mapWarehouseSummary(defaults.warehouse ?? defaults.agreement?.warehouse ?? null);
  const deliveryAddress = mapDeliveryAddressSummary(defaults.deliveryAddress);
  const priceType = defaults.priceType ?? defaults.agreement?.priceType ?? null;
  return {
    organization: mapOrganizationSummary(defaults.organization),
    counterparty: defaults.counterparty
      ? {
          guid: defaults.counterparty.guid,
          name: defaults.counterparty.name,
          fullName: defaults.counterparty.fullName ?? null,
          inn: defaults.counterparty.inn ?? null,
          kpp: defaults.counterparty.kpp ?? null,
        }
      : null,
    agreement,
    contract,
    warehouse,
    deliveryAddress,
    priceType,
    paymentForm: null,
    paymentForms: clientOrderPaymentFormOptions(),
    deliveryMethod: CLIENT_ORDER_DELIVERY_METHOD_TO_CLIENT,
    deliveryMethods: clientOrderDeliveryMethodOptions(),
    currency: defaults.currency || DEFAULT_ORDER_CURRENCY,
    deliveryDate: deliveryDateResolution.resolvedDate,
    deliveryDateIssue: deliveryDateResolution.issue,
    deliveryDateIssueMessage: formatDeliveryDateIssue(deliveryDateResolution.issue),
    discountsEnabled: false,
    warnings: defaults.warnings,
  };
}

export async function getClientOrderDefaults(userId: number, query: ClientOrderDefaultsQuery) {
  const settings = await getRawClientOrderSettings(userId);
  const deliveryDateResolution = resolveDeliveryDateSettings(settings);
  try {
    const defaults = await onecLive(
      () => readThroughClientOrdersCache(
        'defaults',
        query,
        CLIENT_ORDERS_CACHE_TTL.defaults,
        () => getLiveClientOrderDefaults(query)
      ),
      'Ошибка получения подсказок по умолчанию из 1С',
      { allowCachedWhenCircuitOpen: true }
    );
    try {
      await materializeLiveDefaultsReferences(defaults);
    } catch {
      // Defaults are still useful to the app even if local snapshot caching failed.
    }
    return mapLiveDefaults(defaults, deliveryDateResolution);
  } catch (error) {
    if (isOnecLpAppError(error) || (error instanceof ClientOrdersError && error.status === 502)) {
      try {
        const localDefaults = await getLocalClientOrderDefaults(userId, query);
        return {
          ...localDefaults,
          warnings: ['1С временно недоступна, использованы локальные подсказки.'],
        };
      } catch {
        return {
          organization: null,
          counterparty: null,
          agreement: null,
          contract: null,
          warehouse: null,
          deliveryAddress: null,
          priceType: null,
          currency: DEFAULT_ORDER_CURRENCY,
          deliveryDate: deliveryDateResolution.resolvedDate,
          deliveryDateIssue: deliveryDateResolution.issue,
          deliveryDateIssueMessage: formatDeliveryDateIssue(deliveryDateResolution.issue),
          discountsEnabled: false,
          warnings: ['1С временно недоступна, подсказки по умолчанию не загружены.'],
        };
      }
    }
    throw error;
  }
}

export async function getClientOrdersReferenceData(query: ClientOrdersReferenceDataQuery) {
  return onecLive(
    () => readThroughClientOrdersCache(
      'reference-data',
      query,
      CLIENT_ORDERS_CACHE_TTL.referenceData,
      () => getLiveReferenceData(query)
    ),
    'Ошибка получения справочников из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
}

type ClientOrdersCounterpartySearchItem = {
  guid: string;
  name: string;
  fullName: string | null;
  inn: string | null;
  kpp: string | null;
  phone?: string | null;
  email?: string | null;
  isActive: boolean;
  managerGuid?: string | null;
  managerName?: string | null;
  manager?: { guid?: string | null; name?: string | null } | null;
};

async function getCounterpartiesFallback(
  query: ClientOrdersCounterpartiesQuery,
  search: string,
  managerGuid?: string | null
): Promise<PagedResult<ClientOrdersCounterpartySearchItem>> {
  const and: Prisma.CounterpartyWhereInput[] = [];

  if (search) {
    and.push({
      OR: [
        { guid: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
        { inn: { contains: search, mode: 'insensitive' } },
        { kpp: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  if (managerGuid) {
    and.push({
      OR: [
        { agreements: { some: { managerGuid } } },
        { contracts: { some: { managerGuid } } },
      ],
    });
  }

  const where: Prisma.CounterpartyWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(and.length ? { AND: and } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.counterparty.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: query.offset,
      take: query.limit,
      select: { guid: true, name: true, fullName: true, inn: true, kpp: true, isActive: true },
    }),
    prisma.counterparty.count({ where }),
  ]);

  return {
    items: items.map((item) => (managerGuid ? { ...item, managerGuid } : item)),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrdersCounterparties(
  query: ClientOrdersCounterpartiesQuery,
  userId?: number
): Promise<PagedResult<ClientOrdersCounterpartySearchItem>> {
  const search = (query.search || '').trim();
  const managerGuid = query.managerOnly ? (userId ? await getManagerGuidForUser(userId) : null) : null;
  if (query.managerOnly && !managerGuid) {
    return {
      items: [],
      total: 0,
      limit: query.limit,
      offset: query.offset,
    };
  }
  const liveQuery = managerGuid
    ? ({ ...query, managerGuid } as ClientOrdersCounterpartiesQuery & { managerGuid: string })
    : query;
  try {
    return await onecLive(
      () => readThroughClientOrdersCache(
        'counterparties',
        liveQuery,
        CLIENT_ORDERS_CACHE_TTL.counterparties,
        () => getLiveCounterparties(liveQuery)
      ),
      'Ошибка получения контрагентов из 1С',
      { allowCachedWhenCircuitOpen: true }
    );
  } catch (error) {
    if (isOnecLpAppError(error) || (error instanceof ClientOrdersError && error.status === 502)) {
      return getCounterpartiesFallback(query, search, managerGuid);
    }
    throw error;
  }
}

async function resolveCounterpartyIdOrNull(counterpartyGuid?: string) {
  if (!counterpartyGuid) return null;
  const counterparty = await prisma.counterparty.findUnique({
    where: { guid: counterpartyGuid },
    select: { id: true, isActive: true },
  });
  if (!counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${counterpartyGuid} не найден`);
  }
  if (counterparty.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${counterpartyGuid} неактивен`);
  }
  return counterparty.id;
}

export async function getClientOrdersAgreements(query: ClientOrdersAgreementsQuery) {
  try {
    const result = await onecLive(
      () => readThroughClientOrdersCache(
        'agreements',
        query,
        CLIENT_ORDERS_CACHE_TTL.agreements,
        () => getLiveAgreements(query)
      ),
      'Ошибка получения соглашений из 1С',
      { allowCachedWhenCircuitOpen: true }
    );
    if (result.items.length || !query.organizationGuid || !query.counterpartyGuid) return result;
  } catch (error) {
    if (!(isOnecLpAppError(error) || (error instanceof ClientOrdersError && error.status === 502))) throw error;
  }

  if (!query.organizationGuid || !query.counterpartyGuid) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }

  const defaultsQuery = { organizationGuid: query.organizationGuid!, counterpartyGuid: query.counterpartyGuid! };
  const defaults = await onecLive(
    () => readThroughClientOrdersCache(
      'defaults',
      defaultsQuery,
      CLIENT_ORDERS_CACHE_TTL.defaults,
      () => getLiveClientOrderDefaults(defaultsQuery)
    ),
    'Ошибка получения соглашения по умолчанию из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
  const agreement = mapAgreementSummary(defaults.agreement);
  return {
    items: agreement ? [agreement] : [],
    total: agreement ? 1 : 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrdersContracts(query: ClientOrdersContractsQuery) {
  try {
    const result = filterSelectableContracts(await onecLive(
      () => readThroughClientOrdersCache(
        'contracts',
        query,
        CLIENT_ORDERS_CACHE_TTL.contracts,
        () => getLiveContracts(query)
      ),
      'Ошибка получения договоров из 1С',
      { allowCachedWhenCircuitOpen: true }
    ));
    if (result.items.length || !query.organizationGuid || !query.counterpartyGuid) return result;
  } catch (error) {
    if (!(isOnecLpAppError(error) || (error instanceof ClientOrdersError && error.status === 502))) throw error;
  }

  if (!query.organizationGuid || !query.counterpartyGuid) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }

  const defaultsQuery = { organizationGuid: query.organizationGuid!, counterpartyGuid: query.counterpartyGuid! };
  const defaults = await onecLive(
    () => readThroughClientOrdersCache(
      'defaults',
      defaultsQuery,
      CLIENT_ORDERS_CACHE_TTL.defaults,
      () => getLiveClientOrderDefaults(defaultsQuery)
    ),
    'Ошибка получения договора по умолчанию из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
  const contract = mapContractSummary(defaults.contract);
  const selectableContract = isSelectableContract(contract) ? contract : null;
  return {
    items: selectableContract ? [selectableContract] : [],
    total: selectableContract ? 1 : 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrdersWarehouses(query: ClientOrdersWarehousesQuery) {
  return onecLive(
    () => readThroughClientOrdersCache(
      'warehouses',
      query,
      CLIENT_ORDERS_CACHE_TTL.warehouses,
      () => getLiveWarehouses(query)
    ),
    'Ошибка получения складов из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
}

export async function getClientOrdersPriceTypes(query: ClientOrdersPriceTypesQuery) {
  return onecLive(
    () => readThroughClientOrdersCache(
      'price-types',
      query,
      CLIENT_ORDERS_CACHE_TTL.priceTypes,
      () => getLivePriceTypes(query)
    ),
    'Ошибка получения видов цен из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
}

export async function getClientOrdersDeliveryAddresses(query: ClientOrdersDeliveryAddressesQuery) {
  return onecLive(
    () => readThroughClientOrdersCache(
      'delivery-addresses',
      query,
      CLIENT_ORDERS_CACHE_TTL.deliveryAddresses,
      () => getLiveDeliveryAddresses(query)
    ),
    'Ошибка получения адресов доставки из 1С',
    { allowCachedWhenCircuitOpen: true }
  );
}

type ProductSearchRow = {
  id: string;
  guid: string;
  name: string;
  code: string | null;
  article: string | null;
  sku: string | null;
  isWeight: boolean;
};

function productInStockWhere(query: ClientOrdersProductsQuery): Prisma.ProductWhereInput {
  if (!query.inStockOnly) return {};
  return {
    stocks: {
      some: {
        ...(query.warehouseGuid ? { warehouse: { guid: query.warehouseGuid } } : {}),
        OR: [
          { available: { gt: 0 } },
          { inStock: { gt: 0 } },
          { quantity: { gt: 0 } },
        ],
      },
    },
  };
}

async function getProductsFallback(
  query: ClientOrdersProductsQuery,
  search: string
): Promise<PagedResult<ProductSearchRow>> {
  const where: Prisma.ProductWhereInput = {
    isActive: true,
    AND: [
      {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { code: { contains: search, mode: 'insensitive' } },
          { article: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
        ],
      },
      productInStockWhere(query),
    ],
  };
  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: query.offset,
      take: query.limit,
      select: {
        id: true,
        guid: true,
        name: true,
        code: true,
        article: true,
        sku: true,
        isWeight: true,
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

async function getRankedProducts(query: ClientOrdersProductsQuery, search: string): Promise<PagedResult<ProductSearchRow>> {
  if (query.inStockOnly) {
    return getProductsFallback(query, search);
  }
  const patterns = likeSearchPatterns(search);
  try {
    const items = await prisma.$queryRaw<ProductSearchRow[]>(Prisma.sql`
      SELECT
        p.id,
        p.guid,
        p.name,
        p.code,
        p.article,
        p.sku,
        p."isWeight" AS "isWeight"
      FROM "Product" p
      WHERE p."isActive" = TRUE
        AND (
          p.guid = ${search}
          OR
          lower(coalesce(p.code, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.article, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.sku, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.name, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR similarity(lower(unaccent(coalesce(p.name, ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
        )
      ORDER BY
        CASE
          WHEN p.guid = ${search} THEN 0
          WHEN lower(coalesce(p.code, '')) = ${patterns.exact} THEN 0
          WHEN lower(coalesce(p.article, '')) = ${patterns.exact} THEN 1
          WHEN lower(coalesce(p.sku, '')) = ${patterns.exact} THEN 2
          WHEN lower(unaccent(coalesce(p.name, ''))) = lower(unaccent(${search})) THEN 3
          WHEN lower(coalesce(p.code, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 4
          WHEN lower(coalesce(p.article, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 5
          WHEN lower(coalesce(p.sku, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 6
          WHEN lower(coalesce(p.name, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 7
          ELSE 20
        END ASC,
        GREATEST(
          similarity(lower(unaccent(coalesce(p.name, ''))), lower(unaccent(${search}))),
          similarity(lower(coalesce(p.code, '')), ${patterns.exact}),
          similarity(lower(coalesce(p.article, '')), ${patterns.exact}),
          similarity(lower(coalesce(p.sku, '')), ${patterns.exact})
        ) DESC,
        p.name ASC
      LIMIT ${query.limit}
      OFFSET ${query.offset}
    `);

    const totalRows = await prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS total
      FROM "Product" p
      WHERE p."isActive" = TRUE
        AND (
          p.guid = ${search}
          OR
          lower(coalesce(p.code, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.article, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.sku, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(p.name, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR similarity(lower(unaccent(coalesce(p.name, ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
        )
    `);

    return {
      items,
      total: asNumberCount(totalRows[0]?.total),
      limit: query.limit,
      offset: query.offset,
    };
  } catch (error) {
    if (!isSmartSearchExtensionError(error)) throw error;
    return getProductsFallback(query, search);
  }
}

export async function getClientOrdersProducts(query: ClientOrdersProductsQuery, userId?: number | null) {
  const managerGuid = userId ? await getManagerGuidForUser(userId) : null;
  const liveQuery: ManagerAwareProductsQuery = managerGuid ? { ...query, managerGuid } : query;
  const result = await onecLive(
    () => readThroughClientOrdersCache(
      'products',
      liveQuery,
      CLIENT_ORDERS_CACHE_TTL.products,
      () => getLiveProducts(liveQuery),
      { shouldOpenCircuit: shouldOpenClientOrdersOnecCircuit }
    ),
    'Ошибка получения номенклатуры из 1С',
    { allowCachedWhenCircuitOpen: true }
  );

  return {
    ...result,
    items: await enrichProductsWithImages(result.items),
  };

  /*
  const at = now();
  const search = normalizeSearch(query.search);
  const contextCounterparty = query.counterpartyGuid
    ? await prisma.counterparty.findUnique({
        where: { guid: query.counterpartyGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;

  if (query.counterpartyGuid && !contextCounterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }
  if (contextCounterparty?.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${query.counterpartyGuid} неактивен`);
  }

  const agreement = query.agreementGuid
    ? await prisma.clientAgreement.findUnique({
        where: { guid: query.agreementGuid },
        select: {
          id: true,
          guid: true,
          isActive: true,
          status: true,
          counterpartyId: true,
          priceTypeId: true,
          priceType: { select: { guid: true, name: true } },
        },
      })
    : null;

  if (query.agreementGuid && !agreement) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Соглашение ${query.agreementGuid} не найдено`);
  }
  if (agreement?.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${query.agreementGuid} неактивно`);
  }
  if (agreement && isClosedAgreementStatus(agreement.status)) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Соглашение ${query.agreementGuid} закрыто и не может использоваться в заказе`);
  }
  if (agreement?.counterpartyId && contextCounterparty && agreement.counterpartyId !== contextCounterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Соглашение не принадлежит выбранному контрагенту');
  }

  const explicitPriceType = query.priceTypeGuid
    ? await prisma.priceType.findUnique({
        where: { guid: query.priceTypeGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;
  if (query.priceTypeGuid && !explicitPriceType) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Тип цены ${query.priceTypeGuid} не найден`);
  }
  if (explicitPriceType?.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Тип цены ${query.priceTypeGuid} неактивен`);
  }

  const warehouse = query.warehouseGuid
    ? await prisma.warehouse.findUnique({
        where: { guid: query.warehouseGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;
  if (query.warehouseGuid && !warehouse) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Склад ${query.warehouseGuid} не найден`);
  }
  if (warehouse?.isActive === false) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Склад ${query.warehouseGuid} неактивен`);
  }

  const rankedProducts = search
    ? await getRankedProducts(query, search)
    : {
        items: await prisma.product.findMany({
          where: { isActive: true, ...productInStockWhere(query) },
          orderBy: [{ name: 'asc' }],
          skip: query.offset,
          take: query.limit,
          select: {
            id: true,
            guid: true,
            name: true,
            code: true,
            article: true,
            sku: true,
            isWeight: true,
          },
        }),
        total: await prisma.product.count({ where: { isActive: true, ...productInStockWhere(query) } }),
        limit: query.limit,
        offset: query.offset,
      };

  const productIds = rankedProducts.items.map((item) => item.id);
  const records = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          guid: true,
          name: true,
          code: true,
          article: true,
          sku: true,
          isWeight: true,
          baseUnit: { select: { guid: true, name: true, symbol: true } },
          packages: {
            orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
            select: {
              guid: true,
              name: true,
              multiplier: true,
              isDefault: true,
              unit: { select: { guid: true, name: true, symbol: true } },
            },
          },
        },
      })
    : [];

  const recordMap = new Map(records.map((item) => [item.id, item]));
  const stockByProductId = warehouse && productIds.length
    ? new Map(
        (
          await prisma.stockBalance.groupBy({
            by: ['productId'],
            where: { warehouseId: warehouse.id, productId: { in: productIds } },
            _sum: { quantity: true, reserved: true, available: true },
          })
        ).map((item) => [
          item.productId,
          {
            quantity: decimalToNumber(item._sum.quantity),
            reserved: decimalToNumber(item._sum.reserved),
            available: decimalToNumber(item._sum.available),
          },
        ])
      )
    : new Map<string, { quantity: number | null; reserved: number | null; available: number | null }>();
  const receiptPriceByProductId = await loadReceiptPriceInfoByProductId(prisma as unknown as Tx, productIds, at);
  const items = await Promise.all(
    rankedProducts.items.map(async (ranked) => {
      const product = recordMap.get(ranked.id);
      if (!product) return null;
      const receiptPrice = receiptPriceByProductId.get(product.id) ?? null;

      try {
        if (!receiptPrice) {
          throw new MarketplaceError(404, ErrorCodes.NOT_FOUND, `Не найдена начальная цена ЦенаПоступления для товара ${formatProductLabel(product)}`);
        }

        return {
          guid: product.guid,
          name: product.name,
          code: product.code,
          article: product.article,
          sku: product.sku,
          isWeight: product.isWeight,
          baseUnit: product.baseUnit,
          packages: mapProductPackagesForClient(product),
          basePrice: receiptPrice.value,
          receiptPrice: receiptPrice.value,
          currency: DEFAULT_ORDER_CURRENCY,
          priceType: { guid: receiptPrice.priceType.guid, name: receiptPrice.priceType.name },
          priceMatch: { source: 'product-prices', level: 'ЦенаПоступления', minQty: receiptPrice.minQty },
          priceError: null,
          stock: stockByProductId.get(product.id) ?? null,
        };
      } catch (error) {
        if (error instanceof MarketplaceError) {
          return {
            guid: product.guid,
            name: product.name,
            code: product.code,
            article: product.article,
            sku: product.sku,
            isWeight: product.isWeight,
            baseUnit: product.baseUnit,
            packages: mapProductPackagesForClient(product),
            basePrice: null,
            receiptPrice: null,
            currency: DEFAULT_ORDER_CURRENCY,
            priceType: null,
            priceMatch: null,
            priceError: error.message,
            stock: stockByProductId.get(product.id) ?? null,
          };
        }
        throw error;
      }
    })
  );

  return {
    items: items.filter(Boolean),
    total: rankedProducts.total,
    limit: rankedProducts.limit,
    offset: rankedProducts.offset,
  };
  */
}

export async function getClientOrdersProductsByGuids(body: ClientOrdersBatchProductsBody, userId?: number | null) {
  const managerGuid = userId ? await getManagerGuidForUser(userId) : null;
  const liveBody: ManagerAwareBatchProductsBody = managerGuid ? { ...body, managerGuid } : body;
  const items = await onecLive(
    () => readThroughClientOrdersCache(
      'products:batch',
      { ...liveBody, productGuids: [...new Set(liveBody.productGuids)].sort() },
      CLIENT_ORDERS_CACHE_TTL.productsBatch,
      () => getLiveProductsByGuids(liveBody),
      { shouldOpenCircuit: shouldOpenClientOrdersOnecCircuit }
    ),
    'Ошибка получения номенклатуры из 1С',
    { allowCachedWhenCircuitOpen: true }
  );

  return enrichProductsWithImages(items);

  /*
  const uniqueGuids = [...new Set(body.productGuids)];
  const products = await prisma.product.findMany({
    where: { guid: { in: uniqueGuids }, isActive: true },
    select: {
      id: true,
      guid: true,
      name: true,
      code: true,
      article: true,
      sku: true,
      isWeight: true,
      baseUnit: { select: { guid: true, name: true, symbol: true } },
      packages: {
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          guid: true,
          name: true,
          multiplier: true,
          isDefault: true,
          unit: { select: { guid: true, name: true, symbol: true } },
        },
      },
    },
  });

  const productIds = products.map((product) => product.id);
  const [stockByProductId, receiptPriceByProductId] = await Promise.all([
    loadStockByProductIdForWarehouse(prisma as unknown as Tx, body.warehouseGuid, productIds),
    loadReceiptPriceInfoByProductId(prisma as unknown as Tx, productIds, now()),
  ]);
  const productByGuid = new Map(products.map((product) => [product.guid, product]));

  return uniqueGuids.flatMap((guid) => {
    const product = productByGuid.get(guid);
    if (!product) return [];
    const receiptPrice = receiptPriceByProductId.get(product.id) ?? null;
    return [{
      guid: product.guid,
      name: product.name,
      code: product.code,
      article: product.article,
      sku: product.sku,
      isWeight: product.isWeight,
      baseUnit: product.baseUnit,
      packages: mapProductPackagesForClient(product),
      basePrice: receiptPrice?.value ?? null,
      receiptPrice: receiptPrice?.value ?? null,
      currency: DEFAULT_ORDER_CURRENCY,
      priceType: receiptPrice
        ? { guid: receiptPrice.priceType.guid, name: receiptPrice.priceType.name }
        : null,
      priceMatch: receiptPrice
        ? { source: 'product-prices', level: 'ЦенаПоступления', minQty: receiptPrice.minQty }
        : null,
      priceError: receiptPrice
        ? null
        : `Не найдена начальная цена ЦенаПоступления для товара ${formatProductLabel(product)}`,
      stock: stockByProductId.get(product.id) ?? null,
    }];
  });
  */
}

export async function createClientOrder(userId: number, body: ClientOrderCreateBody) {
  const sourceUpdatedAt = now();
  const managerGuid = await getManagerGuidForUser(userId);
  const liveReferences = await loadLiveOrderMaterialization(body, managerGuid);

  const created = await prisma.$transaction(async (tx) => {
    await materializeLiveOrderReferences(tx, liveReferences, body, sourceUpdatedAt);
    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
    const trackingSnapshot = await resolveActiveTrackingOrderSnapshot(tx, userId);
    const guid = randomUUID();

    const order = await tx.order.create({
      data: {
        guid,
        source: OrderSource.MANAGER_APP,
        revision: 1,
        syncState: OrderSyncState.DRAFT,
        status: OrderStatus.DRAFT,
        organizationId: context.organization.id,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId: context.contract?.id ?? context.agreement?.contractId ?? null,
        warehouseId: context.warehouse?.id ?? context.agreement?.warehouseId ?? null,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        priceTypeId: context.priceType?.id ?? null,
        createdByUserId: userId,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? defaultDeliveryDate(),
        paymentForm: body.paymentForm ?? null,
        deliveryMethod: body.deliveryMethod ?? null,
        trackingRoutePointId: trackingSnapshot?.routePointId ?? null,
        trackingSnapshot: trackingSnapshot?.snapshot ?? undefined,
        currency: DEFAULT_ORDER_CURRENCY,
        totalAmount: prepared.totalAmount,
        generalDiscountPercent:
          body.generalDiscountPercent !== null && body.generalDiscountPercent !== undefined
            ? toDecimal(body.generalDiscountPercent)
            : null,
        generalDiscountAmount: prepared.generalDiscountAmount,
        sourceUpdatedAt,
        items: {
          create: prepared.items.map((item) => item.create),
        },
      },
      select: { id: true, guid: true, revision: true },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: order.revision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_CREATED',
      actorUserId: userId,
      payload: {
        organizationGuid: context.organization.guid,
        priceTypeGuid: context.priceType?.guid ?? null,
        saveReason: body.saveReason,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
        paymentForm: body.paymentForm ?? null,
        deliveryMethod: body.deliveryMethod ?? null,
        trackingSnapshot: trackingSnapshot?.snapshot ?? null,
        generalDiscountPercent: body.generalDiscountPercent ?? null,
        items: prepared.items.map((item) => item.snapshot),
      } as Prisma.InputJsonValue,
    });

    return order.guid!;
  });

  return getClientOrderByGuid(created, userId);
}

function dateForCreatePayload(value: unknown) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function getCopyEntityGuid(value: unknown, label: string) {
  const guid = (value && typeof value === 'object' && 'guid' in value ? (value as { guid?: unknown }).guid : null);
  if (typeof guid === 'string' && guid.trim()) return guid.trim();
  throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Нельзя скопировать заказ: не заполнено поле ${label}`);
}

function buildClientOrderCopyPayload(source: any): ClientOrderCreateBody {
  const items = Array.isArray(source?.items) ? source.items : [];
  if (!items.length) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Нельзя скопировать заказ без товаров');
  }

  return {
    organizationGuid: getCopyEntityGuid(source.organization, 'организация'),
    counterpartyGuid: getCopyEntityGuid(source.counterparty, 'контрагент'),
    agreementGuid: source.agreement?.guid ?? null,
    contractGuid: source.contract?.guid ?? null,
    warehouseGuid: source.warehouse?.guid ?? null,
    deliveryAddressGuid: source.deliveryAddress?.guid ?? null,
    priceTypeGuid: source.priceType?.guid ?? source.agreement?.priceType?.guid ?? null,
    deliveryDate: dateForCreatePayload(source.deliveryDate),
    paymentForm: source.paymentForm ?? null,
    deliveryMethod: source.deliveryMethod ?? null,
    comment: source.comment ?? undefined,
    currency: source.currency ?? DEFAULT_ORDER_CURRENCY,
    saveReason: 'manual',
    generalDiscountPercent: source.generalDiscountPercent ?? null,
    items: items.map((item: any) => {
      const productGuid = getCopyEntityGuid(item.product, 'товар');
      const isManualPrice = !!item.isManualPrice || item.manualPrice !== null && item.manualPrice !== undefined;
      const manualPrice = isManualPrice
        ? item.manualPrice ?? item.basePrice ?? item.price ?? null
        : undefined;
      return {
        productGuid,
        packageGuid: item.package?.guid || undefined,
        priceTypeGuid: isManualPrice ? null : item.priceType?.guid ?? source.priceType?.guid ?? source.agreement?.priceType?.guid ?? null,
        quantity: Number(item.quantity ?? 0),
        manualPrice,
        discountPercent: item.discountPercent ?? null,
        comment: item.comment ?? undefined,
      };
    }),
  };
}

export function resolveUpdatedOrderQueueState(currentStatus: OrderStatus) {
  const shouldQueueForExport = currentStatus === OrderStatus.SENT_TO_1C || currentStatus === OrderStatus.QUEUED;

  return {
    shouldQueueForExport,
    status: shouldQueueForExport ? OrderStatus.QUEUED : OrderStatus.DRAFT,
    syncState: shouldQueueForExport ? OrderSyncState.QUEUED : OrderSyncState.DRAFT,
  };
}

export async function updateClientOrder(guid: string, userId: number, body: ClientOrderUpdateBody) {
  const sourceUpdatedAt = now();
  const managerGuid = await getManagerGuidForUser(userId);
  const liveReferences = await loadLiveOrderMaterialization(body, managerGuid);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
        hasRealization: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    await materializeLiveOrderReferences(tx, liveReferences, body, sourceUpdatedAt);
    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
    const nextRevision = order.revision + 1;
    const isAutosave = body.saveReason === 'autosave';
    const queueState = resolveUpdatedOrderQueueState(order.status);
    const trackingSnapshot = await resolveActiveTrackingOrderSnapshot(tx, userId);

    await tx.orderItem.deleteMany({ where: { orderId: order.id } });

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: queueState.status,
        syncState: queueState.syncState,
        queuedAt: queueState.shouldQueueForExport ? sourceUpdatedAt : null,
        exportAttempts: queueState.shouldQueueForExport ? 0 : undefined,
        organizationId: context.organization.id,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId: context.contract?.id ?? context.agreement?.contractId ?? null,
        warehouseId: context.warehouse?.id ?? context.agreement?.warehouseId ?? null,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        priceTypeId: context.priceType?.id ?? null,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? defaultDeliveryDate(),
        paymentForm: body.paymentForm ?? null,
        deliveryMethod: body.deliveryMethod ?? null,
        ...(trackingSnapshot
          ? {
              trackingRoutePointId: trackingSnapshot.routePointId,
              trackingSnapshot: trackingSnapshot.snapshot,
            }
          : {}),
        currency: DEFAULT_ORDER_CURRENCY,
        totalAmount: prepared.totalAmount,
        generalDiscountPercent:
          body.generalDiscountPercent !== null && body.generalDiscountPercent !== undefined
            ? toDecimal(body.generalDiscountPercent)
            : null,
        generalDiscountAmount: prepared.generalDiscountAmount,
        lastExportError: null,
        last1cError: null,
        sourceUpdatedAt,
        items: {
          create: prepared.items.map((item) => item.create),
        },
      },
    });

    if (!isAutosave) {
      await appendOrderEvent(tx, {
        orderId: order.id,
        revision: nextRevision,
        source: OrderEventSource.APP_MANAGER,
        eventType: 'CLIENT_ORDER_UPDATED',
        actorUserId: userId,
        payload: {
          organizationGuid: context.organization.guid,
          priceTypeGuid: context.priceType?.guid ?? null,
          saveReason: body.saveReason,
          comment: body.comment ?? null,
          deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
          paymentForm: body.paymentForm ?? null,
          deliveryMethod: body.deliveryMethod ?? null,
          trackingSnapshot: trackingSnapshot?.snapshot ?? null,
          generalDiscountPercent: body.generalDiscountPercent ?? null,
          items: prepared.items.map((item) => item.snapshot),
        } as Prisma.InputJsonValue,
      });
    }
  });

  return getClientOrderByGuid(guid, userId);
}

export async function submitClientOrder(guid: string, userId: number, body: ClientOrderSubmitBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
        hasRealization: true,
        organizationId: true,
        agreementId: true,
        contractId: true,
        warehouseId: true,
        deliveryAddressId: true,
        deliveryDate: true,
        items: {
          select: {
            quantity: true,
            basePrice: true,
            isCancelled: true,
          },
        },
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    if (order.status === OrderStatus.CANCELLED) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Отмененный заказ нельзя отправить');
    }
    const missingFields: string[] = [];
    if (!order.organizationId) missingFields.push('организацию');
    if (!order.agreementId) missingFields.push('соглашение');
    if (!order.contractId) missingFields.push('договор');
    if (!order.warehouseId) missingFields.push('склад');
    if (!order.deliveryAddressId) missingFields.push('адрес доставки');
    if (!order.deliveryDate) missingFields.push('дату отгрузки');
    if (missingFields.length) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Заполните ${missingFields.join(', ')} перед отправкой в 1С`
      );
    }
    const activeItems = order.items.filter((item) => !item.isCancelled);
    if (!activeItems.length || activeItems.some((item) => item.quantity.lte(0) || item.basePrice === null || item.basePrice.lte(0))) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Исправьте строки с нулевым количеством или ценой перед отправкой'
      );
    }

    const nextRevision = order.revision + 1;
    const queuedAt = now();
    const trackingSnapshot = await resolveActiveTrackingOrderSnapshot(tx, userId);

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.QUEUED,
        syncState: OrderSyncState.QUEUED,
        queuedAt,
        cancelRequestedAt: null,
        cancelReason: null,
        exportAttempts: 0,
        lastExportError: null,
        last1cError: null,
        ...(trackingSnapshot
          ? {
              trackingRoutePointId: trackingSnapshot.routePointId,
              trackingSnapshot: trackingSnapshot.snapshot,
            }
          : {}),
        sourceUpdatedAt: queuedAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_SUBMITTED',
      actorUserId: userId,
      payload: {
        queuedAt: queuedAt.toISOString(),
        trackingSnapshot: trackingSnapshot?.snapshot ?? null,
      },
    });

    await saveUserCounterpartyDefaults(tx, userId, guid);
  });

  return getClientOrderByGuid(guid, userId);
}

async function unqueueClientOrderInTransaction(
  tx: Tx,
  order: { id: string; guid: string | null; revision: number },
  userId: number,
  reason: string | null
) {
  const nextRevision = order.revision + 1;
  const changedAt = now();

  await tx.order.update({
    where: { id: order.id },
    data: {
      revision: nextRevision,
      status: OrderStatus.DRAFT,
      syncState: OrderSyncState.DRAFT,
      queuedAt: null,
      cancelRequestedAt: null,
      cancelReason: null,
      last1cError: null,
      lastExportError: null,
      sourceUpdatedAt: changedAt,
    },
  });

  await appendOrderEvent(tx, {
    orderId: order.id,
    revision: nextRevision,
    source: OrderEventSource.APP_MANAGER,
    eventType: 'CLIENT_ORDER_UNQUEUED',
    actorUserId: userId,
    note: reason,
    payload: {
      reason,
      changedAt: changedAt.toISOString(),
    },
  });
}

export async function unqueueClientOrder(guid: string, userId: number, body: ClientOrderUnqueueBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        syncState: true,
        source: true,
        isPostedIn1c: true,
        hasRealization: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }
    if (order.hasRealization) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'По заказу создана реализация товаров и услуг. Документ доступен только для чтения');
    }
    if (!isOrderQueued(order)) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Снять с очереди можно только заказ в очереди');
    }

    assertRevision(order.revision, body.revision);
    await unqueueClientOrderInTransaction(tx, order, userId, 'Снят с очереди менеджером из приложения');
  });

  requestClientOrdersExportWakeup();
  return getClientOrderByGuid(guid, userId);
}

export async function retryClientOrderExport(guid: string, userId: number, body: ClientOrderUnqueueBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        syncState: true,
        source: true,
        hasRealization: true,
        items: { select: { id: true, isCancelled: true, quantity: true, basePrice: true } },
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    const activeItems = order.items.filter((item) => !item.isCancelled);
    if (!activeItems.length || activeItems.some((item) => item.quantity.lte(0) || item.basePrice === null || item.basePrice.lte(0))) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Исправьте строки с нулевым количеством или ценой перед повторной отправкой'
      );
    }

    const queuedAt = now();
    const nextRevision = order.revision + 1;
    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.QUEUED,
        syncState: OrderSyncState.QUEUED,
        queuedAt,
        sentTo1cAt: null,
        lastExportError: null,
        last1cError: null,
        exportAttempts: 0,
        sourceUpdatedAt: queuedAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_EXPORT_RETRY_QUEUED',
      actorUserId: userId,
      note: 'Заказ повторно поставлен в очередь отправки в 1С',
      payload: { queuedAt: queuedAt.toISOString() },
    });
  });

  requestClientOrdersExportWakeup();
  return getClientOrderByGuid(guid, userId);
}

export async function deleteDraftClientOrder(guid: string, userId: number) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        status: true,
        source: true,
        isPostedIn1c: true,
        number1c: true,
        sentTo1cAt: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    const canDeleteLocal = (
      order.status === OrderStatus.DRAFT ||
      order.status === OrderStatus.QUEUED ||
      order.status === OrderStatus.CANCELLED
    )
      && !order.isPostedIn1c
      && !order.number1c
      && !order.sentTo1cAt;
    if (!canDeleteLocal) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Можно удалить только локальный черновик, заказ в очереди или отмененный заказ, который еще не создан в 1С');
    }

    await tx.orderItem.deleteMany({ where: { orderId: order.id } });
    await tx.order.delete({ where: { id: order.id } });
  });

  return { deleted: true, guid };
}

export async function restoreClientOrder(guid: string, userId: number, body: ClientOrderRestoreBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
        number1c: true,
        sentTo1cAt: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }
    if (order.status !== OrderStatus.CANCELLED) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Восстановить можно только отмененный заказ');
    }
    if (order.isPostedIn1c || order.number1c || order.sentTo1cAt) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Заказ, уже созданный в 1С, нельзя восстановить из приложения');
    }

    assertRevision(order.revision, body.revision);

    const restoredAt = now();
    const nextRevision = order.revision + 1;
    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.DRAFT,
        syncState: OrderSyncState.DRAFT,
        queuedAt: null,
        cancelRequestedAt: null,
        cancelReason: null,
        lastExportError: null,
        last1cError: null,
        sourceUpdatedAt: restoredAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_RESTORED',
      actorUserId: userId,
      note: 'Отмененный заказ восстановлен менеджером из приложения',
      payload: {
        restoredAt: restoredAt.toISOString(),
      },
    });
  });

  requestClientOrdersExportWakeup();
  return getClientOrderByGuid(guid, userId);
}

export async function cancelClientOrder(guid: string, userId: number, body: ClientOrderCancelBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        syncState: true,
        source: true,
        isPostedIn1c: true,
        hasRealization: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    if (order.status === OrderStatus.CANCELLED) {
      return;
    }
    assertRevision(order.revision, body.revision);

    if (isOrderQueued(order)) {
      await unqueueClientOrderInTransaction(tx, order, userId, body.reason ?? 'Снят с очереди менеджером из приложения');
      return;
    }

    ensureEditable(order);

    const nextRevision = order.revision + 1;
    const cancelledAt = now();
    const requiresOnecCancel = order.status !== OrderStatus.DRAFT;

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.CANCELLED,
        syncState: requiresOnecCancel ? OrderSyncState.CANCEL_REQUESTED : OrderSyncState.SYNCED,
        cancelRequestedAt: requiresOnecCancel ? cancelledAt : null,
        cancelReason: body.reason ?? null,
        sourceUpdatedAt: cancelledAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_CANCEL_REQUEST,
      eventType: 'CLIENT_ORDER_CANCELLED',
      actorUserId: userId,
      note: body.reason ?? null,
      payload: {
        cancelRequestedAt: cancelledAt.toISOString(),
        requiresOnecCancel,
        reason: body.reason ?? null,
      },
    });
  });

  return getClientOrderByGuid(guid, userId);
}

export async function copyClientOrder(guid: string, userId: number, body: ClientOrderCopyBody = {}) {
  if (body.revision !== undefined) {
    const local = await prisma.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP, createdByUserId: userId },
      select: { revision: true },
    });
    if (local) assertRevision(local.revision, body.revision);
  }

  const source = await getClientOrderByGuid(guid, userId);
  const payload = buildClientOrderCopyPayload(source);
  return createClientOrder(userId, payload);
}

export async function getClientOrderProductImagesStatus() {
  return getProductImagesStatus();
}

export async function syncClientOrderProductImages(params: {
  productGuid?: string;
  changedSince?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}) {
  return syncProductImages(params);
}

export async function cleanupClientOrderProductImages(retentionDays: number) {
  return cleanupProductImages(retentionDays);
}

export { ClientOrdersError };
