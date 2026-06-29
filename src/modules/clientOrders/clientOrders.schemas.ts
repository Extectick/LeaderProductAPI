import { ClientOrderDeliveryDateMode, OrderStatus, OrderSyncState } from '@prisma/client';
import { z } from 'zod';

const parseBooleanFromQuery = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return undefined;
};

const booleanFromQuery = z
  .preprocess((value) => parseBooleanFromQuery(value), z.boolean().optional())
  .default(false);

const optionalBooleanFromQuery = z.preprocess(
  (value) => parseBooleanFromQuery(value),
  z.boolean().optional()
);

const nullableGuid = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().trim().min(1).nullable().optional()
);

const nullableDate = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.date().optional()
);

const parseDateFromQuery = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  const raw = String(value).trim();
  const dotted = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const normalized = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const queryDate = z.preprocess(parseDateFromQuery, z.date().optional());

const nullableNumber = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().nullable().optional()
);

const queryNumber = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : String(value).replace(/\s/g, '').replace(',', '.')),
  z.coerce.number().optional()
);

const queryInteger = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.number().int().min(0).optional()
);

const saveReasonSchema = z.enum(['manual', 'autosave']).optional().default('manual');

const pagedSearchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().min(1).optional(),
  includeInactive: booleanFromQuery,
});

const clientOrderStatusSchema = z.enum([
  OrderStatus.DRAFT,
  OrderStatus.QUEUED,
  OrderStatus.SENT_TO_1C,
  OrderStatus.CONFIRMED,
  OrderStatus.PARTIAL,
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
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
]);

export const clientOrdersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: clientOrderStatusSchema.optional(),
  syncState: z.nativeEnum(OrderSyncState).optional(),
  search: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
  organizationGuid: z.string().trim().min(1).optional(),
  warehouseGuid: z.string().trim().min(1).optional(),
  priceTypeGuid: z.string().trim().min(1).optional(),
  amountMin: queryNumber,
  amountMax: queryNumber,
  deliveryDateFrom: queryDate,
  deliveryDateTo: queryDate,
  updatedFrom: queryDate,
  updatedTo: queryDate,
  itemsMin: queryInteger,
  itemsMax: queryInteger,
  hasNumber1c: z.enum(['yes', 'no']).optional(),
  onlyProblems: booleanFromQuery,
});

export const orderGuidParamsSchema = z.object({
  guid: z.string().min(1),
});

export const clientOrderReferenceDetailsParamsSchema = z.object({
  kind: z.enum(['organization', 'counterparty', 'agreement', 'contract', 'warehouse', 'delivery-address', 'price-type']),
  guid: z.string().trim().min(1),
});

export const clientOrdersReferenceDataQuerySchema = z.object({
  organizationGuid: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
  includeInactive: booleanFromQuery,
});

export const clientOrdersCounterpartiesQuerySchema = pagedSearchQuerySchema;

export const clientOrdersAgreementsQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
  organizationGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersContractsQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
  organizationGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersWarehousesQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
  organizationGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersPriceTypesQuerySchema = pagedSearchQuerySchema;

export const clientOrdersDeliveryAddressesQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
  organizationGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersProductsQuerySchema = pagedSearchQuerySchema.extend({
  organizationGuid: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
  agreementGuid: z.string().trim().min(1).optional(),
  warehouseGuid: z.string().trim().min(1).optional(),
  priceTypeGuid: z.string().trim().min(1).optional(),
  inStockOnly: optionalBooleanFromQuery,
});

export const clientOrdersBatchProductsSchema = z.object({
  productGuids: z.array(z.string().trim().min(1)).min(1).max(200),
  organizationGuid: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
  agreementGuid: z.string().trim().min(1).optional(),
  warehouseGuid: z.string().trim().min(1).optional(),
  priceTypeGuid: z.string().trim().min(1).optional(),
});

export const clientOrderProductImagesSyncSchema = z.object({
  productGuid: z.string().trim().min(1).optional(),
  changedSince: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeDeleted: optionalBooleanFromQuery,
});

export const clientOrderProductImagesCleanupSchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(365).optional().default(14),
});

export const clientOrderDefaultsQuerySchema = z.object({
  organizationGuid: z.string().trim().min(1),
  counterpartyGuid: z.string().trim().min(1),
});

