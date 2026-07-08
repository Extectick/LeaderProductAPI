import {
  getOnecLpAppAgreements,
  getOnecLpAppClientOrder,
  getOnecLpAppClientOrderDefaults,
  getOnecLpAppClientOrders,
  getOnecLpAppContracts,
  getOnecLpAppCounterparties,
  getOnecLpAppDeliveryAddresses,
  getOnecLpAppNomenclature,
  getOnecLpAppNomenclatureItem,
  getOnecLpAppOrganizations,
  getOnecLpAppPriceTypes,
  getOnecLpAppWarehouses,
  type OnecLpAppQuery,
} from '../onec/onec.lpApp.client';
import type {
  ClientOrderReferenceDetailsParams,
  ClientOrderDefaultsQuery,
  ClientOrdersAgreementsQuery,
  ClientOrdersBatchProductsBody,
  ClientOrdersContractsQuery,
  ClientOrdersCounterpartiesQuery,
  ClientOrdersDeliveryAddressesQuery,
  ClientOrdersListQuery,
  ClientOrdersPriceTypesQuery,
  ClientOrdersProductsQuery,
  ClientOrdersReferenceDataQuery,
  ClientOrdersWarehousesQuery,
} from './clientOrders.schemas';

export type LivePagedResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore?: boolean;
};

export type LiveOrganization = {
  guid: string;
  name: string;
  code: string | null;
  isActive: boolean;
};

export type LiveCounterparty = {
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
  defaultAgreement?: LiveAgreement | null;
  defaultContract?: LiveContract | null;
  defaultWarehouse?: LiveWarehouse | null;
  defaultDeliveryAddress?: LiveDeliveryAddress | null;
  addresses?: LiveDeliveryAddress[];
};

export type LiveAgreement = {
  guid: string;
  name: string;
  number?: string | null;
  date?: string | Date | null;
  counterpartyGuid?: string | null;
  organizationGuid?: string | null;
  organization?: { guid: string; name: string; code?: string | null } | null;
  managerGuid?: string | null;
  managerName?: string | null;
  manager?: { guid?: string | null; name?: string | null } | null;
  contractGuid?: string | null;
  warehouseGuid?: string | null;
  priceTypeGuid?: string | null;
  currency: string | null;
  status?: string | null;
  isActive: boolean;
  contract: { guid: string; number: string } | null;
  warehouse: { guid: string; name: string } | null;
  priceType: { guid: string; name: string } | null;
};

export type LiveContract = {
  guid: string;
  number: string;
  name?: string | null;
  date: string | Date | null;
  validFrom: string | Date | null;
  validTo: string | Date | null;
  counterpartyGuid?: string | null;
  organizationGuid?: string | null;
  organization?: { guid: string; name: string; code?: string | null } | null;
  managerGuid?: string | null;
  managerName?: string | null;
  manager?: { guid?: string | null; name?: string | null } | null;
  status?: string | null;
  purpose?: string | null;
  currency?: string | null;
  isActive: boolean;
};

export type LiveWarehouse = {
  guid: string;
  name: string;
  code: string | null;
  address?: string | null;
  isDefault: boolean;
  isPickup: boolean;
  isActive: boolean;
};

export type LivePriceType = {
  guid: string;
  name: string;
  code: string | null;
  isActive: boolean;
};

export type LiveDeliveryAddress = {
  guid: string | null;
  name: string | null;
  fullAddress: string;
  deliveryNumber?: string | null;
  number?: string | null;
  comment?: string | null;
  deliveryComment?: string | null;
  kindName?: string | null;
  contactInfoKind?: string | null;
  counterpartyGuid?: string | null;
  isDefault: boolean;
  isActive: boolean;
};

export type LiveClientOrderOption = {
  code: string | null;
  name: string;
  label: string;
};

export type LiveProductPackage = {
  guid: string;
  name: string;
  multiplier: number | null;
  isDefault: boolean;
  unit: { guid: string; name: string; symbol?: string | null } | null;
};

export type LiveProductStock = {
  quantity?: number | null;
  reserved?: number | null;
  available?: number | null;
  freeAvailable?: number | null;
  myReserved?: number | null;
};

export type LiveProduct = {
  guid: string;
  name: string;
  code: string | null;
  article: string | null;
  sku: string | null;
  isWeight: boolean;
  isActive: boolean;
  baseUnit: { guid: string; name: string; symbol?: string | null } | null;
  packages: LiveProductPackage[];
  basePrice: number | null;
  receiptPrice: number | null;
  currency: string | null;
  priceType: { guid: string; name: string } | null;
  stock: LiveProductStock | null;
  priceMatch: unknown;
  priceError: string | null;
};

export type LiveReferenceDetails = {
  kind: ClientOrderReferenceDetailsParams['kind'];
  guid: string;
  title: string;
  subtitle?: string | null;
  sections: Array<{ title: string; rows: Array<{ label: string; value: unknown }> }>;
  debug: unknown;
};

export type LiveClientOrderDefaults = {
  organization: LiveOrganization | null;
  counterparty: LiveCounterparty | null;
  agreement: LiveAgreement | null;
  contract: LiveContract | null;
  warehouse: LiveWarehouse | null;
  deliveryAddress: LiveDeliveryAddress | null;
  priceType: LivePriceType | null;
  paymentForm: string | null;
  paymentForms: LiveClientOrderOption[];
  deliveryMethod: string | null;
  deliveryMethods: LiveClientOrderOption[];
  currency: string | null;
  warnings: string[];
};

export type LiveClientOrder = {
  guid: string;
  appGuid: string | null;
  documentGuid: string;
  number1c: string | null;
  date1c: string | Date | null;
  source: 'ONEC_LIVE';
  origin: 'onec';
  readOnly: boolean;
  readOnlyReason: string | null;
  hasRealization: boolean;
  revision: number;
  syncState: 'SYNCED';
  status: string;
  status1c: string | null;
  currentState1c: string | null;
  documentStatus1c: string | null;
  comment: string | null;
  deliveryDate: string | Date | null;
  paymentForm: string | null;
  deliveryMethod: string | null;
  totalAmount: number | null;
  currency: string;
  priceType: { guid: string; name: string } | null;
  queuedAt: null;
  sentTo1cAt: string | Date | null;
  lastStatusSyncAt: string | Date | null;
  lastExportError: string | null;
  last1cError: string | null;
  isPostedIn1c: boolean;
  cancelRequestedAt: null;
  counterparty: { guid: string; name: string; fullName?: string | null; inn?: string | null; kpp?: string | null } | null;
  organization: { guid: string; name: string; code?: string | null; isActive?: boolean } | null;
  warehouse: { guid: string; name: string; code?: string | null } | null;
  agreement: LiveAgreement | null;
  contract: LiveContract | null;
  deliveryAddress: LiveDeliveryAddress | null;
  itemsCount: number;
  items: Array<{
    id?: string | null;
    lineGuid?: string | null;
    quantity: number | null;
    quantityBase: number | null;
    basePrice: number | null;
    price: number | null;
    isManualPrice: boolean;
    manualPrice: number | null;
    priceSource: string | null;
    isCancelled?: boolean;
    cancelReasonGuid?: string | null;
    cancelReasonName?: string | null;
    cancelReason?: string | null;
    cancelledAmount?: number | null;
    priceType: { guid: string; name: string } | null;
    discountPercent: number | null;
    appliedDiscountPercent: number | null;
    lineAmount: number | null;
    comment: string | null;
    product: { guid: string; name: string; code?: string | null; article?: string | null; sku?: string | null; isWeight?: boolean | null };
    package?: { guid?: string | null; name?: string | null; multiplier?: number | null; isDefault?: boolean | null } | null;
    unit?: { guid?: string | null; name?: string | null; symbol?: string | null } | null;
  }>;
  events: [];
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  sourceUpdatedAt: string | Date | null;
};

