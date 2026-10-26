import { OrderStatus, OrderSyncState } from '@prisma/client';
import { OnecLpAppHttpError } from '../onec/onec.lpApp.client';
import type { LiveClientOrder } from './clientOrders.onecLive';

export const CANCEL_FAILURE_POLICY = 'preserve-confirmed-order-v1';
export const CANCEL_REALIZATION_MESSAGE = 'Отмена не выполнена: по заказу уже есть проведённая реализация. Заказ не изменён.';

export function cancellationDocumentMatches(live: LiveClientOrder, appGuid: string) {
  return (live.appGuid || live.documentGuid).toLowerCase() === appGuid.toLowerCase();
}

export class ClientOrderCancellationDenied extends Error {
  constructor(public readonly live: LiveClientOrder) { super(CANCEL_REALIZATION_MESSAGE); }
}

export function cancellationDenialMessage(error: unknown): string | null {
  if (error instanceof ClientOrderCancellationDenied) return error.message;
  // Only an explicit business refusal is terminal. Timeouts and arbitrary 500s
  // are not proof that a write failed and must retain the existing safety path.
  if (!(error instanceof OnecLpAppHttpError)) return null;
  const message = error.message;
  if (/нельзя отменить заказ в 1с:.*провед[её]нн[а-яё]* реализаци/isu.test(message)) return CANCEL_REALIZATION_MESSAGE;
  if (/нельзя отменить заказ в 1с:.*(связанный документ не найден|объект документа не получен|документ еще не записан)/isu.test(message)) {
    return 'Отмена не выполнена: 1С не подтвердила связанный документ. Проверьте заказ в 1С.';
  }
  return null;
}

export type CancelFailurePolicy = { failurePolicy: typeof CANCEL_FAILURE_POLICY; previousStatus: OrderStatus;
  previousSyncState: OrderSyncState; previousExportError: string | null; previous1cError: string | null };

export function readCancelFailurePolicy(value: unknown): CancelFailurePolicy | null {
  const policy = value as CancelFailurePolicy | null;
  const statuses: OrderStatus[] = [OrderStatus.CONFIRMED, OrderStatus.SENT_TO_1C, OrderStatus.PARTIAL, OrderStatus.REJECTED];
  if (policy?.failurePolicy !== CANCEL_FAILURE_POLICY
    || !statuses.includes(policy.previousStatus)
    || !Object.values(OrderSyncState).includes(policy.previousSyncState)) return null;
  return policy;
}

export function deniedCancellationState(policy: CancelFailurePolicy, live?: LiveClientOrder | null) {
  const status = live
    ? live.status === OrderStatus.CANCELLED ? OrderStatus.CANCELLED
      : live.isPostedIn1c ? OrderStatus.CONFIRMED : OrderStatus.SENT_TO_1C
    : policy.previousStatus;
  return {
    status,
    syncState: live ? OrderSyncState.SYNCED : policy.previousSyncState,
    cancelRequestedAt: null, cancelReason: null,
    // The failed action belongs in history, not in the document's error banner.
    lastExportError: policy.previousExportError ?? null,
    last1cError: live?.isPostedIn1c ? null : live?.last1cError ?? policy.previous1cError ?? null,
    ...(live ? { isPostedIn1c: live.isPostedIn1c, hasRealization: live.hasRealization } : {}),
  };
}
