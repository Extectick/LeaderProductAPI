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
  (value) => (value === '' ? undefined : value),
  z.string().min(1).nullable().optional()
);

const dateFromQuery = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce.date().optional()
);

export const listProductsQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  groupGuid: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeInactive: booleanFromQuery,
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productGuidParamsSchema = z.object({
  guid: z.string().min(1),
});

export const orderGuidParamsSchema = z.object({
  guid: z.string().min(1),
});

export const stockQuerySchema = z.object({
  warehouseGuid: z.string().min(1).optional(),
  includeInactiveWarehouses: booleanFromQuery,
});

export type StockQuery = z.infer<typeof stockQuerySchema>;

export const resolvePriceQuerySchema = z.object({
  productGuid: z.string().min(1),
  counterpartyGuid: z.string().min(1).optional(),
  agreementGuid: z.string().min(1).optional(),
  priceTypeGuid: z.string().min(1).optional(),
  at: dateFromQuery,
});

export type ResolvePriceQuery = z.infer<typeof resolvePriceQuerySchema>;

export const includeInactiveQuerySchema = z.object({
  includeInactive: booleanFromQuery,
});

export type IncludeInactiveQuery = z.infer<typeof includeInactiveQuerySchema>;

export const meContextUpdateSchema = z.object({
  counterpartyGuid: nullableGuid,
  activeAgreementGuid: nullableGuid,
  activeContractGuid: nullableGuid,
  activeWarehouseGuid: nullableGuid,
  activePriceTypeGuid: nullableGuid,
  activeDeliveryAddressGuid: nullableGuid,
});

export type MeContextUpdateBody = z.infer<typeof meContextUpdateSchema>;

const orderItemSchema = z.object({
  productGuid: z.string().min(1),
  packageGuid: z.string().min(1).optional(),
  unitGuid: z.string().min(1).optional(),
  quantity: z.coerce.number().positive(),
});

export const orderCreateSchema = z.object({
  agreementGuid: nullableGuid,
  contractGuid: nullableGuid,
  warehouseGuid: nullableGuid,
  deliveryAddressGuid: nullableGuid,
  priceTypeGuid: nullableGuid,
  deliveryDate: dateFromQuery,
  comment: z.string().trim().min(1).optional(),
  currency: z.string().trim().min(1).optional(),
  items: z.array(orderItemSchema).min(1),
});

export type OrderCreateBody = z.infer<typeof orderCreateSchema>;

export const ordersListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.nativeEnum(OrderStatus).optional(),
});

export type OrdersListQuery = z.infer<typeof ordersListQuerySchema>;