type AnyRecord = Record<string, unknown>;

const DEFAULT_LIMIT = 25;
const DEFAULT_CURRENCY = 'RUB';
const DELIVERY_METHOD_TO_CLIENT = 'ДоКлиента';
const DELIVERY_METHOD_PICKUP = 'Самовывоз';
const DEFAULT_DELIVERY_METHOD = DELIVERY_METHOD_TO_CLIENT;
const DEFAULT_PAYMENT_FORM_OPTIONS: LiveClientOrderOption[] = [
  { code: null, name: 'Любая', label: 'Любая' },
  { code: 'Наличная', name: 'Наличная', label: 'Наличная' },
];
const DEFAULT_DELIVERY_METHOD_OPTIONS: LiveClientOrderOption[] = [
  { code: DELIVERY_METHOD_TO_CLIENT, name: DELIVERY_METHOD_TO_CLIENT, label: 'Наша доставка' },
  { code: DELIVERY_METHOD_PICKUP, name: DELIVERY_METHOD_PICKUP, label: 'Самовывоз' },
];

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;
}

function read(record: AnyRecord | null | undefined, keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function readObject(record: AnyRecord | null | undefined, keys: string[]) {
  return asRecord(read(record, keys));
}

function readArray(record: AnyRecord | null | undefined, keys: string[]) {
  const value = read(record, keys);
  return Array.isArray(value) ? value : [];
}

function text(record: AnyRecord | null | undefined, keys: string[], fallback: string | null = null) {
  const value = read(record, keys);
  if (value === undefined || value === null) return fallback;
  const prepared = String(value).trim();
  return prepared ? prepared : fallback;
}

function bool(record: AnyRecord | null | undefined, keys: string[], fallback = false) {
  const value = read(record, keys);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'истина'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'ложь'].includes(normalized)) return false;
  }
  return fallback;
}

function isEntityActive(record: AnyRecord | null | undefined) {
  const deletionMark = bool(record, ['deletionMark', 'DeletionMark', 'ПометкаУдаления'], false);
  return !deletionMark && bool(record, ['isActive', 'active'], true);
}

function numberValue(record: AnyRecord | null | undefined, keys: string[], fallback: number | null = null) {
  const value = read(record, keys);
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function queryDateValue(value?: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeQuery(query: {
  limit?: number;
  offset?: number;
  search?: string;
  includeInactive?: boolean;
  counterpartyGuid?: string;
  organizationGuid?: string;
  agreementGuid?: string;
  contractGuid?: string;
  warehouseGuid?: string;
  priceTypeGuid?: string;
  inStockOnly?: boolean;
  managerGuid?: string;
  status?: string;
  statuses?: string[];
  syncState?: string;
  amountMin?: number;
  amountMax?: number;
  deliveryDateFrom?: Date;
  deliveryDateTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  itemsMin?: number;
  itemsMax?: number;
  hasNumber1c?: string;
  onlyProblems?: boolean;
  appGuid?: string;
  number1c?: string;
  includeItems?: boolean;
  deliveryAddressNumber?: string;
}): OnecLpAppQuery {
  return {
    limit: query.limit ?? DEFAULT_LIMIT,
    offset: query.offset ?? 0,
    search: query.search,
    includeInactive: query.includeInactive,
    counterpartyGuid: query.counterpartyGuid,
    organizationGuid: query.organizationGuid,
    agreementGuid: query.agreementGuid,
    contractGuid: query.contractGuid,
    warehouseGuid: query.warehouseGuid,
    priceTypeGuid: query.priceTypeGuid,
    inStockOnly: query.inStockOnly,
    managerGuid: query.managerGuid,
    status: query.status,
    statuses: Array.isArray(query.statuses) && query.statuses.length ? query.statuses.join(',') : undefined,
    syncState: query.syncState,
    amountMin: query.amountMin,
    amountMax: query.amountMax,
    dateFrom: queryDateValue(query.deliveryDateFrom),
    dateTo: queryDateValue(query.deliveryDateTo),
    deliveryDateFrom: queryDateValue(query.deliveryDateFrom),
    deliveryDateTo: queryDateValue(query.deliveryDateTo),
    updatedFrom: queryDateValue(query.updatedFrom),
    updatedTo: queryDateValue(query.updatedTo),
    itemsMin: query.itemsMin,
    itemsMax: query.itemsMax,
    hasNumber1c: query.hasNumber1c,
    onlyProblems: query.onlyProblems,
    appGuid: query.appGuid,
    number1c: query.number1c,
    includeItems: query.includeItems,
    deliveryAddressNumber: query.deliveryAddressNumber,
  };
}

function extractListPayload(payload: unknown, fallbackKeys: string[]) {
  const record = asRecord(payload);
  if (!record) {
    return { items: [], limit: DEFAULT_LIMIT, offset: 0, hasMore: false, total: 0 };
  }

  const itemsValue =
    read(record, ['items']) ??
    read(record, fallbackKeys) ??
    read(asRecord(read(record, ['data'])), ['items']) ??
    read(asRecord(read(record, ['result'])), ['items']);
  const items = Array.isArray(itemsValue) ? itemsValue : [];
  const limit = numberValue(record, ['limit'], DEFAULT_LIMIT) ?? DEFAULT_LIMIT;
  const offset = numberValue(record, ['offset'], 0) ?? 0;
  const hasMore = bool(record, ['hasMore'], false);
  const explicitTotal = numberValue(record, ['total', 'count'], null);
  const total = explicitTotal ?? offset + items.length + (hasMore ? 1 : 0);

  return { items, limit, offset, hasMore, total };
}

function paged<T>(
  payload: unknown,
  keys: string[],
  mapper: (item: AnyRecord) => T | null,
  query: { limit: number; offset: number }
): LivePagedResult<T> {
  const list = extractListPayload(payload, keys);
  const items = list.items.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const mapped = mapper(record);
    return mapped ? [mapped] : [];
  });

  return {
    items,
    total: Math.max(list.total, query.offset + items.length),
    limit: list.limit || query.limit,
    offset: list.offset || query.offset,
  };
}

function visiblePage<T extends { isActive?: boolean }>(page: LivePagedResult<T>, includeInactive?: boolean): LivePagedResult<T> {
  if (includeInactive) return page;
  const items = page.items.filter((item) => item.isActive !== false);
  return {
    ...page,
    items,
    total: Math.min(page.total, page.offset + items.length + (page.total > page.offset + page.items.length ? 1 : 0)),
  };
}

function normalizeSmartSearchText(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function smartSearchTokens(search?: string | null) {
  const normalized = normalizeSmartSearchText(search);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter((token) => token.length >= 2)));
}

function extractDeliveryAddressNumber(value?: string | null) {
  const source = String(value ?? '').trim();
  if (!source) return undefined;
  if (/^\d+$/.test(source)) return source;
  return source.match(/адрес\s+доставки\D*(\d+)/i)?.[1];
}

function flattenSearchText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 4) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenSearchText(item, depth + 1)).join(' ');
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => flattenSearchText(item, depth + 1))
      .join(' ');
  }
  return '';
}

