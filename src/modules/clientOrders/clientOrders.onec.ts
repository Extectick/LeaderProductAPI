import prisma from '../../prisma/client';
import {
  getOnecLpAppClientOrder,
  getOnecLpAppClientOrders,
  putOnecLpAppClientOrder,
  type OnecLpAppQuery,
} from '../onec/onec.lpApp.client';

const ONEC_GUID_PREFIX = 'onec:';
const DEFAULT_REMOTE_RANGE_DAYS = 7;

type OnecClientOrderListItem = {
  guid?: string | null;
  documentGuid?: string | null;
  documentNumber?: string | null;
  documentDate?: string | Date | null;
  counterparty?: { guid?: string | null; name?: string | null } | null;
  organization?: { guid?: string | null; name?: string | null; code?: string | null } | null;
  status1c?: string | null;
  isPosted?: boolean | null;
  managerGuid?: string | null;
  comment?: string | null;
  totalAmount?: number | string | null;
  lastImportedAt?: string | Date | null;
  isEditable?: boolean | null;
  readOnlyReason?: string | null;
};

type OnecClientOrderDetail = OnecClientOrderListItem & {
  number1c?: string | null;
  date1c?: string | Date | null;
  source?: string | null;
  revision?: number | null;
  syncState?: string | null;
  status?: string | null;
  deliveryDate?: string | Date | null;
  currency?: string | null;
  isPostedIn1c?: boolean | null;
  postedAt1c?: string | Date | null;
  agreement?: any;
  contract?: any;
  warehouse?: any;
  deliveryAddress?: any;
  items?: any[];
  events?: any[];
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  sourceUpdatedAt?: string | Date | null;
};

type OnecClientOrdersResponse = {
  items?: OnecClientOrderListItem[];
  item?: OnecClientOrderDetail;
  total?: number | string | null;
  limit?: number | string | null;
  offset?: number | string | null;
  hasMore?: boolean | null;
};

function asString(value: unknown) {
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

function asNumber(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function asIso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function isOnecClientOrderGuid(guid: string) {
  return guid.startsWith(ONEC_GUID_PREFIX);
}

export function toOnecClientOrderGuid(documentGuid: string) {
  return `${ONEC_GUID_PREFIX}${documentGuid}`;
}

export function extractOnecDocumentGuid(guid: string) {
  return isOnecClientOrderGuid(guid) ? guid.slice(ONEC_GUID_PREFIX.length) : guid;
}

export async function getEmployeeOnecUserGuid(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { employeeProfile: { select: { onecUserGuid: true } } },
  });
  return user?.employeeProfile?.onecUserGuid?.trim() || null;
}

export function resolveRemoteDateRange(params: { dateFrom?: Date; dateTo?: Date }) {
  const now = new Date();
  const dateTo = params.dateTo ? endOfDay(params.dateTo) : endOfDay(now);
  const dateFrom = params.dateFrom ? startOfDay(params.dateFrom) : startOfDay(addDays(dateTo, -(DEFAULT_REMOTE_RANGE_DAYS - 1)));
  return { dateFrom, dateTo };
}

function mapOnecListItem(item: OnecClientOrderListItem) {
  const documentGuid = asString(item.documentGuid) || asString(item.guid) || '';
  const posted = asBoolean(item.isPosted) ?? false;
  const isEditable = item.isEditable === false ? false : true;
  return {
    guid: toOnecClientOrderGuid(documentGuid),
    documentGuid,
    origin: 'onec',
    number1c: asString(item.documentNumber),
    date1c: asIso(item.documentDate),
    source: 'ONEC',
    revision: 1,
    syncState: 'SYNCED',
    status: posted ? 'CONFIRMED' : 'SENT_TO_1C',
    status1c: asString(item.status1c),
    comment: asString(item.comment),
    deliveryDate: null,
    totalAmount: asNumber(item.totalAmount),
    currency: 'RUB',
    isPostedIn1c: posted,
    postedAt1c: posted ? asIso(item.documentDate) : null,
    counterparty: item.counterparty
      ? { guid: asString(item.counterparty.guid) || '', name: asString(item.counterparty.name) || '' }
      : null,
    organization: item.organization
      ? {
          guid: asString(item.organization.guid) || '',
          name: asString(item.organization.name) || '',
          code: asString(item.organization.code),
        }
      : null,
    agreement: null,
    contract: null,
    warehouse: null,
    deliveryAddress: null,
    createdByUser: null,
    items: [],
    events: [],
    createdAt: asIso(item.documentDate),
    updatedAt: asIso(item.lastImportedAt) || asIso(item.documentDate),
    sourceUpdatedAt: asIso(item.lastImportedAt),
    isEditable,
    readOnlyReason: isEditable ? null : asString(item.readOnlyReason) || "Документ находится в статусе 'К отгрузке' и проведен в 1С.",
  };
}

