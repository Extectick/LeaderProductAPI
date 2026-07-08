import { OrderStatus, OrderSyncState } from '@prisma/client';

import {
  normalizeClientOrderPublicError,
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