function scoreSmartSearchItem(item: unknown, search: string) {
  const tokens = smartSearchTokens(search);
  if (!tokens.length) return { matched: true, allTokens: true, score: 0 };

  const textValue = normalizeSmartSearchText(flattenSearchText(item));
  const phrase = normalizeSmartSearchText(search);
  const phraseMatch = phrase.length > 0 && textValue.includes(phrase);
  const matchedTokens = tokens.filter((token) => textValue.includes(token));
  const allTokens = matchedTokens.length === tokens.length;
  const prefixTokens = tokens.filter((token) => textValue.split(' ').some((word) => word.startsWith(token))).length;

  return {
    matched: matchedTokens.length > 0,
    allTokens,
    score:
      matchedTokens.length * 100 +
      prefixTokens * 20 +
      (allTokens ? 500 : 0) +
      (phraseMatch ? 250 : 0),
  };
}

function smartDedupeKey(item: unknown, index: number) {
  const record = asRecord(item);
  return text(record, ['guid', 'id', 'documentGuid', 'number1c'], null) ?? `${normalizeSmartSearchText(flattenSearchText(item)).slice(0, 160)}:${index}`;
}

async function liveSmartPaged<T extends { isActive?: boolean }>(
  query: { limit?: number; offset?: number; search?: string; includeInactive?: boolean; deliveryAddressNumber?: string },
  loader: (query: OnecLpAppQuery) => Promise<unknown>,
  keys: string[],
  mapper: (item: AnyRecord) => T | null
): Promise<LivePagedResult<T>> {
  const normalized = normalizeQuery(query);
  const limit = Number(normalized.limit ?? DEFAULT_LIMIT);
  const offset = Number(normalized.offset ?? 0);
  const search = String(normalized.search ?? '').trim();
  const tokens = smartSearchTokens(search);

  if (tokens.length < 2) {
    return visiblePage(paged(await loader(normalized), keys, mapper, { limit, offset }), query.includeInactive);
  }

  const fetchLimit = Math.min(100, Math.max(limit + offset, limit * 4, 50));
  const variants = Array.from(new Set([search, ...tokens])).filter(Boolean);
  const payloads = await Promise.allSettled(
    variants.map((variant) => loader({ ...normalized, search: variant, limit: fetchLimit, offset: 0 }))
  );

  const combined: T[] = [];
  let sourceCanHaveMore = false;
  for (const payload of payloads) {
    if (payload.status !== 'fulfilled') continue;
    const page = visiblePage(paged(payload.value, keys, mapper, { limit: fetchLimit, offset: 0 }), query.includeInactive);
    sourceCanHaveMore = sourceCanHaveMore || page.total > page.items.length;
    combined.push(...page.items);
  }

  const known = new Set<string>();
  const unique = combined.filter((item, index) => {
    const key = smartDedupeKey(item, index);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });

  const scored = unique
    .map((item, index) => ({ item, index, ...scoreSmartSearchItem(item, search) }))
    .filter((row) => row.matched);
  const strict = scored.filter((row) => row.allTokens);
  const ranked = (strict.length ? strict : scored)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
  const items = ranked.slice(offset, offset + limit);
  const hasMore = sourceCanHaveMore || ranked.length > offset + items.length;

  return {
    items,
    total: Math.max(ranked.length, offset + items.length + (hasMore ? 1 : 0)),
    limit,
    offset,
  };
}

function entityGuid(record: AnyRecord | null | undefined, keys = ['guid', 'id', 'GUID', 'Ссылка']) {
  return text(record, keys, null);
}

function mapNamedRef(record: AnyRecord | null | undefined, guidKeys: string[], nameKeys: string[]) {
  const guid = entityGuid(record, guidKeys);
  if (!guid) return null;
  return {
    guid,
    name: text(record, nameKeys, guid) ?? guid,
  };
}

function mapOrganization(record: AnyRecord): LiveOrganization | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'Наименование'], guid);
  if (!guid || !name) return null;
  return {
    guid,
    name,
    code: text(record, ['code', 'Код']),
    isActive: isEntityActive(record),
  };
}

function mapWarehouse(record: AnyRecord): LiveWarehouse | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'Наименование'], guid);
  if (!guid || !name) return null;
  return {
    guid,
    name,
    code: text(record, ['code', 'Код']),
    address: text(record, ['address', 'Адрес']),
    isDefault: bool(record, ['isDefault', 'default'], false),
    isPickup: bool(record, ['isPickup', 'pickup'], false),
    isActive: isEntityActive(record),
  };
}

function mapOrderWarehouse(record: AnyRecord): LiveClientOrder['warehouse'] {
  const warehouseRecord = readObject(record, ['warehouse', 'Склад']);
  const nested = mapWarehouse(warehouseRecord ?? {});
  if (nested) return nested;

  const guid =
    text(record, ['warehouseGuid', 'warehouseId', 'warehouseGUID', 'warehouseRef', 'СкладGuid', 'СкладGUID'], null) ??
    entityGuid(warehouseRecord);
  if (!guid) return null;

  const name =
    text(warehouseRecord, ['name', 'Наименование'], null) ??
    text(record, ['warehouseName', 'warehousePresentation', 'warehouseTitle', 'СкладНаименование', 'СкладПредставление'], null) ??
    guid;

  return {
    guid,
    name,
    code: text(warehouseRecord, ['code', 'Код'], null) ?? text(record, ['warehouseCode', 'СкладКод'], null),
  };
}

type LiveWithOrganization = {
  organizationGuid?: string | null;
  organization?: { guid: string; name: string; code?: string | null } | null;
};

function needsOrganizationName(item: LiveWithOrganization) {
  const guid = item.organizationGuid || item.organization?.guid;
  if (!guid) return false;
  const name = item.organization?.name?.trim();
  return !name || name.toLowerCase() === guid.toLowerCase();
}

async function enrichOrganizationNames<T extends LiveWithOrganization>(items: T[]): Promise<T[]> {
  const missingGuids = Array.from(
    new Set(
      items
        .filter(needsOrganizationName)
        .map((item) => item.organizationGuid || item.organization?.guid)
        .filter((guid): guid is string => Boolean(guid))
    )
  );
  if (!missingGuids.length) return items;

  const resolved = new Map<string, LiveOrganization>();
  await Promise.all(
    missingGuids.map(async (guid) => {
      try {
        const organization = await findLiveOrganization(guid);
        if (organization) resolved.set(guid.toLowerCase(), organization);
      } catch {
        // Keep the original value when the organization cannot be resolved.
      }
    })
  );

  return items.map((item) => {
    if (!needsOrganizationName(item)) return item;
    const guid = item.organizationGuid || item.organization?.guid;
    const organization = guid ? resolved.get(guid.toLowerCase()) : null;
    if (!guid || !organization) return item;
    return {
      ...item,
      organizationGuid: item.organizationGuid || organization.guid,
      organization: {
        guid: organization.guid,
        name: organization.name,
        code: organization.code,
      },
    };
  });
}

