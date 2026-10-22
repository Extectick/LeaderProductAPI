import { canonicalSnapshotPayload } from './onec.orderSnapshotReceipt';
type SnapshotIdentity = {
  guid?: unknown; number1c?: unknown; revision?: unknown; baseRevision?: unknown;
  sourceUpdatedAt?: unknown; items?: unknown;
};
type FailedSnapshotOrder = {
  guid: string | null; number1c: string | null; revision: number; source: string;
  status: string; syncState: string; last1cError: string | null;
  lastExportError: string | null; cancelRequestedAt: Date | null; last1cSnapshot: unknown;
};

/** Catalog delivery may lag behind the order; preserve lines and allow an exact retry. */
export class MissingOrderSnapshotReferenceError extends Error {
  constructor(readonly productGuid: string) {
    super(`Product ${productGuid} not found for order snapshot`);
    this.name = 'MissingOrderSnapshotReferenceError';
  }
}

function isMissingSnapshotReference(message: string | null): boolean {
  return Boolean(message && /^Product \S+ not found for order snapshot$/.test(message));
}

export function canRetryMissingReferenceSnapshot(order: FailedSnapshotOrder, incoming: SnapshotIdentity): boolean {
  if (order.source !== 'MANAGER_APP' || order.syncState !== 'ERROR'
      || !['CONFIRMED', 'SENT_TO_1C'].includes(order.status)
      || !isMissingSnapshotReference(order.last1cError)
      || order.lastExportError || order.cancelRequestedAt !== null) return false;
  const previous = order.last1cSnapshot;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false;
  const failed = previous as SnapshotIdentity;
  if (!order.guid || !order.number1c || incoming.guid !== order.guid
      || incoming.number1c !== order.number1c || failed.guid !== order.guid
      || failed.number1c !== order.number1c
      || incoming.revision !== failed.revision || incoming.baseRevision !== failed.baseRevision) return false;
  const basedOnCurrent = incoming.baseRevision === order.revision;
  const alignedWithAck = incoming.revision === order.revision && incoming.baseRevision === order.revision - 1;
  return (basedOnCurrent || alignedWithAck)
    && canonicalSnapshotPayload(incoming) === canonicalSnapshotPayload(failed);
}
/** Retry only the rejected read snapshot; never acknowledge a pending manager edit. */
export function canRetryDuplicateLineSnapshot(order: FailedSnapshotOrder, incoming: SnapshotIdentity): boolean {
  if (order.source !== 'MANAGER_APP' || order.syncState !== 'ERROR'
      || !['CONFIRMED', 'SENT_TO_1C'].includes(order.status)
      || !order.last1cError?.startsWith('Duplicate lineGuid ')
      || order.lastExportError || order.cancelRequestedAt !== null) return false;
  const previous = order.last1cSnapshot;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false;
  const failed = previous as SnapshotIdentity;
  if (!order.guid || !order.number1c
      || incoming.guid !== order.guid || failed.guid !== order.guid
      || incoming.number1c !== order.number1c || failed.number1c !== order.number1c
      || incoming.revision !== order.revision || failed.revision !== order.revision
      || incoming.baseRevision !== failed.baseRevision
      || incoming.baseRevision !== order.revision - 1) return false;
  if (!Array.isArray(failed.items) || !failed.items.length) return false;
  const keys = failed.items.map(line => String(line?.lineGuid || line?.appLineGuid || '').trim().toLowerCase());
  if (keys.some(key => !key) || new Set(keys).size === keys.length) return false;
  if (failed.sourceUpdatedAt && incoming.sourceUpdatedAt) {
    const oldTime = new Date(failed.sourceUpdatedAt as string).getTime();
    const newTime = new Date(incoming.sourceUpdatedAt as string).getTime();
    if (!Number.isFinite(oldTime) || !Number.isFinite(newTime) || newTime < oldTime) return false;
  }
  return true;
}
