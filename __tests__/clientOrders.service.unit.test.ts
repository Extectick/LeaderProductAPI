import { OrderStatus, OrderSyncState, Prisma } from '@prisma/client';

import {
  buildStoredClientOrderCopyItemData,
  normalizeClientOrderPublicError,
  resolveMergedClientOrderLast1cError,
  resolveActiveTrackingOrderSnapshot,
  resolveUpdatedOrderQueueState,
} from '../src/modules/clientOrders/clientOrders.service';

describe('clientOrders copy preparation', () => {
  const copiedAt = new Date('2026-08-03T06:00:00.000Z');
  const sourceLine = {
    lineGuid: 'old-line-guid',
    productId: 'product-1',
    packageId: 'package-1',
    unitId: 'unit-1',
    priceTypeId: 'price-type-1',
    quantity: new Prisma.Decimal(5),
    quantityBase: new Prisma.Decimal(5),
    basePrice: new Prisma.Decimal(120),
    price: new Prisma.Decimal(120),
    isManualPrice: false,
    manualPrice: null,
    priceSource: 'product-prices:Special',
    isCancelled: true,
    discountPercent: null,
    appliedDiscountPercent: null,
    lineAmount: new Prisma.Decimal(600),
    comment: 'copy me',
  };

  it('creates an independent active line and leaves automatic price empty for repricing', () => {
    const copy = buildStoredClientOrderCopyItemData(sourceLine, copiedAt);

    expect(copy.lineGuid).not.toBe(sourceLine.lineGuid);
    expect(copy.productId).toBe(sourceLine.productId);
    expect(copy.priceTypeId).toBe(sourceLine.priceTypeId);
    expect(copy.basePrice).toBeNull();
    expect(copy.price.toString()).toBe('0');
    expect(copy.priceSource).toBeNull();
    expect(copy.isCancelled).toBe(false);
    expect(copy.cancelReason).toBeNull();
  });

  it('preserves an explicitly entered manual price without requiring a price type', () => {
    const copy = buildStoredClientOrderCopyItemData({
      ...sourceLine,
      isManualPrice: true,
      manualPrice: new Prisma.Decimal(135.5),
      price: new Prisma.Decimal(135.5),
      lineAmount: new Prisma.Decimal(677.5),
    }, copiedAt);

    expect(copy.priceTypeId).toBeNull();
    expect(copy.isManualPrice).toBe(true);
    expect(copy.manualPrice?.toString()).toBe('135.5');
    expect(copy.price.toString()).toBe('135.5');
  });
});

describe('clientOrders service state machine helpers', () => {
  it('queues already exported orders with both status and syncState', () => {
    expect(resolveUpdatedOrderQueueState(OrderStatus.SENT_TO_1C)).toEqual({
      shouldQueueForExport: true,
      status: OrderStatus.QUEUED,
      syncState: OrderSyncState.QUEUED,
    });

    expect(resolveUpdatedOrderQueueState(OrderStatus.QUEUED)).toEqual({
      shouldQueueForExport: true,
      status: OrderStatus.QUEUED,
      syncState: OrderSyncState.QUEUED,
    });
  });

  it('keeps non-exported editable orders as drafts after local update', () => {
    expect(resolveUpdatedOrderQueueState(OrderStatus.DRAFT)).toEqual({
      shouldQueueForExport: false,
      status: OrderStatus.DRAFT,
      syncState: OrderSyncState.DRAFT,
    });
  });
});