function mapCounterparty(record: AnyRecord): LiveCounterparty | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'Наименование'], guid);
  if (!guid || !name) return null;
  const addresses = readArray(record, ['addresses', 'deliveryAddresses']).flatMap((item) => {
    const mapped = asRecord(item);
    return mapped ? [mapDeliveryAddress(mapped)].filter(Boolean) as LiveDeliveryAddress[] : [];
  });
  const managerRecord = readObject(record, ['manager', 'responsibleManager']);
  const managerGuid = text(record, ['managerGuid', 'responsibleManagerGuid'], null) ?? entityGuid(managerRecord);
  const managerName = text(record, ['managerName', 'responsibleManagerName'], null) ?? text(managerRecord, ['name'], null);
  return {
    guid,
    name,
    fullName: text(record, ['fullName', 'ПолноеНаименование'], null),
    inn: text(record, ['inn', 'ИНН'], null),
    kpp: text(record, ['kpp', 'КПП'], null),
    phone: text(record, ['phone', 'Телефон'], null),
    email: text(record, ['email', 'Email'], null),
    isActive: isEntityActive(record),
    managerGuid,
    managerName,
    manager: managerGuid || managerName ? { guid: managerGuid, name: managerName } : null,
    defaultAgreement: mapAgreement(readObject(record, ['defaultAgreement', 'agreement']) ?? {}),
    defaultContract: mapContract(readObject(record, ['defaultContract', 'contract']) ?? {}),
    defaultWarehouse: mapWarehouse(readObject(record, ['defaultWarehouse', 'warehouse']) ?? {}),
    defaultDeliveryAddress: mapDeliveryAddress(readObject(record, ['defaultDeliveryAddress', 'deliveryAddress']) ?? {}),
    addresses,
  };
}

function mapContract(record: AnyRecord): LiveContract | null {
  const guid = entityGuid(record);
  const number = text(record, ['number', 'name', 'Номер', 'Наименование'], guid);
  if (!guid || !number) return null;
  const organizationRecord = readObject(record, ['organization']);
  const managerRecord = readObject(record, ['manager', 'responsibleManager']);
  const organizationGuid = text(record, ['organizationGuid'], null) ?? entityGuid(organizationRecord);
  const managerGuid = text(record, ['managerGuid', 'responsibleManagerGuid'], null) ?? entityGuid(managerRecord);
  const managerName = text(record, ['managerName', 'responsibleManagerName'], null) ?? text(managerRecord, ['name'], null);
  const organizationName = text(organizationRecord, ['name', 'Наименование'], null) ?? text(record, ['organizationName'], null);
  return {
    guid,
    number,
    name: text(record, ['name', 'Наименование'], null),
    date: text(record, ['date', 'Дата'], null),
    validFrom: text(record, ['validFrom'], null),
    validTo: text(record, ['validTo'], null),
    counterpartyGuid: text(record, ['counterpartyGuid'], null),
    organizationGuid,
    organization: organizationGuid
      ? {
          guid: organizationGuid,
          name: organizationName || organizationGuid,
          code: text(organizationRecord, ['code', 'Код'], null) ?? text(record, ['organizationCode'], null),
        }
      : null,
    managerGuid,
    managerName,
    manager: managerGuid || managerName ? { guid: managerGuid, name: managerName } : null,
    status: text(record, ['status'], null),
    purpose: text(record, ['purpose', 'ТипДоговора', 'contractType', 'ЦельДоговора'], null),
    currency: text(record, ['currency'], null),
    isActive: isEntityActive(record),
  };
}

function mapAgreement(record: AnyRecord): LiveAgreement | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'agreementName', 'Наименование'], guid);
  if (!guid || !name) return null;
  const contractRecord = readObject(record, ['contract']);
  const warehouseRecord = readObject(record, ['warehouse']);
  const priceTypeRecord = readObject(record, ['priceType']);
  const organizationRecord = readObject(record, ['organization']);
  const managerRecord = readObject(record, ['manager', 'responsibleManager']);
  const contractGuid = text(record, ['contractGuid'], null) ?? entityGuid(contractRecord);
  const warehouseGuid = text(record, ['warehouseGuid'], null) ?? entityGuid(warehouseRecord);
  const priceTypeGuid = text(record, ['priceTypeGuid'], null) ?? entityGuid(priceTypeRecord);
  const organizationGuid = text(record, ['organizationGuid'], null) ?? entityGuid(organizationRecord);
  const managerGuid = text(record, ['managerGuid', 'responsibleManagerGuid'], null) ?? entityGuid(managerRecord);
  const managerName = text(record, ['managerName', 'responsibleManagerName'], null) ?? text(managerRecord, ['name'], null);
  const organizationName = text(organizationRecord, ['name', 'Наименование'], null) ?? text(record, ['organizationName'], null);
  return {
    guid,
    name,
    number: text(record, ['number'], null),
    date: text(record, ['date'], null),
    counterpartyGuid: text(record, ['counterpartyGuid'], null),
    organizationGuid,
    organization: organizationGuid
      ? {
          guid: organizationGuid,
          name: organizationName || organizationGuid,
          code: text(organizationRecord, ['code', 'Код'], null) ?? text(record, ['organizationCode'], null),
        }
      : null,
    managerGuid,
    managerName,
    manager: managerGuid || managerName ? { guid: managerGuid, name: managerName } : null,
    contractGuid,
    warehouseGuid,
    priceTypeGuid,
    currency: text(record, ['currency'], null),
    status: text(record, ['status'], null),
    isActive: isEntityActive(record),
    contract: contractGuid
      ? { guid: contractGuid, number: text(contractRecord, ['number', 'name'], contractGuid) ?? contractGuid }
      : null,
    warehouse: warehouseGuid
      ? { guid: warehouseGuid, name: text(warehouseRecord, ['name'], warehouseGuid) ?? warehouseGuid }
      : null,
    priceType: priceTypeGuid
      ? { guid: priceTypeGuid, name: text(priceTypeRecord, ['name'], priceTypeGuid) ?? priceTypeGuid }
      : null,
  };
}

function mapDeliveryAddress(record: AnyRecord): LiveDeliveryAddress | null {
  const guid = entityGuid(record, ['guid', 'id']);
  const fullAddress = text(record, ['fullAddress', 'address', 'Адрес'], null);
  const name = text(record, ['name', 'Наименование'], null);
  const comment = text(record, ['deliveryComment', 'comment', 'Комментарий', 'ДополнительнаяИнформацияПоДоставке'], null);
  const kindName = text(record, ['kindName', 'contactInfoKind', 'ВидАдреса', 'Вид'], null);
  const deliveryNumber = text(record, ['deliveryNumber', 'number', 'НомерАдресаДоставки'], null) ?? extractDeliveryAddressNumber(kindName);
  if (!guid && !fullAddress) return null;
  return {
    guid,
    name,
    fullAddress: fullAddress ?? name ?? guid ?? '',
    deliveryNumber,
    number: deliveryNumber,
    comment,
    deliveryComment: comment,
    kindName,
    contactInfoKind: kindName,
    counterpartyGuid: text(record, ['counterpartyGuid'], null),
    isDefault: bool(record, ['isDefault', 'default'], false),
    isActive: isEntityActive(record),
  };
}

function mapPriceType(record: AnyRecord): LivePriceType | null {
  const guid = entityGuid(record, ['guid', 'id', 'priceTypeGuid']);
  const name = text(record, ['name', 'priceTypeName', 'Наименование'], guid);
  if (!guid || !name) return null;
  return {
    guid,
    name,
    code: text(record, ['code', 'priceTypeCode', 'Код']),
    isActive: !bool(record, ['deletionMark', 'DeletionMark', 'ПометкаУдаления'], false) && bool(record, ['isActive', 'priceTypeIsActive', 'active'], true),
  };
}

