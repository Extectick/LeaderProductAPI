import { getOnecLpAppClientOrder, OnecLpAppHttpError } from './onec.lpApp.client';

export const ATOMIC_ORDER_WRITE_PROTOCOL = 'atomic-order-import-v1';

export class OnecOrderWriteUncertainError extends Error {
  readonly code = 'ONEC_WRITE_RECONCILIATION_REQUIRED';
  constructor(detail: string) {
    super(`Требуется проверка заказа в 1С. Повторная запись остановлена для защиты от дублей. ${detail}`);
    this.name = 'OnecOrderWriteUncertainError';
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function supportsAtomicOrderWrite(ping: unknown) {
  return record(ping).clientOrderWriteProtocolVersion === ATOMIC_ORDER_WRITE_PROTOCOL;
}

function sameGuid(a: unknown, b: unknown) {
  return typeof a === 'string' && a.length > 0 && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** A 404 from the old extension does NOT prove that no document was saved. */
export async function reconcilePreviousOrderWrite(
  previousPacket: unknown,
  currentPacket: unknown,
  atomicWriteAvailable: boolean,
): Promise<unknown | null> {
  const previous = record(previousPacket);
  const current = record(currentPacket);
  if (!sameGuid(previous.guid, current.guid) || !Number.isInteger(previous.revision)) {
    throw new OnecOrderWriteUncertainError('Не удалось проверить сохраненный пакет отправки.');
  }
  let response: unknown;
  try {
    response = await getOnecLpAppClientOrder(current.guid, {
      appGuid: current.guid, importReceipt: true, includeItems: true,
      managerGuid: record(current.manager).guid,
    });
  } catch (error) {
    if (error instanceof OnecLpAppHttpError && error.upstreamStatus === 409) {
      throw new OnecOrderWriteUncertainError('1С обнаружила конфликт связи с документом.');
    }
    if (error instanceof OnecLpAppHttpError && error.upstreamStatus !== 404
        && previous.writeProtocol !== ATOMIC_ORDER_WRITE_PROTOCOL) {
      throw new OnecOrderWriteUncertainError(`Старое расширение не подтвердило результат отправки (HTTP ${error.upstreamStatus}).`);
    }
    if (!(error instanceof OnecLpAppHttpError) || error.upstreamStatus !== 404) throw error;
    // Only packets originally sent to the atomic implementation can be replayed
    // after an ambiguous response. Upgrading 1C cannot make old orphan saves safe.
    if (previous.writeProtocol === ATOMIC_ORDER_WRITE_PROTOCOL && atomicWriteAvailable) return null;
    throw new OnecOrderWriteUncertainError('1С не подтвердила связь с ранее отправленным документом.');
  }
  const root = record(response);
  const saved = record(root.item ?? root);
  if (!sameGuid(saved.appGuid, current.guid) || !saved.documentGuid || !saved.number1c) {
    throw new OnecOrderWriteUncertainError('Ответ 1С не подтверждает идентификатор заказа приложения.');
  }
  if (saved.deletionMark === true || String(saved.status).toUpperCase() === 'CANCELLED') {
    // Cancellation is reconciled by its own explicit operation; a deleted order
    // must never be silently replaced with a new one.
    throw new OnecOrderWriteUncertainError('Связанный заказ отменен или помечен на удаление.');
  }
  for (const key of ['organization', 'counterparty']) {
    if (!sameGuid(record(saved[key]).guid, record(previous[key]).guid)) {
      throw new OnecOrderWriteUncertainError('Реквизиты связанного документа не совпадают с отправленным заказом.');
    }
  }
  if (!Number.isInteger(saved.lastImportedRevision) || saved.lastImportedRevision > current.revision) {
    throw new OnecOrderWriteUncertainError('1С не подтвердила ревизию отправленного заказа.');
  }
  if (saved.lastImportedRevision === current.revision) return response;
  // A previous operation is confirmed, or 1C guarantees that an uncertain retry
  // will take the same appGuid lock. A different order is never matched by amount.
  if (saved.lastImportedRevision === previous.revision
      || (previous.writeProtocol === ATOMIC_ORDER_WRITE_PROTOCOL && atomicWriteAvailable)) return null;
  throw new OnecOrderWriteUncertainError('Результат предыдущей отправки не подтвержден.');
}
