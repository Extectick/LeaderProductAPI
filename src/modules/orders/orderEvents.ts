import { Prisma, type OrderEventSource } from '@prisma/client';

type OrderEventTx = Prisma.TransactionClient;

export async function appendOrderEvent(
  tx: OrderEventTx,
  params: {
    orderId: string;
    revision: number;
    source: OrderEventSource;
    eventType: string;
    payload: Prisma.InputJsonValue;
    actorUserId?: number | null;
    note?: string | null;
  }
) {
  return tx.orderEvent.create({
    data: {
      orderId: params.orderId,
      revision: params.revision,
      source: params.source,
      eventType: params.eventType,
      payload: params.payload,
      actorUserId: params.actorUserId ?? null,
      note: params.note ?? null,
    },
  });
}
