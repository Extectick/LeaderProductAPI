import { OrderStatus } from '@prisma/client';
import { z } from 'zod';

const envelope = {
  secret: z.string().min(1, 'secret is required'),
  sessionId: z.string().min(1).optional(),
};

const nullableDate = z.preprocess(
  (value) => (value === null || value === undefined || value === '' ? undefined : value),
  z.coerce.date().optional()
);

const unitSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  symbol: z.string().optional(),
  sourceUpdatedAt: nullableDate,
});

const packageSchema = z.object({
  guid: z.string().optional(),
  name: z.string().min(1),
  unit: unitSchema,
  multiplier: z.number(),
  barcode: z.string().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  sourceUpdatedAt: nullableDate,
});

const nomenclatureItemSchema = z.object({
  guid: z.string().min(1),
  isGroup: z.boolean(),
  parentGuid: z.string().nullable().optional(),
  name: z.string().min(1),
  code: z.string().optional(),
  isActive: z.boolean().optional(),
  article: z.string().optional(),
  sku: z.string().optional(),
  isWeight: z.boolean().optional(),
  isService: z.boolean().optional(),
  baseUnit: unitSchema.optional(),
  packages: z.array(packageSchema).optional(),
  sourceUpdatedAt: nullableDate,
});
export type NomenclatureItem = z.infer<typeof nomenclatureItemSchema>;

export const nomenclatureBatchSchema = z.object({
  ...envelope,
  items: z.array(nomenclatureItemSchema).min(1),
});

const stockItemSchema = z.object({
  productGuid: z.string().min(1),
  warehouseGuid: z.string().min(1),
  organizationGuid: z.string().min(1),
  quantity: z.number(),
  reserved: z.number().optional(),
  updatedAt: nullableDate,
  seriesGuid: z.string().optional(),
  seriesNumber: z.string().optional(),
  seriesProductionDate: nullableDate,
  seriesExpiresAt: nullableDate,
});
export type StockItem = z.infer<typeof stockItemSchema>;

export const stockBatchSchema = z.object({
  ...envelope,
  items: z.array(stockItemSchema).min(1),
});

const addressSchema = z.object({
  guid: z.string().optional(),
  name: z.string().optional(),
  fullAddress: z.string().min(1),
  city: z.string().nullable().optional(),
  street: z.string().nullable().optional(),
  house: z.string().nullable().optional(),
  building: z.string().nullable().optional(),
  apartment: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});

const counterpartySchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().nullable().optional(),
  inn: z.string().nullable().optional(),
  kpp: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  addresses: z.array(addressSchema).optional(),
  sourceUpdatedAt: nullableDate,
});
export type CounterpartyItem = z.infer<typeof counterpartySchema>;

export const counterpartiesBatchSchema = z.object({
  ...envelope,
  items: z.array(counterpartySchema).min(1),
});

const warehouseSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  isPickup: z.boolean().optional(),
  address: z.string().nullable().optional(),
  sourceUpdatedAt: nullableDate,
});
export type WarehouseItem = z.infer<typeof warehouseSchema>;

export const warehousesBatchSchema = z.object({
  ...envelope,
  items: z.array(warehouseSchema).min(1),
});

const organizationSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});
export type OrganizationItem = z.infer<typeof organizationSchema>;

export const organizationsBatchSchema = z.object({
  ...envelope,
  items: z.array(organizationSchema).min(1),
});

const priceTypeSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});

const contractSchema = z.object({
  guid: z.string().min(1),
  counterpartyGuid: z.string().min(1),
  number: z.string().min(1),
  date: z.coerce.date(),
  validFrom: nullableDate,
  validTo: nullableDate,
  isActive: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  sourceUpdatedAt: nullableDate,
});

const agreementSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  counterpartyGuid: z.string().optional(),
  contractGuid: z.string().optional(),
  priceTypeGuid: z.string().optional(),
  warehouseGuid: z.string().optional(),
  currency: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});

const agreementItemSchema = z.object({
  priceType: priceTypeSchema.optional(),
  contract: contractSchema.optional(),
  agreement: agreementSchema,
});
export type AgreementItem = z.infer<typeof agreementItemSchema>;

export const agreementsBatchSchema = z.object({
  ...envelope,
  items: z.array(agreementItemSchema).min(1),
});

const specialPriceItemSchema = z.object({
  guid: z.string().optional(),
  productGuid: z.string().min(1),
  counterpartyGuid: z.string().optional(),
  agreementGuid: z.string().optional(),
  priceTypeGuid: z.string().optional(),
  price: z.number(),
  currency: z.string().optional(),
  startDate: nullableDate,
  endDate: nullableDate,
  minQty: z.number().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});
export type SpecialPriceItem = z.infer<typeof specialPriceItemSchema>;

export const specialPricesBatchSchema = z.object({
  ...envelope,
  items: z.array(specialPriceItemSchema).min(1),
});

const productPriceItemSchema = z.object({
  guid: z.string().optional(),
  productGuid: z.string().min(1),
  priceTypeGuid: z.string().optional(),
  price: z.number(),
  currency: z.string().optional(),
  startDate: nullableDate,
  endDate: nullableDate,
  minQty: z.number().optional(),
  isActive: z.boolean().optional(),
  sourceUpdatedAt: nullableDate,
});
export type ProductPriceItem = z.infer<typeof productPriceItemSchema>;

export const productPricesBatchSchema = z.object({
  ...envelope,
  items: z.array(productPriceItemSchema).min(1),
});

const orderStatusItemSchema = z.object({
  guid: z.string().min(1),
  status: z.nativeEnum(OrderStatus),
  number1c: z.string().optional(),
  date1c: nullableDate,
  comment: z.string().nullable().optional(),
  totalAmount: z.number().optional(),
  currency: z.string().optional(),
  sourceUpdatedAt: nullableDate,
});

export const ordersStatusBatchSchema = z.object({
  ...envelope,
  items: z.array(orderStatusItemSchema).min(1),
});

const orderAckStatusSchema = z.literal(OrderStatus.SENT_TO_1C);

export const orderAckSchema = z.object({
  ...envelope,
  status: orderAckStatusSchema.optional(),
  number1c: z.string().optional(),
  date1c: nullableDate,
  sentTo1cAt: nullableDate,
  sourceUpdatedAt: nullableDate,
  error: z.string().optional(),
});

export const sessionStartSchema = z.object({
  secret: z.string().min(1, 'secret is required'),
  selectedEntities: z.array(z.string().min(1)).optional(),
  replaceMode: z.boolean().optional(),
});

export const sessionCompleteSchema = z.object({
  secret: z.string().min(1, 'secret is required'),
  sessionId: z.string().min(1),
});

export type OrdersStatusBatch = z.infer<typeof ordersStatusBatchSchema>;
export type OrderAckBody = z.infer<typeof orderAckSchema>;
export type SessionStartBody = z.infer<typeof sessionStartSchema>;
export type SessionCompleteBody = z.infer<typeof sessionCompleteSchema>;
