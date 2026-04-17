import { OrderStatus, OrderSyncState } from '@prisma/client';
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
  inStock: z.number().optional(),
  shipping: z.number().optional(),
  clientReserved: z.number().optional(),
  managerReserved: z.number().optional(),
  available: z.number().optional(),
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
  dataVersion: z.string().nullable().optional(),
  isSeparateSubdivision: z.boolean().nullable().optional(),
  legalEntityType: z.string().nullable().optional(),
  legalOrIndividualType: z.string().nullable().optional(),
  registrationCountryGuid: z.string().nullable().optional(),
  headCounterpartyGuid: z.string().nullable().optional(),
  additionalInfo: z.string().nullable().optional(),
  partnerGuid: z.string().nullable().optional(),
  vatByRates4And2: z.boolean().nullable().optional(),
  okpoCode: z.string().nullable().optional(),
  registrationNumber: z.string().nullable().optional(),
  taxNumber: z.string().nullable().optional(),
  internationalName: z.string().nullable().optional(),
  isPredefined: z.boolean().nullable().optional(),
  predefinedDataName: z.string().nullable().optional(),
  defaultAgreementGuid: z.string().optional(),
  defaultContractGuid: z.string().optional(),
  defaultWarehouseGuid: z.string().optional(),
  defaultDeliveryAddressGuid: z.string().optional(),
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
  organizationGuid: z.string().nullable().optional(),
  dataVersion: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  printName: z.string().nullable().optional(),
  number: z.string().min(1),
  date: z.coerce.date(),
  validFrom: nullableDate,
  validTo: nullableDate,
  partnerGuid: z.string().nullable().optional(),
  bankAccountGuid: z.string().nullable().optional(),
  counterpartyBankAccountGuid: z.string().nullable().optional(),
  contactPersonGuid: z.string().nullable().optional(),
  departmentGuid: z.string().nullable().optional(),
  managerGuid: z.string().nullable().optional(),
  cashFlowItemGuid: z.string().nullable().optional(),
  businessOperation: z.string().nullable().optional(),
  financialAccountingGroupGuid: z.string().nullable().optional(),
  activityDirectionGuid: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  currencyGuid: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  contractType: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  isAgreed: z.boolean().nullable().optional(),
  hasPaymentTerm: z.boolean().nullable().optional(),
  paymentTermDays: z.number().int().nullable().optional(),
  settlementProcedure: z.string().nullable().optional(),
  limitDebtAmount: z.boolean().nullable().optional(),
  amount: z.number().nullable().optional(),
  allowedDebtAmount: z.number().nullable().optional(),
  forbidOverdueDebt: z.boolean().nullable().optional(),
  vatTaxation: z.string().nullable().optional(),
  vatRate: z.string().nullable().optional(),
  vatDefinedInDocument: z.boolean().nullable().optional(),
  deliveryMethod: z.string().nullable().optional(),
  carrierPartnerGuid: z.string().nullable().optional(),
  deliveryZoneGuid: z.string().nullable().optional(),
  deliveryTimeFrom: z.string().nullable().optional(),
  deliveryTimeTo: z.string().nullable().optional(),
  deliveryAddress: z.string().nullable().optional(),
  deliveryAddressFields: z.string().nullable().optional(),
  additionalDeliveryInfo: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  sourceUpdatedAt: nullableDate,
});
export type ContractItem = z.infer<typeof contractSchema>;

export const contractsBatchSchema = z.object({
  ...envelope,
  items: z.array(contractSchema).min(1),
});

const agreementSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  number: z.string().nullable().optional(),
  date: nullableDate,
  counterpartyGuid: z.string().optional(),
  organizationGuid: z.string().nullable().optional(),
  contractGuid: z.string().optional(),
  priceTypeGuid: z.string().optional(),
  warehouseGuid: z.string().optional(),
  currency: z.string().nullable().optional(),
  dataVersion: z.string().nullable().optional(),
  partnerGuid: z.string().nullable().optional(),
  partnerSegmentGuid: z.string().nullable().optional(),
  paymentScheduleGuid: z.string().nullable().optional(),
  documentAmount: z.number().nullable().optional(),
  isTemplate: z.boolean().nullable().optional(),
  deliveryTerm: z.string().nullable().optional(),
  priceIncludesVat: z.boolean().nullable().optional(),
  usedBySalesRepresentatives: z.boolean().nullable().optional(),
  parentAgreementGuid: z.string().nullable().optional(),
  nomenclatureSegmentGuid: z.string().nullable().optional(),
  validFrom: nullableDate,
  validTo: nullableDate,
  comment: z.string().nullable().optional(),
  isRegular: z.boolean().nullable().optional(),
  period: z.string().nullable().optional(),
  periodCount: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  isAgreed: z.boolean().nullable().optional(),
  managerGuid: z.string().nullable().optional(),
  businessOperation: z.string().nullable().optional(),
  manualDiscountPercent: z.number().nullable().optional(),
  manualMarkupPercent: z.number().nullable().optional(),
  availableForExternalUsers: z.boolean().nullable().optional(),
  usesCounterpartyContracts: z.boolean().nullable().optional(),
  limitManualDiscounts: z.boolean().nullable().optional(),
  paymentForm: z.string().nullable().optional(),
  contactPersonGuid: z.string().nullable().optional(),
  settlementProcedure: z.string().nullable().optional(),
  priceCalculationVariant: z.string().nullable().optional(),
  minOrderAmount: z.number().nullable().optional(),
  orderFrequency: z.string().nullable().optional(),
  individualPriceTypeGuid: z.string().nullable().optional(),
  settlementCurrency: z.string().nullable().optional(),
  paymentInCurrency: z.boolean().nullable().optional(),
  financialAccountingGroupGuid: z.string().nullable().optional(),
  cashFlowItemGuid: z.string().nullable().optional(),
  activityDirectionGuid: z.string().nullable().optional(),
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
  characteristicGuid: z.string().optional(),
  priceTypeGuid: z.string().optional(),
  priceType: priceTypeSchema.optional(),
  price: z.number(),
  packageGuid: z.string().optional(),
  packageName: z.string().optional(),
  currency: z.string().optional(),
  currencyGuid: z.string().optional(),
  registrarGuid: z.string().optional(),
  registrarPresentation: z.string().optional(),
  formula: z.string().nullable().optional(),
  marketingCampaignGuid: z.string().optional(),
  marketingCampaignName: z.string().optional(),
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

const snapshotOrganizationSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1),
  code: z.string().optional(),
});

const snapshotUnitSchema = z.object({
  guid: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  symbol: z.string().optional(),
});

const snapshotPackageSchema = z.object({
  guid: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  multiplier: z.number().optional(),
});

const snapshotProductSchema = z.object({
  guid: z.string().min(1),
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  article: z.string().optional(),
  sku: z.string().optional(),
});

const orderSnapshotItemLineSchema = z.object({
  product: snapshotProductSchema,
  package: snapshotPackageSchema.nullable().optional(),
  unit: snapshotUnitSchema.nullable().optional(),
  priceType: priceTypeSchema.nullable().optional(),
  quantity: z.number().positive(),
  quantityBase: z.number().positive().optional(),
  basePrice: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  isManualPrice: z.boolean().optional(),
  manualPrice: z.number().nullable().optional(),
  priceSource: z.string().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  appliedDiscountPercent: z.number().min(0).max(100).nullable().optional(),
  lineAmount: z.number().nullable().optional(),
  comment: z.string().nullable().optional(),
});

const orderSnapshotItemSchema = z.object({
  guid: z.string().min(1),
  baseRevision: z.number().int().min(1),
  revision: z.number().int().min(1).optional(),
  status: z.nativeEnum(OrderStatus),
  syncState: z.nativeEnum(OrderSyncState).optional(),
  number1c: z.string().optional(),
  date1c: nullableDate,
  isPostedIn1c: z.boolean().optional(),
  postedAt1c: nullableDate,
  organization: snapshotOrganizationSchema.optional(),
  comment: z.string().nullable().optional(),
  deliveryDate: nullableDate,
  currency: z.string().optional(),
  totalAmount: z.number().nullable().optional(),
  generalDiscountPercent: z.number().min(0).max(100).nullable().optional(),
  generalDiscountAmount: z.number().nullable().optional(),
  cancelReason: z.string().nullable().optional(),
  last1cError: z.string().nullable().optional(),
  sourceUpdatedAt: nullableDate,
  items: z.array(orderSnapshotItemLineSchema).min(1),
});

export const ordersSnapshotBatchSchema = z.object({
  ...envelope,
  items: z.array(orderSnapshotItemSchema).min(1),
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
export type OrdersSnapshotBatch = z.infer<typeof ordersSnapshotBatchSchema>;
export type OrderAckBody = z.infer<typeof orderAckSchema>;
export type SessionStartBody = z.infer<typeof sessionStartSchema>;
export type SessionCompleteBody = z.infer<typeof sessionCompleteSchema>;
