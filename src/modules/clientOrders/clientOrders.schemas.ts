import { ClientOrderDeliveryDateMode, OrderStatus } from '@prisma/client';
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

const nullableGuid = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().trim().min(1).nullable().optional()
);

const nullableDate = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.date().optional()
);

const nullableNumber = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().nullable().optional()
);

const saveReasonSchema = z.enum(['manual', 'autosave']).optional().default('manual');

const pagedSearchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().min(1).optional(),
  includeInactive: booleanFromQuery,
});

export const clientOrdersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.nativeEnum(OrderStatus).optional(),
  search: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
});

export const orderGuidParamsSchema = z.object({
  guid: z.string().min(1),
});

export const clientOrderReferenceDetailsParamsSchema = z.object({
  kind: z.enum(['organization', 'counterparty', 'agreement', 'contract', 'warehouse', 'delivery-address', 'price-type']),
  guid: z.string().trim().min(1),
});

export const clientOrdersReferenceDataQuerySchema = z.object({
  counterpartyGuid: z.string().trim().min(1).optional(),
  includeInactive: booleanFromQuery,
});

export const clientOrdersCounterpartiesQuerySchema = pagedSearchQuerySchema;

export const clientOrdersAgreementsQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersContractsQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersWarehousesQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersPriceTypesQuerySchema = pagedSearchQuerySchema;

export const clientOrdersDeliveryAddressesQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
});

export const clientOrdersProductsQuerySchema = pagedSearchQuerySchema.extend({
  counterpartyGuid: z.string().trim().min(1).optional(),
  agreementGuid: z.string().trim().min(1).optional(),
  warehouseGuid: z.string().trim().min(1).optional(),
  priceTypeGuid: z.string().trim().min(1).optional(),
  inStockOnly: z.coerce.boolean().optional(),
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
  quantity: z.coerce.number().positive(),
  manualPrice: nullableNumber.refine((value) => value === null || value === undefined || value > 0, {
    message: 'manualPrice must be greater than 0',
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
export type ClientOrderDefaultsQuery = z.infer<typeof clientOrderDefaultsQuerySchema>;
export type ClientOrderSettingsUpdateBody = z.infer<typeof clientOrderSettingsUpdateSchema>;
export type ClientOrderCreateBody = z.infer<typeof clientOrderCreateSchema>;
export type ClientOrderUpdateBody = z.infer<typeof clientOrderUpdateSchema>;
export type ClientOrderSubmitBody = z.infer<typeof clientOrderSubmitSchema>;
export type ClientOrderCancelBody = z.infer<typeof clientOrderCancelSchema>;