function mapClientOrderDefaultsPayload(payload: unknown): LiveClientOrderDefaults {
  const envelope = asRecord(payload);
  const record =
    readObject(envelope, ['defaults']) ??
    readObject(envelope, ['data']) ??
    envelope ??
    {};
  const warnings = readArray(record, ['warnings'])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return {
    organization: mapOrganization(readObject(record, ['organization', 'Организация']) ?? {}),
    counterparty: mapCounterparty(readObject(record, ['counterparty', 'Контрагент']) ?? {}),
    agreement: mapAgreement(readObject(record, ['agreement', 'Соглашение']) ?? {}),
    contract: mapContract(readObject(record, ['contract', 'Договор']) ?? {}),
    warehouse: mapWarehouse(readObject(record, ['warehouse', 'Склад']) ?? {}),
    deliveryAddress: mapDeliveryAddress(readObject(record, ['deliveryAddress', 'АдресДоставки']) ?? {}),
    priceType: mapPriceType(readObject(record, ['priceType', 'ВидЦены']) ?? {}),
    paymentForm: null,
    paymentForms: DEFAULT_PAYMENT_FORM_OPTIONS.map((item) => ({ ...item })),
    deliveryMethod: DEFAULT_DELIVERY_METHOD,
    deliveryMethods: DEFAULT_DELIVERY_METHOD_OPTIONS.map((item) => ({ ...item })),
    currency: text(record, ['currency', 'Валюта'], DEFAULT_CURRENCY),
    warnings,
  };
}

function mapUnit(record: AnyRecord | null | undefined, productGuid: string) {
  if (!record) return null;
  const guid = entityGuid(record) ?? `default-unit-${productGuid}`;
  const name = text(record, ['name', 'Наименование'], 'шт') ?? 'шт';
  return {
    guid,
    name,
    symbol: text(record, ['symbol', 'code', 'Код'], name),
  };
}

function normalizeUnitToken(value?: string | null) {
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

function unitLabelIdentities(unit: LiveProductPackage['unit'] | LiveProduct['baseUnit']) {
  const labels = [
    normalizeUnitToken(unit?.symbol),
    normalizeUnitToken(unit?.name),
    normalizeUnitToken(`${unit?.symbol ?? ''}${unit?.name ?? ''}`),
  ].filter(Boolean);
  return new Set(labels);
}

function sameUnitIdentity(left: LiveProductPackage['unit'] | LiveProduct['baseUnit'], right: LiveProductPackage['unit'] | LiveProduct['baseUnit']) {
  const leftGuid = left?.guid?.trim().toLocaleLowerCase('ru');
  const rightGuid = right?.guid?.trim().toLocaleLowerCase('ru');
  if (leftGuid && rightGuid && leftGuid === rightGuid) return true;
  const leftLabels = unitLabelIdentities(left);
  const rightLabels = unitLabelIdentities(right);
  for (const label of leftLabels) {
    if (rightLabels.has(label)) return true;
  }
  return false;
}

function isBaseUnitPackage(pack: LiveProductPackage, baseUnit: LiveProduct['baseUnit']) {
  if (!baseUnit) return false;
  const multiplier = Number(pack.multiplier ?? 1);
  const sameMultiplier = !Number.isFinite(multiplier) || multiplier <= 0 || Math.abs(multiplier - 1) < 0.000001;
  return sameMultiplier && (!pack.unit || sameUnitIdentity(pack.unit, baseUnit));
}

function mapPackage(record: AnyRecord, fallbackUnit: LiveProduct['baseUnit']): LiveProductPackage | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'Наименование'], guid);
  if (!guid || !name) return null;
  const unit = mapUnit(readObject(record, ['unit']), guid) ?? fallbackUnit;
  return {
    guid,
    name,
    multiplier: numberValue(record, ['multiplier', 'coefficient', 'packageCoefficient', 'quantityPerPackage'], 1),
    isDefault: bool(record, ['isDefault', 'default'], false),
    unit,
  };
}

function mapStock(record: AnyRecord | null | undefined) {
  if (!record) return null;
  const quantity = numberValue(record, ['quantity', 'inStock', 'stock'], null);
  const reserved = numberValue(record, ['reserved'], null);
  const freeAvailable = numberValue(record, ['freeAvailable'], null);
  const myReserved = numberValue(record, ['myReserved'], null);
  const available = numberValue(record, ['available'], freeAvailable ?? quantity);
  if (
    quantity === null &&
    reserved === null &&
    available === null &&
    freeAvailable === null &&
    myReserved === null
  ) {
    return null;
  }
  return { quantity, reserved, available, freeAvailable, myReserved };
}

function mapProduct(record: AnyRecord): LiveProduct | null {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'fullName', 'Наименование'], guid);
  if (!guid || !name) return null;
  const baseUnit = mapUnit(readObject(record, ['baseUnit']), guid);
  const packageRows = readArray(record, ['packages']).flatMap((item) => {
    const mapped = asRecord(item);
    return mapped ? [mapPackage(mapped, baseUnit)].filter(Boolean) as LiveProductPackage[] : [];
  });
  const defaultPackage = mapPackage(readObject(record, ['defaultPackage']) ?? {}, baseUnit);
  const rawPackages = packageRows.length ? packageRows : defaultPackage ? [defaultPackage] : [];
  const packages = rawPackages.filter((pack) => !isBaseUnitPackage(pack, baseUnit));
  const basePrice = numberValue(record, ['basePrice', 'price'], null);
  const priceType = mapNamedRef(readObject(record, ['priceType']), ['guid', 'priceTypeGuid'], ['name', 'priceTypeName']);
  return {
    guid,
    name,
    code: text(record, ['code', 'Код'], null),
    article: text(record, ['article', 'Артикул'], null),
    sku: text(record, ['sku'], null),
    isWeight: bool(record, ['isWeight'], false),
    isActive: isEntityActive(record),
    baseUnit,
    packages,
    basePrice,
    receiptPrice: numberValue(record, ['receiptPrice', 'costPrice'], null),
    currency: text(record, ['currency'], DEFAULT_CURRENCY),
    priceType,
    stock: mapStock(readObject(record, ['stock']) ?? record),
    priceMatch: read(record, ['priceMatch']) ?? (basePrice !== null ? { source: 'onec-live', level: '1c' } : null),
    priceError: text(record, ['priceError'], basePrice === null ? 'Цена не передана из 1С' : null),
  };
}

function mapKnownOnecOrderStatus(value: string | null | undefined) {
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
  if (normalized.includes('отмен')) return 'CANCELLED';
  if (normalized.includes('отклон')) return 'REJECTED';
  if (normalized.includes('несоглас')) return 'NOT_CONFIRMED';
  if (normalized.includes('неподтверж')) return 'NOT_CONFIRMED';
  if (normalized.includes('частич')) return 'PARTIAL';
  if (normalized.includes('кобеспеч')) return 'TO_SUPPLY';
  if (normalized.includes('котгруз')) return 'TO_SHIP';
  if (normalized.includes('резерв')) return 'IN_RESERVE';
  if (normalized.includes('квыполн')) return 'TO_FULFILLMENT';
  if (normalized.includes('выполн')) return 'COMPLETED';
  if (normalized.includes('закры')) return 'CLOSED';
  if (normalized.includes('подтверж')) return 'CONFIRMED';
  return null;
}