export const clientOrderSettingsUpdateSchema = z.object({
  preferredOrganizationGuid: nullableGuid,
  deliveryDateMode: z.nativeEnum(ClientOrderDeliveryDateMode).optional(),
  deliveryDateOffsetDays: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    z.coerce.number().int().min(0).max(365).optional()
  ),
  fixedDeliveryDate: nullableDate,
});

export const managerOrderItemSchema = z.object({
  productGuid: z.string().min(1),
  packageGuid: z.string().min(1).optional(),
  priceTypeGuid: nullableGuid,
  quantity: z.coerce.number().nonnegative(),
  manualPrice: nullableNumber.refine((value) => value === null || value === undefined || value >= 0, {
    message: 'manualPrice must be greater than or equal to 0',
  }),
  discountPercent: nullableNumber.refine(
    (value) => value === null || value === undefined || (value >= 0 && value <= 100),
    { message: 'discountPercent must be between 0 and 100' }
  ),
  comment: z.string().trim().min(1).optional(),
});

export const clientOrderCreateSchema = z.object({
  organizationGuid: z.string().min(1),
  counterpartyGuid: z.string().min(1),
  agreementGuid: nullableGuid,
  contractGuid: nullableGuid,
  warehouseGuid: nullableGuid,
  deliveryAddressGuid: nullableGuid,
  deliveryDate: nullableDate,
  comment: z.string().trim().max(2000).optional(),
  currency: z.string().trim().min(1).max(16).optional(),
  saveReason: saveReasonSchema,
  generalDiscountPercent: nullableNumber.refine(
    (value) => value === null || value === undefined || (value >= 0 && value <= 100),
    { message: 'generalDiscountPercent must be between 0 and 100' }
  ),
  items: z.array(managerOrderItemSchema).min(1),
});

export const clientOrderUpdateSchema = clientOrderCreateSchema.extend({
  revision: z.coerce.number().int().min(1),
});

export const clientOrderSubmitSchema = z.object({
  revision: z.coerce.number().int().min(1),
});

export const clientOrderUnqueueSchema = z.object({
  revision: z.coerce.number().int().min(1),
});

export const clientOrderRestoreSchema = z.object({
  revision: z.coerce.number().int().min(1),
});

export const clientOrderCopySchema = z.object({
  revision: z.coerce.number().int().min(1).optional(),
});

export const clientOrderCancelSchema = z.object({
  revision: z.coerce.number().int().min(1),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export type ClientOrdersListQuery = z.infer<typeof clientOrdersListQuerySchema>;
export type ClientOrderReferenceDetailsParams = z.infer<typeof clientOrderReferenceDetailsParamsSchema>;
export type ClientOrdersReferenceDataQuery = z.infer<typeof clientOrdersReferenceDataQuerySchema>;
export type ClientOrdersCounterpartiesQuery = z.infer<typeof clientOrdersCounterpartiesQuerySchema>;
export type ClientOrdersAgreementsQuery = z.infer<typeof clientOrdersAgreementsQuerySchema>;
export type ClientOrdersContractsQuery = z.infer<typeof clientOrdersContractsQuerySchema>;
export type ClientOrdersWarehousesQuery = z.infer<typeof clientOrdersWarehousesQuerySchema>;
export type ClientOrdersPriceTypesQuery = z.infer<typeof clientOrdersPriceTypesQuerySchema>;
export type ClientOrdersDeliveryAddressesQuery = z.infer<typeof clientOrdersDeliveryAddressesQuerySchema>;
export type ClientOrdersProductsQuery = z.infer<typeof clientOrdersProductsQuerySchema>;
export type ClientOrdersBatchProductsBody = z.infer<typeof clientOrdersBatchProductsSchema>;
export type ClientOrderDefaultsQuery = z.infer<typeof clientOrderDefaultsQuerySchema>;
export type ClientOrderSettingsUpdateBody = z.infer<typeof clientOrderSettingsUpdateSchema>;
export type ClientOrderCreateBody = z.infer<typeof clientOrderCreateSchema>;
export type ClientOrderUpdateBody = z.infer<typeof clientOrderUpdateSchema>;
export type ClientOrderSubmitBody = z.infer<typeof clientOrderSubmitSchema>;
export type ClientOrderUnqueueBody = z.infer<typeof clientOrderUnqueueSchema>;
export type ClientOrderRestoreBody = z.infer<typeof clientOrderRestoreSchema>;
export type ClientOrderCopyBody = z.infer<typeof clientOrderCopySchema>;
export type ClientOrderCancelBody = z.infer<typeof clientOrderCancelSchema>;
