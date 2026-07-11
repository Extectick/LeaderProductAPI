import { OrderStatus, OrderSyncState } from '@prisma/client';

import {
  normalizeClientOrderPublicError,
  resolveActiveTrackingOrderSnapshot,
  resolveUpdatedOrderQueueState,
} from '../src/modules/clientOrders/clientOrders.service';

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
