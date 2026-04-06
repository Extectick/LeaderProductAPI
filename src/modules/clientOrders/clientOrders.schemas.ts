import { OrderStatus } from '@prisma/client';
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
  z.string().min(1).nullable().optional()
);

const nullableDate = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.date().optional()
);

const nullableNumber = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().nullable().optional()
);

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

export const clientOrdersReferenceDataQuerySchema = z.object({
  counterpartyGuid: z.string().trim().min(1).optional(),
  includeInactive: booleanFromQuery,
});

export const clientOrdersProductsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  counterpartyGuid: z.string().trim().min(1).optional(),
  agreementGuid: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

export const managerOrderItemSchema = z.object({
  productGuid: z.string().min(1),
  packageGuid: z.string().min(1).optional(),
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
  counterpartyGuid: z.string().min(1),
  agreementGuid: nullableGuid,
  contractGuid: nullableGuid,
  warehouseGuid: nullableGuid,
  deliveryAddressGuid: nullableGuid,
  deliveryDate: nullableDate,
  comment: z.string().trim().max(2000).optional(),
  currency: z.string().trim().min(1).max(16).optional(),
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
export type ClientOrdersReferenceDataQuery = z.infer<typeof clientOrdersReferenceDataQuerySchema>;
export type ClientOrdersProductsQuery = z.infer<typeof clientOrdersProductsQuerySchema>;
export type ClientOrderCreateBody = z.infer<typeof clientOrderCreateSchema>;
export type ClientOrderUpdateBody = z.infer<typeof clientOrderUpdateSchema>;
export type ClientOrderSubmitBody = z.infer<typeof clientOrderSubmitSchema>;
export type ClientOrderCancelBody = z.infer<typeof clientOrderCancelSchema>;
