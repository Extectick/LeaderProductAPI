import { Prisma } from '@prisma/client';

export const queuedOrderSelect = {
  id: true,
  guid: true,
  source: true,
  revision: true,
  syncState: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  queuedAt: true,
  sentTo1cAt: true,
  deliveryDate: true,
  comment: true,
  currency: true,
  totalAmount: true,
  generalDiscountPercent: true,
  generalDiscountAmount: true,
  exportAttempts: true,
  lastExportError: true,
  isPostedIn1c: true,
  postedAt1c: true,
  hasRealization: true,
  realizationDetectedAt: true,
  cancelRequestedAt: true,
  cancelReason: true,
  last1cError: true,
  sourceUpdatedAt: true,
  counterparty: {
    select: { guid: true, name: true, inn: true, kpp: true, isActive: true },
  },
  agreement: {
    select: { guid: true, name: true, isActive: true },
  },
  contract: {
    select: { guid: true, number: true, date: true, isActive: true },
  },
  warehouse: {
    select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true },
  },
  deliveryAddress: {
    select: { guid: true, name: true, fullAddress: true, isActive: true },
  },
  organization: {
    select: { guid: true, name: true, code: true, isActive: true },
  },
  createdByUser: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      middleName: true,
      email: true,
      employeeProfile: {
        select: {
          onecUserGuid: true,
          onecPhysicalPersonGuid: true,
        },
      },
    },
  },
  items: {
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      lineGuid: true,
      quantity: true,
      quantityBase: true,
      basePrice: true,
      price: true,
      isManualPrice: true,
      manualPrice: true,
      priceSource: true,
      isCancelled: true,
      cancelReasonGuid: true,
      cancelReasonName: true,
      cancelReason: true,
      cancelledAmount: true,
      priceType: { select: { guid: true, name: true } },
      discountPercent: true,
      appliedDiscountPercent: true,
      lineAmount: true,
      comment: true,
      product: { select: { guid: true, name: true, sku: true, article: true, isActive: true } },
      package: { select: { guid: true, name: true, isDefault: true } },
      unit: { select: { guid: true, name: true, symbol: true } },
    },
  },
} satisfies Prisma.OrderSelect;

export type QueuedOrderForExport = Prisma.OrderGetPayload<{ select: typeof queuedOrderSelect }>;

export const clientOrderDirectPushLockKey = (guid: string) => `client-orders:direct-push:order:${guid}`;

const decimalToNumber = (value: Prisma.Decimal | number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
};

const compactFullName = (parts: Array<string | null | undefined>): string | null => {
  const value = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
  return value || null;
};

export function buildQueuedOrderPayload(order: QueuedOrderForExport) {
  const managerName = compactFullName([
    order.createdByUser?.lastName,
    order.createdByUser?.firstName,
    order.createdByUser?.middleName,
  ]);

  return {
    guid: order.guid ?? order.id,
    appGuid: order.guid ?? order.id,
    source: order.source,
    revision: order.revision,
    syncState: order.syncState,
    status: order.status,
    queuedAt: order.queuedAt,
    sentTo1cAt: order.sentTo1cAt,
    deliveryDate: order.deliveryDate,
    comment: order.comment,
    currency: order.currency,
    totalAmount: decimalToNumber(order.totalAmount),
    generalDiscountPercent: decimalToNumber(order.generalDiscountPercent),
    generalDiscountAmount: decimalToNumber(order.generalDiscountAmount),
    exportAttempts: order.exportAttempts,
    lastExportError: order.lastExportError,
    isPostedIn1c: order.isPostedIn1c,
    postedAt1c: order.postedAt1c,
    hasRealization: order.hasRealization,
    realizationDetectedAt: order.realizationDetectedAt,
    cancelRequestedAt: order.cancelRequestedAt,
    cancelReason: order.cancelReason,
    last1cError: order.last1cError,
    counterparty: order.counterparty,
    agreement: order.agreement,
    contract: order.contract,
    warehouse: order.warehouse,
    deliveryAddress: order.deliveryAddress,
    organization: order.organization,
    manager: order.createdByUser
      ? {
          userId: order.createdByUser.id,
          guid: order.createdByUser.employeeProfile?.onecUserGuid ?? null,
          physicalPersonGuid: order.createdByUser.employeeProfile?.onecPhysicalPersonGuid ?? null,
          name: managerName,
          email: order.createdByUser.email ?? null,
        }
      : null,
    items: order.items.map((item) => ({
      id: item.id,
      lineGuid: item.lineGuid,
      appLineGuid: item.lineGuid,
      product: item.product,
      package: item.package,
      unit: item.unit,
      quantity: decimalToNumber(item.quantity),
      quantityBase: decimalToNumber(item.quantityBase),
      basePrice: decimalToNumber(item.basePrice),
      price: decimalToNumber(item.price),
      isManualPrice: item.isManualPrice,
      manualPrice: decimalToNumber(item.manualPrice),
      priceSource: item.priceSource,
      isCancelled: item.isCancelled,
      cancelReasonGuid: item.cancelReasonGuid,
      cancelReasonName: item.cancelReasonName,
      cancelReason: item.cancelReason,
      cancelledAmount: decimalToNumber(item.cancelledAmount),
      priceType: item.priceType,
      discountPercent: decimalToNumber(item.discountPercent),
      appliedDiscountPercent: decimalToNumber(item.appliedDiscountPercent),
      lineAmount: decimalToNumber(item.lineAmount),
      comment: item.comment,
    })),
  };
}

export type QueuedOrderPayload = ReturnType<typeof buildQueuedOrderPayload>;