describe('clientOrders public error formatting', () => {
  it('converts raw 1C push failures to a user-facing message', () => {
    const raw = [
      '1С HTTP 500: {МатрицаЗакупокИПродаж ОбщийМодуль.ОбменСПриложениемЗаказыКлиентов.Модуль(473)}: Ошибка прямого push заказа. requestId=abc; step=write-document; appGuid=4404c1cd',
      '{МатрицаЗакупокИПродаж ОбщийМодуль.ОбменСПриложениемЗаказыКлиентов.Модуль(440)}: Ошибка при вызове метода контекста (Записать): Не удалось провести: "Заказ клиента"!',
      'Непредвиденная ошибка',
    ].join('\n');

    expect(normalizeClientOrderPublicError(raw)).toBe(
      '1С не смогла провести заказ. Проверьте реквизиты, товары и остатки, затем отправьте повторно.'
    );
  });

  it('keeps stock validation errors understandable', () => {
    expect(normalizeClientOrderPublicError('Недостаточно доступного остатка по товару Ананас')).toBe(
      'Недостаточно остатка по одной или нескольким позициям.'
    );
  });
});

describe('clientOrders merged 1C error state', () => {
  it('keeps the current technical 1C posting error instead of a stale local error', () => {
    expect(resolveMergedClientOrderLast1cError(
      { isPostedIn1c: false, last1cError: 'Текущая ошибка проведения из 1С' },
      'Старая локальная ошибка'
    )).toBe('Текущая ошибка проведения из 1С');
  });

  it('clears a stale local error after 1C reports that the document is posted', () => {
    expect(resolveMergedClientOrderLast1cError(
      { isPostedIn1c: true, last1cError: null },
      'Старая локальная ошибка'
    )).toBeNull();
  });
});

describe('clientOrders tracking snapshot', () => {
  function createTrackingTx() {
    return {
      userRoute: {
        findFirst: jest.fn(),
      },
      routePoint: {
        findFirst: jest.fn(),
      },
    } as any;
  }

  it('returns latest point snapshot only when an active route exists', async () => {
    const tx = createTrackingTx();
    tx.userRoute.findFirst.mockResolvedValueOnce({
      id: 15,
      startedAt: new Date('2026-07-11T06:00:00.000Z'),
    });
    tx.routePoint.findFirst.mockResolvedValueOnce({
      id: 77,
      routeId: 15,
      latitude: 55.0301,
      longitude: 82.9202,
      recordedAt: new Date('2026-07-11T06:05:00.000Z'),
      eventType: 'MOVE',
      accuracy: 7,
      speed: 1.5,
      heading: 180,
      sequence: 3,
    });

    const result = await resolveActiveTrackingOrderSnapshot(tx, 4);

    expect(tx.userRoute.findFirst).toHaveBeenCalledWith({
      where: { userId: 4, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });
    expect(tx.routePoint.findFirst).toHaveBeenCalledWith({
      where: { userId: 4, routeId: 15 },
      orderBy: { recordedAt: 'desc' },
      select: expect.objectContaining({
        id: true,
        routeId: true,
        latitude: true,
        longitude: true,
        recordedAt: true,
      }),
    });
    expect(result).toMatchObject({
      routePointId: 77,
      snapshot: {
        routeId: 15,
        routeStartedAt: '2026-07-11T06:00:00.000Z',
        routePointId: 77,
        latitude: 55.0301,
        longitude: 82.9202,
        recordedAt: '2026-07-11T06:05:00.000Z',
        eventType: 'MOVE',
        accuracy: 7,
        speed: 1.5,
        heading: 180,
        sequence: 3,
      },
    });
    expect(result?.snapshot).toHaveProperty('capturedAt', expect.any(String));
  });

  it('does not attach a snapshot when tracking is off', async () => {
    const tx = createTrackingTx();
    tx.userRoute.findFirst.mockResolvedValueOnce(null);

    await expect(resolveActiveTrackingOrderSnapshot(tx, 4)).resolves.toBeNull();
    expect(tx.routePoint.findFirst).not.toHaveBeenCalled();
  });

  it('does not attach a snapshot when active route has no points yet', async () => {
    const tx = createTrackingTx();
    tx.userRoute.findFirst.mockResolvedValueOnce({
      id: 15,
      startedAt: new Date('2026-07-11T06:00:00.000Z'),
    });
    tx.routePoint.findFirst.mockResolvedValueOnce(null);

    await expect(resolveActiveTrackingOrderSnapshot(tx, 4)).resolves.toBeNull();
  });
});
