import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

type Row = { key: string; item: Record<string, unknown> };
// Source timestamps often mean "exported at", not "changed at". They must not
// invalidate otherwise identical data. Dates of documents/prices remain semantic.
const transportFields = new Set(['sourceUpdatedAt', 'lastSyncedAt', 'updatedAt']);
export function offlineContentHash(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort()
      .filter(key => !transportFields.has(key)).map(key => [key, canonical(item[key])]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Caller holds a transaction-scoped advisory lock and a consistent DB snapshot. */
export async function reconcileOfflineProjection(
  tx: Prisma.TransactionClient,
  input: {
    scopeKey: string; entity: string; schemaVersion: number; fingerprint: string;
    pages: () => AsyncGenerator<Row[]>;
    now?: Date;
  },
) {
  const { scopeKey, entity, schemaVersion, fingerprint } = input;
  const now = input.now ?? new Date();
  const state = await tx.offlineDatasetState.findUnique({ where: { scopeKey_entity: { scopeKey, entity } } });
  // Periodic safety reconciliation also covers administrative changes outside exchange.
  if (state?.sourceFingerprint === fingerprint && state.schemaVersion === schemaVersion
    && state.lastFullReconcileAt && now.getTime() - state.lastFullReconcileAt.getTime() < 15 * 60_000) return state;
  const old = await tx.offlineDatasetRow.findMany({ where: { scopeKey, entity }, select: { itemKey: true, hash: true } });
  const unseen = new Map(old.map(row => [row.itemKey, row.hash]));
  let changed = 0;
  let itemCount = 0;
  for await (const rows of input.pages()) {
    const updates: { itemKey: string; hash: string; payload: Prisma.InputJsonValue }[] = [];
    for (const row of rows) {
      if (!row.key) throw new Error(`Empty offline key: ${entity}`);
      const hash = offlineContentHash(row.item);
      if (unseen.get(row.key) !== hash) updates.push({ itemKey: row.key, hash, payload: row.item as Prisma.InputJsonObject });
      unseen.delete(row.key);
      itemCount++;
    }
    if (!updates.length) continue;
    changed += updates.length;
    // Bounded, parameterized bulk upsert; unchanged rows cause no writes.
    await tx.$executeRaw`
      INSERT INTO "OfflineDatasetRow" ("scopeKey", "entity", "itemKey", "hash", "payload")
      SELECT ${scopeKey}, ${entity}, r."itemKey", r.hash, r.payload
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS r("itemKey" text, hash text, payload jsonb)
      ON CONFLICT ("scopeKey", "entity", "itemKey") DO UPDATE SET hash = EXCLUDED.hash, payload = EXCLUDED.payload`;
    if (state) await tx.offlineDatasetChange.createMany({ data: updates.map(row => ({
      scopeKey, entity, itemKey: row.itemKey, operation: 'UPSERT', payload: row.payload, sourceUpdatedAt: now,
    })) });
  }
  const removed = [...unseen.keys()];
  changed += removed.length;
  for (let offset = 0; offset < removed.length; offset += 1000) {
    const keys = removed.slice(offset, offset + 1000);
    await tx.offlineDatasetRow.deleteMany({ where: { scopeKey, entity, itemKey: { in: keys } } });
    if (state) await tx.offlineDatasetChange.createMany({ data: keys.map(itemKey => ({
      scopeKey, entity, itemKey, operation: 'DELETE', sourceUpdatedAt: now,
    })) });
  }
  const latest = state && changed ? await tx.offlineDatasetChange.findFirst({
    where: { scopeKey, entity }, orderBy: { revision: 'desc' }, select: { revision: true },
  }) : null;
  // Keep 30 days of this scope's deltas, not a global sequence-number window:
  // unrelated managers must never expire each other's offline history.
  const expired = await tx.offlineDatasetChange.findFirst({
    where: { scopeKey, entity, createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } },
    orderBy: { revision: 'desc' }, select: { revision: true },
  });
  if (expired) await tx.offlineDatasetChange.deleteMany({ where: { scopeKey, entity, revision: { lte: expired.revision } } });
  const data = {
    schemaVersion, itemCount, sourceFingerprint: fingerprint,
    currentRevision: latest?.revision ?? state?.currentRevision ?? 0n,
    minAvailableRevision: expired?.revision ?? state?.minAvailableRevision ?? 0n,
    lastSourceUpdateAt: !state || changed ? now : state.lastSourceUpdateAt,
    lastFullReconcileAt: now,
  };
  return tx.offlineDatasetState.upsert({ where: { scopeKey_entity: { scopeKey, entity } },
    create: { scopeKey, entity, ...data }, update: data });
}