function mapOrderStatus(record: AnyRecord) {
  const raw = text(record, ['status', 'statusCode'], null);
  const state1c = text(record, ['currentState1c', 'currentState', 'state1c', 'stateName', 'Состояние'], null);
  const raw1c = text(record, ['status1c', 'Статус'], null);
  const hasOnecNumber = Boolean(text(record, ['number1c', 'documentNumber', 'number', 'Номер'], null));
  const mappedState1c = mapKnownOnecOrderStatus(state1c);
  if (mappedState1c) return mappedState1c;
  const mappedRaw1c = mapKnownOnecOrderStatus(raw1c);
  if (mappedRaw1c) return mappedRaw1c;

  const candidate = (raw || '').trim().toUpperCase();
  if ([
    'DRAFT',
    'QUEUED',
    'SENT_TO_1C',
    'CONFIRMED',
    'PARTIAL',
    'REJECTED',
    'CANCELLED',
    'AWAITING_APPROVAL',
    'AWAITING_ADVANCE_BEFORE_SUPPLY',
    'READY_FOR_SUPPLY',
    'AWAITING_PREPAYMENT_BEFORE_SHIPMENT',
    'AWAITING_SUPPLY',
    'READY_FOR_SHIPMENT',
    'SHIPPING_IN_PROGRESS',
    'AWAITING_PAYMENT_AFTER_SHIPMENT',
    'READY_TO_CLOSE',
    'NOT_CONFIRMED',
    'TO_SUPPLY',
    'TO_SHIP',
    'IN_RESERVE',
    'TO_FULFILLMENT',
    'COMPLETED',
    'CLOSED',
  ].includes(candidate)) {
    return candidate;
  }
  const mappedRaw = mapKnownOnecOrderStatus(raw);
  if (mappedRaw) return mappedRaw;
  if (state1c) return state1c;
  if (raw1c) return raw1c;
  if (bool(record, ['isPostedIn1c', 'isPosted', 'posted', 'Проведен'], false)) return 'CONFIRMED';
  return 'SENT_TO_1C';
}

function mapOrderRef(record: AnyRecord | null | undefined) {
  const guid = entityGuid(record);
  const name = text(record, ['name', 'number', 'fullName', 'Наименование', 'Номер'], guid);
  return guid && name ? { guid, name } : null;
}

function mapOrderCounterparty(record: AnyRecord | null | undefined) {
  const base = mapOrderRef(record);
  if (!base) return null;
  return {
    ...base,
    fullName: text(record, ['fullName', 'ПолноеНаименование'], null),
    inn: text(record, ['inn', 'ИНН'], null),
    kpp: text(record, ['kpp', 'КПП'], null),
  };
}

function mapOrderItem(record: AnyRecord, index: number): LiveClientOrder['items'][number] | null {
  const productRecord = readObject(record, ['product', 'nomenclature']) ?? record;
  const productGuid = entityGuid(productRecord, ['guid', 'productGuid', 'nomenclatureGuid', 'id']);
  const productName = text(productRecord, ['name', 'productName', 'nomenclatureName', 'Наименование'], productGuid);
  if (!productGuid || !productName) return null;

  const packageRecord = readObject(record, ['package', 'packaging', 'unitPackage']);
  const unitRecord = readObject(record, ['unit', 'baseUnit']);
  const priceTypeRecord = readObject(record, ['priceType']);
  const lineGuid = text(record, ['lineGuid', 'appLineGuid', 'МЗИП_AppLineGuid', 'lineId', 'id'], null) ?? `${productGuid}-${index + 1}`;
  return {
    id: text(record, ['id', 'lineId'], lineGuid),
    lineGuid,
    quantity: numberValue(record, ['quantity', 'Количество'], 0),
    quantityBase: numberValue(record, ['quantityBase', 'baseQuantity', 'КоличествоБаза'], null),
    basePrice: numberValue(record, ['basePrice', 'price', 'Цена'], null),
    price: numberValue(record, ['price', 'basePrice', 'Цена'], null),
    isManualPrice: bool(record, ['isManualPrice', 'manualPriceEnabled'], false),
    manualPrice: numberValue(record, ['manualPrice'], null),
    priceSource: text(record, ['priceSource'], null),
    isCancelled: bool(record, ['isCancelled', 'cancelled', 'Отменено'], false),
    cancelReasonGuid: text(record, ['cancelReasonGuid', 'cancelReasonId'], null),
    cancelReasonName: text(record, ['cancelReasonName'], null),
    cancelReason: text(record, ['cancelReason', 'cancelReasonName'], null),
    cancelledAmount: numberValue(record, ['cancelledAmount', 'cancelledSum', 'СуммаОтменено'], null),
    priceType: mapNamedRef(priceTypeRecord, ['guid', 'priceTypeGuid'], ['name', 'priceTypeName']),
    discountPercent: numberValue(record, ['discountPercent', 'Скидка'], null),
    appliedDiscountPercent: numberValue(record, ['appliedDiscountPercent', 'discountPercent'], null),
    lineAmount: numberValue(record, ['lineAmount', 'amount', 'Сумма'], null),
    comment: text(record, ['comment', 'Комментарий'], null),
    product: {
      guid: productGuid,
      name: productName,
      code: text(productRecord, ['code', 'Код'], null),
      article: text(productRecord, ['article', 'Артикул'], null),
      sku: text(productRecord, ['sku'], null),
      isWeight: bool(productRecord, ['isWeight'], false),
    },
    package: packageRecord
      ? {
          guid: entityGuid(packageRecord),
          name: text(packageRecord, ['name', 'Наименование'], null),
          multiplier: numberValue(packageRecord, ['multiplier', 'coefficient', 'packageCoefficient', 'quantityPerPackage'], null),
          isDefault: bool(packageRecord, ['isDefault'], false),
        }
      : null,
    unit: unitRecord
      ? {
          guid: entityGuid(unitRecord),
          name: text(unitRecord, ['name', 'Наименование'], null),
          symbol: text(unitRecord, ['symbol', 'code', 'Код'], null),
        }
      : null,
  };
}

