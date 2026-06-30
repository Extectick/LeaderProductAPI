import { OrderStatus, OrderSyncState } from '@prisma/client';

import { resolveUpdatedOrderQueueState } from '../src/modules/clientOrders/clientOrders.service';

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
