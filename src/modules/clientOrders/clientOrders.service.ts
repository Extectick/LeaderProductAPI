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
import { ErrorCodes } from '../../utils/apiResponse';
import { appendOrderEvent } from '../orders/orderEvents';
import { decimalToNumber, mapOrderDetail, orderDetailSelect, toDecimal } from '../orders/orderModel';
import { MarketplaceError } from '../marketplace/marketplace.service';
import type {
  ClientOrderCancelBody,
  ClientOrderCreateBody,
  ClientOrderDefaultsQuery,
  ClientOrderReferenceDetailsParams,
  ClientOrderSettingsUpdateBody,
  ClientOrderSubmitBody,
  ClientOrderUpdateBody,
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
};

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

class ClientOrdersError extends Error {
  public readonly status: number;
  public readonly code: ClientOrdersErrorCode;

  constructor(status: number, code: ClientOrdersErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_ORDER_CURRENCY = 'RUB';
const SMART_SEARCH_TRIGRAM_THRESHOLD = 0.18;
const CLOSED_AGREEMENT_STATUS = 'Закрыто';
const CLOSED_CONTRACT_STATUS = 'Закрыт';
const RECEIPT_PRICE_TYPE_TOKEN = '\u0446\u0435\u043d\u0430\u043f\u043e\u0441\u0442\u0443\u043f\u043b\u0435\u043d\u0438\u044f';
const now = () => new Date();

const agreementNotClosedWhere = (): Prisma.ClientAgreementWhereInput => ({
  OR: [{ status: null }, { status: { not: CLOSED_AGREEMENT_STATUS } }],
});

const contractNotClosedWhere = (): Prisma.ClientContractWhereInput => ({
  OR: [{ status: null }, { status: { not: CLOSED_CONTRACT_STATUS } }],
});

const activeAgreementWhere = (): Prisma.ClientAgreementWhereInput => ({ isActive: true, AND: [agreementNotClosedWhere()] });
const activeContractWhere = (): Prisma.ClientContractWhereInput => ({ isActive: true, AND: [contractNotClosedWhere()] });

function isClosedAgreementStatus(status?: string | null) {
  return status?.trim().toLocaleLowerCase('ru') === CLOSED_AGREEMENT_STATUS.toLocaleLowerCase('ru');
}

function isClosedContractStatus(status?: string | null) {
  return status?.trim().toLocaleLowerCase('ru') === CLOSED_CONTRACT_STATUS.toLocaleLowerCase('ru');
}

function ensureEditable(order: { status: OrderStatus; isPostedIn1c: boolean; source: OrderSource }) {
  if (order.source !== OrderSource.MANAGER_APP) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Заказ менеджера не найден');
  }
  if (order.isPostedIn1c) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Проведенный заказ в 1С доступен только для чтения');
  }
  if (order.status === OrderStatus.CANCELLED) {
    throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Отмененный заказ нельзя редактировать');
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

function rankReferenceItems<T>(
  items: T[],
  search: string,
  fields: ((item: T) => string | null | undefined)[],
  label: (item: T) => string
) {
  const lowered = search.toLowerCase();
  return [...items]
    .map((item) => {
      const values = fields.map((field) => (field(item) ?? '').toLowerCase());
      const exactIndex = values.findIndex((value) => value === lowered);
      const prefixIndex = values.findIndex((value) => value.startsWith(lowered));
      const containsIndex = values.findIndex((value) => value.includes(lowered));
      const rank =
        exactIndex >= 0
          ? exactIndex
          : prefixIndex >= 0
            ? 20 + prefixIndex
            : containsIndex >= 0
              ? 40 + containsIndex
              : 100;
      return { item, rank };
    })
    .sort((left, right) => left.rank - right.rank || label(left.item).localeCompare(label(right.item), 'ru'))
    .map((entry) => entry.item);
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
  const mode = settings?.deliveryDateMode ?? ClientOrderDeliveryDateMode.NEXT_DAY;
  const offset = settings?.deliveryDateOffsetDays ?? 1;
  const fixedDate = settings?.fixedDeliveryDate ?? null;
  const today = startOfDay(now());

  if (mode === ClientOrderDeliveryDateMode.FIXED_DATE) {
    if (!fixedDate) {
      return { resolvedDate: null, issue: 'FIXED_DATE_REQUIRED' };
    }
    const normalizedFixed = startOfDay(fixedDate);
    if (normalizedFixed.getTime() < today.getTime()) {
      return { resolvedDate: normalizedFixed, issue: 'FIXED_DATE_IN_PAST' };
    }
    return { resolvedDate: normalizedFixed, issue: null };
  }

  const safeOffset = mode === ClientOrderDeliveryDateMode.NEXT_DAY ? 1 : Math.max(0, offset);
  return {
    resolvedDate: startOfDay(addDays(today, safeOffset)),
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
        date?: Date | null;
        validFrom?: Date | null;
        validTo?: Date | null;
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

async function resolveManagerOrderContext(tx: Tx, body: ClientOrderCreateBody): Promise<ManagerOrderContext> {
  const organization = await loadOrganizationByGuid(tx, body.organizationGuid);
  const counterparty = await loadCounterpartyByGuid(tx, body.counterpartyGuid);

  const agreement = body.agreementGuid ? await loadAgreementByGuid(tx, body.agreementGuid) : null;
  if (agreement?.counterpartyId && agreement.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Соглашение не принадлежит выбранному контрагенту');
  }

  const contract = body.contractGuid ? await loadContractByGuid(tx, body.contractGuid) : null;
  if (contract?.counterpartyId !== undefined && contract.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не принадлежит выбранному контрагенту');
  }
  if (agreement?.contractId && contract && agreement.contractId !== contract.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Договор не соответствует выбранному соглашению');
  }

  const warehouse = body.warehouseGuid ? await loadWarehouseByGuid(tx, body.warehouseGuid) : null;
  if (agreement?.warehouseId && warehouse && agreement.warehouseId !== warehouse.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Склад не соответствует выбранному соглашению');
  }

  const deliveryAddress = body.deliveryAddressGuid
    ? await loadDeliveryAddressByGuid(tx, body.deliveryAddressGuid)
    : null;
  if (deliveryAddress && deliveryAddress.counterpartyId !== counterparty.id) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, 'Адрес доставки не принадлежит выбранному контрагенту');
  }

  const priceTypeId = agreement?.priceTypeId ?? null;
  const priceType = priceTypeId ? await loadPriceTypeById(tx, priceTypeId) : null;

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

  for (const item of body.items) {
    const product = await tx.product.findUnique({
      where: { guid: item.productGuid },
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

    if (!product) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Товар ${item.productGuid} не найден`);
    }
    if (product.isActive === false) {
      throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Товар ${formatProductLabel(product)} неактивен`);
    }

    let packageRecord: {
      id: string;
      guid: string | null;
      name: string;
      unitId: string;
      multiplier: Prisma.Decimal;
      unit: { guid: string | null; name: string; symbol: string | null };
    } | null = null;

    if (item.packageGuid) {
      packageRecord = await tx.productPackage.findFirst({
        where: { guid: item.packageGuid, productId: product.id },
        select: {
          id: true,
          guid: true,
          name: true,
          unitId: true,
          multiplier: true,
          unit: { select: { guid: true, name: true, symbol: true } },
        },
      });

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

    let linePriceType = item.priceTypeGuid
      ? await loadPriceTypeByGuid(tx, item.priceTypeGuid)
      : isManualPrice
        ? null
        : context.priceType;

    let receiptPrice: ReceiptPriceInfo | null = null;
    if (!isManualPrice) {
      receiptPrice = (await loadReceiptPriceInfoByProductId(tx, [product.id], sourceUpdatedAt)).get(product.id) ?? null;
      linePriceType = receiptPrice?.priceType ?? null;
    }

    const basePriceValue = isManualPrice ? item.manualPrice : receiptPrice?.value;
    if (basePriceValue === null || basePriceValue === undefined) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Не найдена начальная цена ЦенаПоступления для товара ${formatProductLabel(product)}`
      );
    }

    const quantityBaseValue = decimalToNumber(quantityBase) ?? item.quantity;
    const minQty = product.isWeight ? 0.001 : (receiptPrice?.minQty ?? null);
    if (minQty !== null && quantityBaseValue < minQty) {
      throw new ClientOrdersError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Количество для товара ${formatProductLabel(product)} меньше минимального (${minQty})`
      );
    }

    const basePrice = toDecimal(basePriceValue)!;
    const lineDiscountPercent = item.discountPercent ?? null;
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
    totalAmount = totalAmount.add(lineAmount);

    preparedItems.push({
      create: {
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
        priceSource: receiptPrice ? 'product-prices:ЦенаПоступления' : 'manual',
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
        priceSource: receiptPrice ? 'product-prices:ЦенаПоступления' : 'manual',
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
  return prisma.organization.findMany({
    where: { isActive: true },
    orderBy: [{ name: 'asc' }],
    select: { guid: true, name: true, code: true, isActive: true },
  });
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
    deliveryDateMode: args.settings?.deliveryDateMode ?? ClientOrderDeliveryDateMode.NEXT_DAY,
    deliveryDateOffsetDays: args.settings?.deliveryDateOffsetDays ?? 1,
    fixedDeliveryDate: args.settings?.fixedDeliveryDate ?? null,
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
    where: { guid, source: OrderSource.MANAGER_APP },
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

export async function listClientOrders(query: ClientOrdersListQuery) {
  const search = normalizeSearch(query.search);
  const where: Prisma.OrderWhereInput = {
    source: OrderSource.MANAGER_APP,
    ...(query.status ? { status: query.status } : {}),
    ...(query.counterpartyGuid ? { counterparty: { guid: query.counterpartyGuid } } : {}),
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { number1c: { contains: search, mode: 'insensitive' } },
            { comment: { contains: search, mode: 'insensitive' } },
            { counterparty: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      skip: query.offset,
      take: query.limit,
      select: orderDetailSelect,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items: items.map(mapOrderDetail),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrderByGuid(guid: string) {
  const order = await fetchManagerOrderOrThrow(guid);
  const mapped = mapOrderDetail(order);
  const stockByProductId = await loadStockByProductIdForWarehouse(
    prisma as unknown as Tx,
    order.warehouse?.guid ?? null,
    order.items.map((item) => item.productId)
  );

  return {
    ...mapped,
    items: mapped.items.map((item, index) => ({
      ...item,
      stock: stockByProductId.get(order.items[index]?.productId) ?? null,
    })),
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
}

export async function updateClientOrderSettings(userId: number, body: ClientOrderSettingsUpdateBody) {
  const existing = await getRawClientOrderSettings(userId);

  let preferredOrganizationId = existing?.preferredOrganizationId ?? null;
  if (body.preferredOrganizationGuid !== undefined) {
    if (!body.preferredOrganizationGuid) {
      preferredOrganizationId = null;
    } else {
      preferredOrganizationId = (await loadOrganizationByGuid(prisma as unknown as Tx, body.preferredOrganizationGuid)).id;
    }
  }

  const deliveryDateMode = body.deliveryDateMode ?? existing?.deliveryDateMode ?? ClientOrderDeliveryDateMode.NEXT_DAY;
  const deliveryDateOffsetDays = body.deliveryDateOffsetDays ?? existing?.deliveryDateOffsetDays ?? 1;
  const fixedDeliveryDate =
    body.fixedDeliveryDate !== undefined ? body.fixedDeliveryDate ?? null : existing?.fixedDeliveryDate ?? null;

  ensureValidDeliveryDateSettings(deliveryDateMode, deliveryDateOffsetDays, fixedDeliveryDate);

  if (
    deliveryDateMode === ClientOrderDeliveryDateMode.FIXED_DATE &&
    fixedDeliveryDate &&
    startOfDay(fixedDeliveryDate).getTime() < startOfDay(now()).getTime()
  ) {
    throw new ClientOrdersError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Фиксированная дата отгрузки уже в прошлом. Укажите актуальную дату.'
    );
  }

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

export async function getClientOrderDefaults(userId: number, query: ClientOrderDefaultsQuery) {
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
            contract: { where: activeContractWhere(), select: { guid: true, number: true, isActive: true } },
            warehouse: { select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true } },
            priceType: { select: { guid: true, name: true } },
          },
        },
        defaultContract: {
          where: activeContractWhere(),
          select: { guid: true, number: true, date: true, validFrom: true, validTo: true, isActive: true },
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
            contract: { where: activeContractWhere(), select: { guid: true, number: true, isActive: true } },
            warehouse: { select: { guid: true, name: true, code: true, isDefault: true, isPickup: true, isActive: true } },
            priceType: { select: { guid: true, name: true } },
          },
        },
        contract: {
          where: activeContractWhere(),
          select: { guid: true, number: true, date: true, validFrom: true, validTo: true, isActive: true },
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
        contract: { where: activeContractWhere(), select: { guid: true, number: true, isActive: true } },
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
      select: { guid: true, number: true, date: true, validFrom: true, validTo: true, isActive: true },
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
    currency: DEFAULT_ORDER_CURRENCY,
    deliveryDate: deliveryDateResolution.resolvedDate,
    deliveryDateIssue: deliveryDateResolution.issue,
    deliveryDateIssueMessage: formatDeliveryDateIssue(deliveryDateResolution.issue),
    discountsEnabled: false,
  };
}

export async function getClientOrdersReferenceData(query: ClientOrdersReferenceDataQuery) {
  const commonWhere = buildReferenceWhere(query.includeInactive);
  const counterparty = query.counterpartyGuid
    ? await prisma.counterparty.findUnique({
        where: { guid: query.counterpartyGuid },
        select: { id: true, guid: true, name: true, isActive: true },
      })
    : null;

  if (query.counterpartyGuid && !counterparty) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Контрагент ${query.counterpartyGuid} не найден`);
  }
  if (counterparty?.isActive === false && !query.includeInactive) {
    throw new ClientOrdersError(400, ErrorCodes.VALIDATION_ERROR, `Контрагент ${query.counterpartyGuid} неактивен`);
  }

  const counterpartyId = counterparty?.id;

  const [counterparties, agreements, contracts, deliveryAddresses, warehouses] = await Promise.all([
    prisma.counterparty.findMany({
      where: commonWhere,
      orderBy: [{ name: 'asc' }],
      take: 100,
      select: {
        guid: true,
        name: true,
        fullName: true,
        inn: true,
        kpp: true,
        isActive: true,
      },
    }),
    counterpartyId
      ? prisma.clientAgreement.findMany({
          where: { ...commonWhere, counterpartyId, AND: [agreementNotClosedWhere()] },
          orderBy: [{ name: 'asc' }],
          take: 100,
          select: {
            guid: true,
            name: true,
            currency: true,
            isActive: true,
            contract: { select: { guid: true, number: true } },
            warehouse: { select: { guid: true, name: true } },
            priceType: { select: { guid: true, name: true } },
          },
        })
      : Promise.resolve([]),
    counterpartyId
      ? prisma.clientContract.findMany({
          where: { ...commonWhere, counterpartyId, AND: [contractNotClosedWhere()] },
          orderBy: [{ number: 'asc' }],
          take: 100,
          select: {
            guid: true,
            number: true,
            date: true,
            validFrom: true,
            validTo: true,
            isActive: true,
          },
        })
      : Promise.resolve([]),
    counterpartyId
      ? prisma.deliveryAddress.findMany({
          where: { ...commonWhere, counterpartyId },
          orderBy: [{ isDefault: 'desc' }, { fullAddress: 'asc' }],
          take: 100,
          select: {
            guid: true,
            name: true,
            fullAddress: true,
            isDefault: true,
            isActive: true,
          },
        })
      : Promise.resolve([]),
    prisma.warehouse.findMany({
      where: commonWhere,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      take: 100,
      select: {
        guid: true,
        name: true,
        code: true,
        isDefault: true,
        isPickup: true,
        isActive: true,
      },
    }),
  ]);

  return {
    counterparties,
    agreements,
    contracts,
    deliveryAddresses,
    warehouses,
  };
}

async function getCounterpartiesFallback(query: ClientOrdersCounterpartiesQuery, search: string): Promise<PagedResult<any>> {
  const where: Prisma.CounterpartyWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    OR: [
      { guid: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { fullName: { contains: search, mode: 'insensitive' } },
      { inn: { contains: search, mode: 'insensitive' } },
      { kpp: { contains: search, mode: 'insensitive' } },
    ],
  };
  const [items, total] = await prisma.$transaction([
    prisma.counterparty.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      take: Math.max(query.limit + query.offset, 150),
      select: { guid: true, name: true, fullName: true, inn: true, kpp: true, isActive: true },
    }),
    prisma.counterparty.count({ where }),
  ]);

  const lowered = search.toLowerCase();
  const ranked = items
    .map((item) => {
      const fields = [item.inn, item.kpp, item.guid, item.name, item.fullName].map((value) => (value ?? '').toLowerCase());
      let rank = 50;
      if (fields[0] === lowered) rank = 0;
      else if (fields[1] === lowered) rank = 1;
      else if (fields[2] === lowered) rank = 2;
      else if (fields[3] === lowered) rank = 3;
      else if (fields[4] === lowered) rank = 4;
      else if (fields[0].startsWith(lowered)) rank = 5;
      else if (fields[1].startsWith(lowered)) rank = 6;
      else if (fields[3].startsWith(lowered)) rank = 7;
      else if (fields[4].startsWith(lowered)) rank = 8;
      return { item, rank };
    })
    .sort((left, right) => left.rank - right.rank || left.item.name.localeCompare(right.item.name, 'ru'));

  return {
    items: ranked.slice(query.offset, query.offset + query.limit).map((entry) => entry.item),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getClientOrdersCounterparties(
  query: ClientOrdersCounterpartiesQuery
): Promise<PagedResult<{ guid: string; name: string; fullName: string | null; inn: string | null; kpp: string | null; isActive: boolean }>> {
  const search = normalizeSearch(query.search);
  if (!search) {
    const where: Prisma.CounterpartyWhereInput = query.includeInactive ? {} : { isActive: true };
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
    return { items, total, limit: query.limit, offset: query.offset };
  }

  const patterns = likeSearchPatterns(search);
  const activeFilter = query.includeInactive ? Prisma.empty : Prisma.sql`AND c."isActive" = TRUE`;
  try {
    const items = await prisma.$queryRaw<
      Array<{ guid: string; name: string; fullName: string | null; inn: string | null; kpp: string | null; isActive: boolean }>
    >(Prisma.sql`
      SELECT
        c.guid,
        c.name,
        c."fullName",
        c.inn,
        c.kpp,
        c."isActive"
      FROM "Counterparty" c
      WHERE 1 = 1
        ${activeFilter}
        AND (
          lower(coalesce(c.guid, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.name, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c."fullName", '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.inn, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.kpp, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR similarity(lower(unaccent(coalesce(c.name, ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
          OR similarity(lower(unaccent(coalesce(c."fullName", ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
        )
      ORDER BY
        CASE
          WHEN lower(coalesce(c.inn, '')) = ${patterns.exact} THEN 0
          WHEN lower(coalesce(c.kpp, '')) = ${patterns.exact} THEN 1
          WHEN lower(coalesce(c.guid, '')) = ${patterns.exact} THEN 2
          WHEN lower(unaccent(coalesce(c.name, ''))) = lower(unaccent(${search})) THEN 3
          WHEN lower(unaccent(coalesce(c."fullName", ''))) = lower(unaccent(${search})) THEN 4
          WHEN lower(coalesce(c.inn, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 5
          WHEN lower(coalesce(c.kpp, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 6
          WHEN lower(coalesce(c.name, '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 7
          WHEN lower(coalesce(c."fullName", '')) LIKE ${patterns.prefix} ESCAPE '\\' THEN 8
          ELSE 20
        END ASC,
        GREATEST(
          similarity(lower(unaccent(coalesce(c.name, ''))), lower(unaccent(${search}))),
          similarity(lower(unaccent(coalesce(c."fullName", ''))), lower(unaccent(${search})))
        ) DESC,
        c.name ASC
      LIMIT ${query.limit}
      OFFSET ${query.offset}
    `);

    const totalRows = await prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS total
      FROM "Counterparty" c
      WHERE 1 = 1
        ${activeFilter}
        AND (
          lower(coalesce(c.guid, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.name, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c."fullName", '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.inn, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR lower(coalesce(c.kpp, '')) LIKE ${patterns.contains} ESCAPE '\\'
          OR similarity(lower(unaccent(coalesce(c.name, ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
          OR similarity(lower(unaccent(coalesce(c."fullName", ''))), lower(unaccent(${search}))) >= ${SMART_SEARCH_TRIGRAM_THRESHOLD}
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
    return getCounterpartiesFallback(query, search);
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
  const counterpartyId = await resolveCounterpartyIdOrNull(query.counterpartyGuid);
  if (!counterpartyId) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }

  const search = normalizeSearch(query.search);
  const where: Prisma.ClientAgreementWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    AND: [agreementNotClosedWhere()],
    counterpartyId,
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { contract: { number: { contains: search, mode: 'insensitive' } } },
            { warehouse: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.clientAgreement.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: search ? 0 : query.offset,
      take: search ? Math.max(query.limit + query.offset, 150) : query.limit,
      select: {
        guid: true,
        name: true,
        currency: true,
        isActive: true,
        contract: { select: { guid: true, number: true } },
        warehouse: { select: { guid: true, name: true } },
        priceType: { select: { guid: true, name: true } },
      },
    }),
    prisma.clientAgreement.count({ where }),
  ]);

  const rankedItems = search
    ? rankReferenceItems(
        items,
        search,
        [(item) => item.guid, (item) => item.name, (item) => item.contract?.number, (item) => item.warehouse?.name],
        (item) => item.name
      ).slice(query.offset, query.offset + query.limit)
    : items;

  return { items: rankedItems, total, limit: query.limit, offset: query.offset };
}

export async function getClientOrdersContracts(query: ClientOrdersContractsQuery) {
  const counterpartyId = await resolveCounterpartyIdOrNull(query.counterpartyGuid);
  if (!counterpartyId) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }

  const search = normalizeSearch(query.search);
  const where: Prisma.ClientContractWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    AND: [contractNotClosedWhere()],
    counterpartyId,
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { number: { contains: search, mode: 'insensitive' } },
            { comment: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.clientContract.findMany({
      where,
      orderBy: [{ number: 'asc' }],
      skip: search ? 0 : query.offset,
      take: search ? Math.max(query.limit + query.offset, 150) : query.limit,
      select: {
        guid: true,
        number: true,
        date: true,
        validFrom: true,
        validTo: true,
        isActive: true,
      },
    }),
    prisma.clientContract.count({ where }),
  ]);

  const rankedItems = search
    ? rankReferenceItems(items, search, [(item) => item.guid, (item) => item.number], (item) => item.number).slice(
        query.offset,
        query.offset + query.limit
      )
    : items;

  return { items: rankedItems, total, limit: query.limit, offset: query.offset };
}

export async function getClientOrdersWarehouses(query: ClientOrdersWarehousesQuery) {
  const search = normalizeSearch(query.search);
  const where: Prisma.WarehouseWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { code: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.warehouse.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      skip: search ? 0 : query.offset,
      take: search ? Math.max(query.limit + query.offset, 150) : query.limit,
      select: {
        guid: true,
        name: true,
        code: true,
        isDefault: true,
        isPickup: true,
        isActive: true,
      },
    }),
    prisma.warehouse.count({ where }),
  ]);

  const rankedItems = search
    ? rankReferenceItems(items, search, [(item) => item.guid, (item) => item.code, (item) => item.name], (item) => item.name).slice(
        query.offset,
        query.offset + query.limit
      )
    : items;

  return { items: rankedItems, total, limit: query.limit, offset: query.offset };
}

export async function getClientOrdersPriceTypes(query: ClientOrdersPriceTypesQuery) {
  const search = normalizeSearch(query.search);
  const where: Prisma.PriceTypeWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { code: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.priceType.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      skip: search ? 0 : query.offset,
      take: search ? Math.max(query.limit + query.offset, 150) : query.limit,
      select: { guid: true, name: true, code: true, isActive: true },
    }),
    prisma.priceType.count({ where }),
  ]);

  const rankedItems = search
    ? rankReferenceItems(items, search, [(item) => item.guid, (item) => item.code, (item) => item.name], (item) => item.name).slice(
        query.offset,
        query.offset + query.limit
      )
    : items;

  return { items: rankedItems, total, limit: query.limit, offset: query.offset };
}

export async function getClientOrdersDeliveryAddresses(query: ClientOrdersDeliveryAddressesQuery) {
  const counterpartyId = await resolveCounterpartyIdOrNull(query.counterpartyGuid);
  if (!counterpartyId) {
    return { items: [], total: 0, limit: query.limit, offset: query.offset };
  }

  const search = normalizeSearch(query.search);
  const where: Prisma.DeliveryAddressWhereInput = {
    ...(query.includeInactive ? {} : { isActive: true }),
    counterpartyId,
    ...(search
      ? {
          OR: [
            { guid: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { fullAddress: { contains: search, mode: 'insensitive' } },
            { city: { contains: search, mode: 'insensitive' } },
            { street: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.deliveryAddress.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { fullAddress: 'asc' }],
      skip: search ? 0 : query.offset,
      take: search ? Math.max(query.limit + query.offset, 150) : query.limit,
      select: {
        guid: true,
        name: true,
        fullAddress: true,
        isDefault: true,
        isActive: true,
      },
    }),
    prisma.deliveryAddress.count({ where }),
  ]);

  const rankedItems = search
    ? rankReferenceItems(items, search, [(item) => item.guid, (item) => item.name, (item) => item.fullAddress], (item) => item.fullAddress).slice(
        query.offset,
        query.offset + query.limit
      )
    : items;

  return { items: rankedItems, total, limit: query.limit, offset: query.offset };
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
      take: Math.max(query.limit + query.offset, 200),
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

  const lowered = search.toLowerCase();
  const ranked = items
    .map((item) => {
      const code = (item.code ?? '').toLowerCase();
      const article = (item.article ?? '').toLowerCase();
      const sku = (item.sku ?? '').toLowerCase();
      const name = item.name.toLowerCase();
      let rank = 50;
      if (code === lowered) rank = 0;
      else if (article === lowered) rank = 1;
      else if (sku === lowered) rank = 2;
      else if (name === lowered) rank = 3;
      else if (code.startsWith(lowered)) rank = 4;
      else if (article.startsWith(lowered)) rank = 5;
      else if (sku.startsWith(lowered)) rank = 6;
      else if (name.startsWith(lowered)) rank = 7;
      return { item, rank };
    })
    .sort((left, right) => left.rank - right.rank || left.item.name.localeCompare(right.item.name, 'ru'));

  return {
    items: ranked.slice(query.offset, query.offset + query.limit).map((entry) => entry.item),
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

export async function getClientOrdersProducts(query: ClientOrdersProductsQuery) {
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
          packages: product.packages.map((pack) => ({
            ...pack,
            multiplier: decimalToNumber(pack.multiplier),
          })),
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
            packages: product.packages.map((pack) => ({
              ...pack,
              multiplier: decimalToNumber(pack.multiplier),
            })),
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
}

export async function createClientOrder(userId: number, body: ClientOrderCreateBody) {
  const sourceUpdatedAt = now();

  const created = await prisma.$transaction(async (tx) => {
    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
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
        createdByUserId: userId,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? null,
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
        saveReason: body.saveReason,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
        generalDiscountPercent: body.generalDiscountPercent ?? null,
        items: prepared.items.map((item) => item.snapshot),
      } as Prisma.InputJsonValue,
    });

    return order.guid!;
  });

  return getClientOrderByGuid(created);
}

export async function updateClientOrder(guid: string, userId: number, body: ClientOrderUpdateBody) {
  const sourceUpdatedAt = now();

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

    const context = await resolveManagerOrderContext(tx, body);
    const prepared = await prepareOrderItems(tx, body, context, sourceUpdatedAt);
    const nextRevision = order.revision + 1;
    const isAutosave = body.saveReason === 'autosave';

    await tx.orderItem.deleteMany({ where: { orderId: order.id } });

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        syncState:
          order.status === OrderStatus.SENT_TO_1C || order.status === OrderStatus.QUEUED
            ? OrderSyncState.QUEUED
            : OrderSyncState.DRAFT,
        organizationId: context.organization.id,
        counterpartyId: context.counterparty.id,
        agreementId: context.agreement?.id ?? null,
        contractId: context.contract?.id ?? context.agreement?.contractId ?? null,
        warehouseId: context.warehouse?.id ?? context.agreement?.warehouseId ?? null,
        deliveryAddressId: context.deliveryAddress?.id ?? null,
        comment: body.comment ?? null,
        deliveryDate: body.deliveryDate ?? null,
        currency: DEFAULT_ORDER_CURRENCY,
        totalAmount: prepared.totalAmount,
        generalDiscountPercent:
          body.generalDiscountPercent !== null && body.generalDiscountPercent !== undefined
            ? toDecimal(body.generalDiscountPercent)
            : null,
        generalDiscountAmount: prepared.generalDiscountAmount,
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
          saveReason: body.saveReason,
          comment: body.comment ?? null,
          deliveryDate: body.deliveryDate?.toISOString?.() ?? null,
          generalDiscountPercent: body.generalDiscountPercent ?? null,
          items: prepared.items.map((item) => item.snapshot),
        } as Prisma.InputJsonValue,
      });
    }
  });

  return getClientOrderByGuid(guid);
}

export async function submitClientOrder(guid: string, userId: number, body: ClientOrderSubmitBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
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

    const nextRevision = order.revision + 1;
    const queuedAt = now();

    await tx.order.update({
      where: { id: order.id },
      data: {
        revision: nextRevision,
        status: OrderStatus.QUEUED,
        syncState: OrderSyncState.QUEUED,
        queuedAt,
        cancelRequestedAt: null,
        cancelReason: null,
        last1cError: null,
        sourceUpdatedAt: queuedAt,
      },
    });

    await appendOrderEvent(tx, {
      orderId: order.id,
      revision: nextRevision,
      source: OrderEventSource.APP_MANAGER,
      eventType: 'CLIENT_ORDER_SUBMITTED',
      actorUserId: userId,
      payload: { queuedAt: queuedAt.toISOString() },
    });

    await saveUserCounterpartyDefaults(tx, userId, guid);
  });

  return getClientOrderByGuid(guid);
}

export async function deleteDraftClientOrder(guid: string) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    if (order.status !== OrderStatus.DRAFT || order.isPostedIn1c) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, 'Можно удалить только черновик заказа клиента');
    }

    await tx.orderItem.deleteMany({ where: { orderId: order.id } });
    await tx.order.delete({ where: { id: order.id } });
  });

  return { deleted: true, guid };
}

export async function cancelClientOrder(guid: string, userId: number, body: ClientOrderCancelBody) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { guid, source: OrderSource.MANAGER_APP },
      select: {
        id: true,
        guid: true,
        revision: true,
        status: true,
        source: true,
        isPostedIn1c: true,
      },
    });

    if (!order) {
      throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
    }

    ensureEditable(order);
    assertRevision(order.revision, body.revision);

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

  return getClientOrderByGuid(guid);
}

export { ClientOrdersError };
