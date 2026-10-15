import { stableOrderJson } from '../orders/orderIntegrity';

export const ORDER_SNAPSHOT_RECEIPT_VERSION = 'order-snapshot-receipt-v1';

export type OrderSnapshotReceipt = {
  key: string;
  status: 'ok' | 'error';
  applied: boolean;
  retryable: boolean;
  outcome: 'applied' | 'duplicate' | 'deferred' | 'rejected';
  currentRevision?: number;
  code?: string;
  error?: string;
};

type Snapshot = { guid: string; status: string; baseRevision: number; revision?: number; sourceUpdatedAt?: Date };
type SnapshotOrder = {
  guid: string | null; revision: number; syncState: string; status: string;
  last1cSnapshot: unknown;
};

function previousSnapshot(order: SnapshotOrder): Record<string, unknown> | null {
  const value = order.last1cSnapshot;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** A receipt replay must neither rewrite lines nor advance an implicit revision. */
export function isAcceptedSnapshotReplay(order: SnapshotOrder, incoming: Snapshot): boolean {
  if (order.syncState !== 'SYNCED' || order.status === 'QUEUED'
      || order.status !== incoming.status || order.guid !== incoming.guid
      || order.revision !== (incoming.revision ?? incoming.baseRevision + 1)) return false;
  const previous = previousSnapshot(order);
  if (!previous || previous.guid !== incoming.guid) return false;
  // JSON conversion mirrors Prisma JSON storage: dates become ISO strings and
  // optional undefined properties disappear. Object member order is irrelevant.
  return stableOrderJson(JSON.parse(JSON.stringify(incoming))) === stableOrderJson(previous);
}

/** Late callbacks cannot roll back a newer accepted revision or source version. */
export function isStaleOrderSnapshot(order: SnapshotOrder, incoming: Snapshot): boolean {
  if (incoming.revision !== undefined && incoming.revision < order.revision) return true;
  const previous = previousSnapshot(order);
  if (!previous || previous.guid !== incoming.guid
      || previous.revision !== incoming.revision || !previous.sourceUpdatedAt
      || !incoming.sourceUpdatedAt) return false;
  const previousTime = new Date(previous.sourceUpdatedAt as string).getTime();
  return Number.isFinite(previousTime) && incoming.sourceUpdatedAt.getTime() < previousTime;
}