function mapClientOrder(record: AnyRecord, preferDocumentGuid = false): LiveClientOrder | null {
  const documentGuid = entityGuid(record, ['documentGuid', 'guid', 'id', 'Ссылка']);
  const appGuid = text(record, ['appGuid', 'appOrderGuid', 'localGuid', 'sourceGuid'], null);
  if (!documentGuid && !appGuid) return null;
  const items = readArray(record, ['items', 'products', 'goods', 'Товары']).flatMap((item, index) => {
    const row = asRecord(item);
    if (!row) return [];
    const mapped = mapOrderItem(row, index);
    return mapped ? [mapped] : [];
  });
  const orderGuid = preferDocumentGuid ? (documentGuid ?? appGuid) : (appGuid ?? documentGuid);
  const isPosted = bool(record, ['isPostedIn1c', 'isPosted', 'posted', 'Проведен'], false);
  const hasRealization = bool(record, ['hasRealization', 'realizationExists'], false);
  const priceType = mapNamedRef(readObject(record, ['priceType']), ['guid', 'priceTypeGuid'], ['name', 'priceTypeName']);
  const currentState1c = text(record, ['currentState1c', 'currentState', 'state1c', 'stateName', 'Состояние'], null);
  const documentStatus1c = text(record, ['documentStatus1c', 'documentStatus', 'СтатусДокумента'], null);
  const status1c = currentState1c ?? text(record, ['status1c', 'Статус'], null);
  return {
    guid: orderGuid!,
    appGuid,
    documentGuid: documentGuid ?? orderGuid!,
    number1c: text(record, ['number1c', 'documentNumber', 'number', 'Номер'], null),
    date1c: text(record, ['date1c', 'documentDate', 'date', 'Дата'], null),
    source: 'ONEC_LIVE',
    origin: 'onec',
    readOnly: hasRealization,
    readOnlyReason: hasRealization
      ? text(record, ['readOnlyReason'], null) ?? 'По заказу создана проведенная реализация товаров и услуг.'
      : null,
    hasRealization,
    revision: numberValue(record, ['revision'], 1) ?? 1,
    syncState: 'SYNCED',
    status: mapOrderStatus(record),
    status1c,
    currentState1c,
    documentStatus1c,
    comment: text(record, ['comment', 'Комментарий'], null),
    deliveryDate: text(record, ['deliveryDate', 'shipmentDate', 'ДатаОтгрузки'], null),
    paymentForm: text(record, ['paymentForm', 'ФормаОплаты'], null),
    deliveryMethod: text(record, ['deliveryMethod', 'СпособДоставки'], null),
    totalAmount: numberValue(record, ['totalAmount', 'amount', 'СуммаДокумента'], null),
    currency: text(record, ['currency'], DEFAULT_CURRENCY) ?? DEFAULT_CURRENCY,
    priceType,
    queuedAt: null,
    sentTo1cAt: text(record, ['lastImportedAt', 'sentTo1cAt'], null),
    lastStatusSyncAt: text(record, ['lastStatusSyncAt', 'updatedAt'], null),
    lastExportError: text(record, ['lastExportError'], null),
    last1cError: text(record, ['last1cError', 'lastError'], null),
    isPostedIn1c: isPosted,
    cancelRequestedAt: null,
    counterparty: mapOrderCounterparty(readObject(record, ['counterparty', 'Контрагент'])),
    organization: mapOrganization(readObject(record, ['organization', 'Организация']) ?? {}) as LiveClientOrder['organization'],
    warehouse: mapOrderWarehouse(record),
    agreement: mapAgreement(readObject(record, ['agreement', 'Соглашение']) ?? {}),
    contract: mapContract(readObject(record, ['contract', 'Договор']) ?? {}),
    deliveryAddress: mapDeliveryAddress(readObject(record, ['deliveryAddress', 'АдресДоставки']) ?? {}),
    itemsCount: numberValue(record, ['itemsCount', 'linesCount'], items.length) ?? items.length,
    items,
    events: [],
    createdAt: text(record, ['createdAt', 'date1c', 'documentDate', 'date'], null),
    updatedAt: text(record, ['updatedAt', 'sourceUpdatedAt'], null),
    sourceUpdatedAt: text(record, ['sourceUpdatedAt', 'updatedAt'], null),
  };
}

function findItemByGuid<T extends { guid: string | null; isActive?: boolean }>(items: T[], guid: string) {
  return items.find((item) => item.guid?.toLowerCase() === guid.toLowerCase()) ?? null;
}

function firstItemFromPayload<T>(payload: unknown, keys: string[], mapper: (item: AnyRecord) => T | null) {
  const list = extractListPayload(payload, keys);
  for (const item of list.items) {
    const record = asRecord(item);
    if (!record) continue;
    const mapped = mapper(record);
    if (mapped) return mapped;
  }
  const itemRecord = asRecord(read(asRecord(payload), ['item']));
  return itemRecord ? mapper(itemRecord) : null;
}

async function findOneFromList<T extends { guid: string | null; isActive?: boolean }>(
  guid: string,
  query: OnecLpAppQuery,
  loader: (query: OnecLpAppQuery) => Promise<unknown>,
  keys: string[],
  mapper: (item: AnyRecord) => T | null
) {
  const payload = await loader({ ...query, guid, search: guid, limit: 20, offset: 0 });
  const page = visiblePage(paged(payload, keys, mapper, { limit: 20, offset: 0 }), Boolean(query.includeInactive));
  return findItemByGuid(page.items, guid);
}

export async function getLiveOrganizations(query: { limit?: number; offset?: number; search?: string; includeInactive?: boolean } = {}) {
  return liveSmartPaged(query, getOnecLpAppOrganizations, ['organizations'], mapOrganization);
}

export async function findLiveOrganization(guid: string) {
  return findOneFromList(guid, {}, getOnecLpAppOrganizations, ['organizations'], mapOrganization);
}

export async function getLiveCounterparties(query: ClientOrdersCounterpartiesQuery & { managerGuid?: string | null }) {
  return liveSmartPaged(query, getOnecLpAppCounterparties, ['counterparties'], mapCounterparty);
}

export async function findLiveCounterparty(guid: string) {
  return findOneFromList(guid, {}, getOnecLpAppCounterparties, ['counterparties'], mapCounterparty);
}

export async function getLiveAgreements(query: ClientOrdersAgreementsQuery) {
  if (!query.counterpartyGuid) return { items: [], total: 0, limit: query.limit, offset: query.offset };
  const page = await liveSmartPaged(query, getOnecLpAppAgreements, ['agreements'], mapAgreement);
  return { ...page, items: await enrichOrganizationNames(page.items) };
}

export async function findLiveAgreement(guid: string, counterpartyGuid?: string) {
  const item = await findOneFromList(guid, { counterpartyGuid }, getOnecLpAppAgreements, ['agreements'], mapAgreement);
  return item ? (await enrichOrganizationNames([item]))[0] ?? null : null;
}

export async function getLiveContracts(query: ClientOrdersContractsQuery) {
  if (!query.counterpartyGuid) return { items: [], total: 0, limit: query.limit, offset: query.offset };
  const page = await liveSmartPaged(query, getOnecLpAppContracts, ['contracts'], mapContract);
  return { ...page, items: await enrichOrganizationNames(page.items) };
}

export async function findLiveContract(guid: string, counterpartyGuid?: string) {
  const item = await findOneFromList(guid, { counterpartyGuid }, getOnecLpAppContracts, ['contracts'], mapContract);
  return item ? (await enrichOrganizationNames([item]))[0] ?? null : null;
}

export async function getLiveWarehouses(query: ClientOrdersWarehousesQuery) {
  return liveSmartPaged(query, getOnecLpAppWarehouses, ['warehouses'], mapWarehouse);
}

export async function findLiveWarehouse(guid: string) {
  return findOneFromList(guid, {}, getOnecLpAppWarehouses, ['warehouses'], mapWarehouse);
}

export async function getLivePriceTypes(query: ClientOrdersPriceTypesQuery) {
  return liveSmartPaged(query, getOnecLpAppPriceTypes, ['priceTypes', 'price-types'], mapPriceType);
}

export async function findLivePriceType(guid: string) {
  return findOneFromList(guid, {}, getOnecLpAppPriceTypes, ['priceTypes', 'price-types'], mapPriceType);
}

export async function getLiveDeliveryAddresses(query: ClientOrdersDeliveryAddressesQuery) {
  if (!query.counterpartyGuid) return { items: [], total: 0, limit: query.limit, offset: query.offset };
  return liveSmartPaged(
    { ...query, deliveryAddressNumber: query.deliveryAddressNumber ?? extractDeliveryAddressNumber(query.search) },
    getOnecLpAppDeliveryAddresses,
    ['deliveryAddresses', 'delivery-addresses'],
    mapDeliveryAddress
  );
}

export async function findLiveDeliveryAddress(guid: string, counterpartyGuid?: string) {
  const foundByGuid = await findOneFromList(
    guid,
    { counterpartyGuid },
    getOnecLpAppDeliveryAddresses,
    ['deliveryAddresses', 'delivery-addresses'],
    mapDeliveryAddress
  );
  if (foundByGuid || !counterpartyGuid) return foundByGuid;

  const limit = 100;
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await getLiveDeliveryAddresses({ counterpartyGuid, limit, offset, includeInactive: false });
    const found = findItemByGuid(page.items, guid);
    if (found) return found;
    if (page.items.length < limit || page.total <= offset + page.items.length) break;
    offset += limit;
  }

  return null;
}

