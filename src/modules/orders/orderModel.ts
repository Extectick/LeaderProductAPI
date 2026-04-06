import { Prisma } from '@prisma/client';

export const decimalToNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
};

export const toDecimal = (value?: number | null) =>
  value === undefined || value === null ? undefined : new Prisma.Decimal(value);

export const orderDetailSelect = {
  id: true,
  guid: true,
  number1c: true,
  date1c: true,
  source: true,
  revision: true,
  syncState: true,
  status: true,
  comment: true,
  deliveryDate: true,
  totalAmount: true,
  currency: true,
  generalDiscountPercent: true,
  generalDiscountAmount: true,
  queuedAt: true,
  sentTo1cAt: true,
  lastStatusSyncAt: true,
  exportAttempts: true,
  lastExportError: true,
  isPostedIn1c: true,
  postedAt1c: true,
  cancelRequestedAt: true,
  cancelReason: true,
  last1cError: true,
  last1cSnapshot: true,
  createdAt: true,
  updatedAt: true,
  counterparty: {
    select: {
      guid: true,
      name: true,
      fullName: true,
      inn: true,
      kpp: true,
      phone: true,
      email: true,
    },
  },
  agreement: {
    select: {
      guid: true,
      name: true,
      currency: true,
      isActive: true,
      priceType: {
        select: {
          guid: true,
          name: true,
        },
      },
    },
  },
  contract: {
    select: {
      guid: true,
      number: true,
      date: true,
      validFrom: true,
      validTo: true,
      isActive: true,
    },
  },
  warehouse: {
    select: {
      guid: true,
      name: true,
      code: true,
      isActive: true,
      isDefault: true,
      isPickup: true,
    },
  },
  deliveryAddress: {
    select: {
      guid: true,
      name: true,
      fullAddress: true,
      city: true,
      street: true,
      house: true,
      isActive: true,
    },
  },
  organization: {
    select: {
      guid: true,
      name: true,
      code: true,
      isActive: true,
    },
  },
  createdByUser: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      middleName: true,
      phone: true,
      email: true,
    },
  },
  items: {
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      quantity: true,
      quantityBase: true,
      basePrice: true,
      price: true,
      isManualPrice: true,
      manualPrice: true,
      priceSource: true,
      discountPercent: true,
      appliedDiscountPercent: true,
      lineAmount: true,
      comment: true,
      product: {
        select: {
          guid: true,
          name: true,
          code: true,
          article: true,
          sku: true,
        },
      },
      package: {
        select: {
          guid: true,
          name: true,
          multiplier: true,
          isDefault: true,
        },
      },
      unit: {
        select: {
          guid: true,
          name: true,
          symbol: true,
        },
      },
    },
  },
  events: {
    orderBy: [{ createdAt: 'desc' }],
    take: 50,
    select: {
      id: true,
      revision: true,
      source: true,
      eventType: true,
      payload: true,
      note: true,
      createdAt: true,
      actorUser: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          middleName: true,
          email: true,
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

export type OrderDetailRecord = Prisma.OrderGetPayload<{ select: typeof orderDetailSelect }>;

export function mapOrderDetail(order: OrderDetailRecord) {
  return {
    guid: order.guid,
    number1c: order.number1c,
    date1c: order.date1c,
    source: order.source,
    revision: order.revision,
    syncState: order.syncState,
    status: order.status,
    comment: order.comment,
    deliveryDate: order.deliveryDate,
    totalAmount: decimalToNumber(order.totalAmount),
    currency: order.currency,
    generalDiscountPercent: decimalToNumber(order.generalDiscountPercent),
    generalDiscountAmount: decimalToNumber(order.generalDiscountAmount),
    queuedAt: order.queuedAt,
    sentTo1cAt: order.sentTo1cAt,
    lastStatusSyncAt: order.lastStatusSyncAt,
    exportAttempts: order.exportAttempts,
    lastExportError: order.lastExportError,
    isPostedIn1c: order.isPostedIn1c,
    postedAt1c: order.postedAt1c,
    cancelRequestedAt: order.cancelRequestedAt,
    cancelReason: order.cancelReason,
    last1cError: order.last1cError,
    last1cSnapshot: order.last1cSnapshot,
    counterparty: order.counterparty,
    agreement: order.agreement
      ? {
          ...order.agreement,
          priceType: order.agreement.priceType,
        }
      : null,
    contract: order.contract,
    warehouse: order.warehouse,
    deliveryAddress: order.deliveryAddress,
    organization: order.organization,
    createdByUser: order.createdByUser
      ? {
          id: order.createdByUser.id,
          firstName: order.createdByUser.firstName,
          lastName: order.createdByUser.lastName,
          middleName: order.createdByUser.middleName,
          phone: order.createdByUser.phone,
          email: order.createdByUser.email,
        }
      : null,
    items: order.items.map((item) => ({
      id: item.id,
      quantity: decimalToNumber(item.quantity),
      quantityBase: decimalToNumber(item.quantityBase),
      basePrice: decimalToNumber(item.basePrice),
      price: decimalToNumber(item.price),
      isManualPrice: item.isManualPrice,
      manualPrice: decimalToNumber(item.manualPrice),
      priceSource: item.priceSource,
      discountPercent: decimalToNumber(item.discountPercent),
      appliedDiscountPercent: decimalToNumber(item.appliedDiscountPercent),
      lineAmount: decimalToNumber(item.lineAmount),
      comment: item.comment,
      product: item.product,
      package: item.package
        ? {
            ...item.package,
            multiplier: decimalToNumber(item.package.multiplier),
          }
        : null,
      unit: item.unit,
    })),
    events: order.events.map((event) => ({
      id: event.id,
      revision: event.revision,
      source: event.source,
      eventType: event.eventType,
      payload: event.payload,
      note: event.note,
      createdAt: event.createdAt,
      actorUser: event.actorUser
        ? {
            id: event.actorUser.id,
            firstName: event.actorUser.firstName,
            lastName: event.actorUser.lastName,
            middleName: event.actorUser.middleName,
            email: event.actorUser.email,
          }
        : null,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