function mapOnecDetailItem(item: any) {
  return {
    id: asString(item?.id) || `${asString(item?.product?.guid) || 'line'}-${Math.random().toString(36).slice(2, 8)}`,
    quantity: asNumber(item?.quantity) ?? 0,
    quantityBase: asNumber(item?.quantityBase),
    basePrice: asNumber(item?.basePrice),
    price: asNumber(item?.price),
    isManualPrice: asBoolean(item?.isManualPrice) ?? false,
    manualPrice: asNumber(item?.manualPrice),
    priceSource: asString(item?.priceSource),
    priceType: item?.priceType
      ? { guid: asString(item.priceType.guid) || '', name: asString(item.priceType.name) || '' }
      : null,
    discountPercent: asNumber(item?.discountPercent),
    appliedDiscountPercent: asNumber(item?.appliedDiscountPercent),
    lineAmount: asNumber(item?.lineAmount),
    comment: asString(item?.comment),
    product: {
      guid: asString(item?.product?.guid) || '',
      name: asString(item?.product?.name) || '',
      code: asString(item?.product?.code),
      article: asString(item?.product?.article),
      sku: asString(item?.product?.sku),
      isWeight: asBoolean(item?.product?.isWeight),
    },
    package: item?.package
      ? {
          guid: asString(item.package.guid),
          name: asString(item.package.name),
          multiplier: asNumber(item.package.multiplier),
          isDefault: asBoolean(item.package.isDefault) ?? false,
        }
      : null,
    unit: item?.unit
      ? {
          guid: asString(item.unit.guid),
          name: asString(item.unit.name),
          symbol: asString(item.unit.symbol),
        }
      : null,
    stock: null,
  };
}

export function mapOnecClientOrderDetail(item: OnecClientOrderDetail) {
  const base = mapOnecListItem(item);
  const postedAt = asIso(item.postedAt1c) || (base.isPostedIn1c ? base.date1c : null);
  return {
    ...base,
    number1c: asString(item.number1c) || base.number1c,
    date1c: asIso(item.date1c) || base.date1c,
    source: asString(item.source) || 'ONEC',
    revision: asNumber(item.revision) ?? 1,
    syncState: asString(item.syncState) || 'SYNCED',
    status: asString(item.status) || base.status,
    deliveryDate: asIso(item.deliveryDate),
    totalAmount: asNumber(item.totalAmount),
    currency: asString(item.currency) || 'RUB',
    isPostedIn1c: item.isPostedIn1c == null ? base.isPostedIn1c : Boolean(item.isPostedIn1c),
    postedAt1c: postedAt,
    agreement: item.agreement || null,
    contract: item.contract || null,
    warehouse: item.warehouse || null,
    deliveryAddress: item.deliveryAddress || null,
    items: Array.isArray(item.items) ? item.items.map(mapOnecDetailItem) : [],
    events: Array.isArray(item.events) ? item.events : [],
    createdAt: asIso(item.createdAt) || base.createdAt,
    updatedAt: asIso(item.updatedAt) || base.updatedAt,
    sourceUpdatedAt: asIso(item.sourceUpdatedAt) || base.sourceUpdatedAt,
  };
}

function extractListResponse(payload: unknown): OnecClientOrdersResponse {
  if (!payload || typeof payload !== 'object') return {};
  return payload as OnecClientOrdersResponse;
}

export async function fetchOnecClientOrders(query: OnecLpAppQuery) {
  const payload = extractListResponse(await getOnecLpAppClientOrders(query));
  const items = Array.isArray(payload.items) ? payload.items.map(mapOnecListItem) : [];
  return {
    items,
    total: asNumber(payload.total) ?? items.length,
    limit: asNumber(payload.limit) ?? items.length,
    offset: asNumber(payload.offset) ?? 0,
    hasMore: Boolean(payload.hasMore),
  };
}

export async function fetchOnecClientOrder(documentGuid: string) {
  const payload = extractListResponse(await getOnecLpAppClientOrder(documentGuid));
  const item = payload.item ?? (payload as unknown as OnecClientOrderDetail);
  return mapOnecClientOrderDetail(item);
}

export async function updateOnecClientOrder(documentGuid: string, body: Record<string, unknown>) {
  const payload = extractListResponse(await putOnecLpAppClientOrder(documentGuid, body));
  const item = payload.item ?? (payload as unknown as OnecClientOrderDetail);
  return mapOnecClientOrderDetail(item);
}