export async function getLiveProducts(query: ClientOrdersProductsQuery & { managerGuid?: string | null }) {
  return liveSmartPaged(query, getOnecLpAppNomenclature, ['nomenclature', 'products'], mapProduct);
}

export async function getLiveClientOrders(query: ClientOrdersListQuery & { managerGuid: string }) {
  const normalized = normalizeQuery(query);
  const limit = Number(normalized.limit ?? DEFAULT_LIMIT);
  const offset = Number(normalized.offset ?? 0);
  return paged(await getOnecLpAppClientOrders(normalized), ['clientOrders', 'orders'], (item) => mapClientOrder(item, true), {
    limit,
    offset,
  });
}

export async function findLiveClientOrder(params: { managerGuid: string; appGuid?: string | null; number1c?: string | null }) {
  const query = normalizeQuery({
    managerGuid: params.managerGuid,
    appGuid: params.appGuid ?? undefined,
    number1c: params.number1c ?? undefined,
    search: params.appGuid ?? params.number1c ?? undefined,
    limit: 10,
    offset: 0,
  });
  const page = paged(await getOnecLpAppClientOrders(query), ['clientOrders', 'orders'], (item) => mapClientOrder(item, true), {
    limit: 10,
    offset: 0,
  });
  const appGuid = params.appGuid?.toLowerCase();
  const number1c = params.number1c?.toLowerCase();
  return (
    page.items.find((item) => appGuid && item.appGuid?.toLowerCase() === appGuid) ??
    page.items.find((item) => number1c && item.number1c?.toLowerCase() === number1c) ??
    null
  );
}

export async function getLiveClientOrder(documentGuid: string, query: { managerGuid: string; appGuid?: string | null } = { managerGuid: '' }) {
  const payload = await getOnecLpAppClientOrder(documentGuid, normalizeQuery({
    managerGuid: query.managerGuid,
    appGuid: query.appGuid ?? undefined,
    includeItems: true,
  }));
  const record =
    asRecord(read(asRecord(payload), ['item'])) ??
    asRecord(read(asRecord(payload), ['order'])) ??
    asRecord(read(asRecord(payload), ['data'])) ??
    asRecord(payload);
  const mapped = record ? mapClientOrder(record, true) : null;
  if (!mapped) throw new Error(`Client order ${documentGuid} was not found in 1C`);
  return mapped;
}

export async function getLiveProductsByGuids(body: ClientOrdersBatchProductsBody & { managerGuid?: string | null }) {
  const uniqueGuids = [...new Set(body.productGuids)];
  const query = normalizeQuery({
    limit: Math.min(Math.max(uniqueGuids.length, 1), 200),
    offset: 0,
    organizationGuid: body.organizationGuid,
    counterpartyGuid: body.counterpartyGuid,
    agreementGuid: body.agreementGuid,
    warehouseGuid: body.warehouseGuid,
    priceTypeGuid: body.priceTypeGuid,
    managerGuid: body.managerGuid ?? undefined,
  });
  const listPayload = await getOnecLpAppNomenclature({ ...query, guids: uniqueGuids.join(',') });
  const list = visiblePage(paged(listPayload, ['nomenclature', 'products'], mapProduct, {
    limit: Number(query.limit ?? DEFAULT_LIMIT),
    offset: 0,
  }), false).items;
  const byGuid = new Map(list.map((item) => [item.guid.toLowerCase(), item]));
  const missing = uniqueGuids.filter((guid) => !byGuid.has(guid.toLowerCase()));

  if (missing.length) {
    const details = await Promise.all(
      missing.map(async (guid) => {
        const payload = await getOnecLpAppNomenclatureItem(guid, query);
        const item = firstItemFromPayload(payload, ['nomenclature', 'products'], mapProduct);
        return item?.isActive === false ? null : item;
      })
    );
    details.forEach((item) => {
      if (item) byGuid.set(item.guid.toLowerCase(), item);
    });
  }

  return uniqueGuids.flatMap((guid) => {
    const item = byGuid.get(guid.toLowerCase());
    return item ? [item] : [];
  });
}

export async function findLiveProduct(guid: string, context: Omit<ClientOrdersBatchProductsBody, 'productGuids'> = {}) {
  const items = await getLiveProductsByGuids({ ...context, productGuids: [guid] });
  return items[0] ?? null;
}

export async function getLiveClientOrderDefaults(query: ClientOrderDefaultsQuery) {
  const normalized = normalizeQuery({
    organizationGuid: query.organizationGuid,
    counterpartyGuid: query.counterpartyGuid,
    limit: 1,
    offset: 0,
  });
  return mapClientOrderDefaultsPayload(await getOnecLpAppClientOrderDefaults(normalized));
}

export async function getLiveReferenceData(query: ClientOrdersReferenceDataQuery) {
  const [counterparties, agreements, contracts, deliveryAddresses, warehouses] = await Promise.all([
    getLiveCounterparties({ limit: 100, offset: 0, includeInactive: query.includeInactive }),
    query.counterpartyGuid
      ? getLiveAgreements({ limit: 100, offset: 0, includeInactive: query.includeInactive, organizationGuid: query.organizationGuid, counterpartyGuid: query.counterpartyGuid })
      : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 }),
    query.counterpartyGuid
      ? getLiveContracts({ limit: 100, offset: 0, includeInactive: query.includeInactive, organizationGuid: query.organizationGuid, counterpartyGuid: query.counterpartyGuid })
      : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 }),
    query.counterpartyGuid
      ? getLiveDeliveryAddresses({ limit: 100, offset: 0, includeInactive: query.includeInactive, organizationGuid: query.organizationGuid, counterpartyGuid: query.counterpartyGuid })
      : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 }),
    getLiveWarehouses({ limit: 100, offset: 0, includeInactive: query.includeInactive, organizationGuid: query.organizationGuid, counterpartyGuid: query.counterpartyGuid }),
  ]);

  return {
    counterparties: counterparties.items,
    agreements: agreements.items,
    contracts: contracts.items,
    deliveryAddresses: deliveryAddresses.items,
    warehouses: warehouses.items,
  };
}

export async function getLiveReferenceDetails(params: ClientOrderReferenceDetailsParams): Promise<LiveReferenceDetails> {
  const { kind, guid } = params;
  const item =
    kind === 'organization' ? await findLiveOrganization(guid)
    : kind === 'counterparty' ? await findLiveCounterparty(guid)
    : kind === 'agreement' ? await findLiveAgreement(guid)
    : kind === 'contract' ? await findLiveContract(guid)
    : kind === 'warehouse' ? await findLiveWarehouse(guid)
    : kind === 'delivery-address' ? await findLiveDeliveryAddress(guid)
    : await findLivePriceType(guid);

  if (!item) {
    throw new Error(`Reference ${kind}:${guid} was not found in 1C`);
  }

  const record = item as AnyRecord;
  const title = text(record, ['name', 'number', 'fullAddress'], guid) ?? guid;
  return {
    kind,
    guid,
    title,
    subtitle: text(record, ['fullName', 'inn', 'code'], null),
    sections: [
      {
        title: 'Основное',
        rows: Object.entries(record)
          .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
          .slice(0, 16)
          .map(([label, value]) => ({ label, value })),
      },
    ],
    debug: item,
  };
}
