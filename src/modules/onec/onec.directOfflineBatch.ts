import { Prisma } from '@prisma/client';
import { OFFLINE_DATASET_SCOPE, recordOfflineDatasetChanges } from '../clientOrders/offlineClientOrders.service';

type Tx = Prisma.TransactionClient;
type Entity = 'manager-stock' | 'selling-prices';

export function lockDirectOfflineBatch(tx: Tx, entity: Entity) {
  // All writers for this direct import, including clear, share a transaction lock.
  // Unrelated entities and device readers do not wait on it.
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'onec:direct-batch:' + entity}, 0))`;
}

const definitions = {
  'manager-stock': {
    table: 'ManagerStockReservation',
    fields: ['managerGuid', 'productId', 'warehouseId', 'organizationId', 'reserved'],
  },
  'selling-prices': {
    table: 'SellingPrice',
    fields: ['productId', 'priceTypeId', 'price', 'currency', 'packageGuid', 'characteristicGuid',
      'sourceRegister', 'priority', 'startDate', 'endDate', 'minQty', 'isActive'],
  },
} as const;

type InputRow = Prisma.ManagerStockReservationCreateManyInput | Prisma.SellingPriceCreateManyInput;

async function applyRows<Row extends InputRow>(tx: Tx, entity: Entity, rows: Map<string, Row>, verifiedAt: Date,
  insert: (rows: Row[]) => Promise<unknown>) {
  if (!rows.size) return;
  // Only the fixed schema identifiers above enter SQL syntax. SQL casts incoming
  // numbers to the column's own precision before comparison. Omitted minQty has
  // Prisma's update semantics: keep the old value on update, null on insertion.
  const { table, fields } = definitions[entity];
  const relation = Prisma.raw('"' + table + '"');
  const next = (field: string) => field === 'minQty'
    ? 'COALESCE(i."minQty", t."minQty")' : 'i."' + field + '"';
  const before = Prisma.raw(fields.map(f => 't."' + f + '"').join(', '));
  const after = Prisma.raw(fields.map(next).join(', '));
  const updates = Prisma.raw([...fields, 'sourceUpdatedAt', 'lastSyncedAt'].map(f => '"' + f + '" = ' + next(f)).join(', '));
  const changed = await tx.$queryRaw<{ syncKey: string; isNew: boolean }[]>`
    WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_populate_recordset(NULL::${relation}, ${JSON.stringify([...rows.values()])}::jsonb)
    ), differences AS (
      SELECT i."syncKey", t.id IS NULL AS "isNew"
      FROM incoming i LEFT JOIN ${relation} t USING ("syncKey")
      WHERE t.id IS NULL OR ROW(${before}) IS DISTINCT FROM ROW(${after})
    ), refreshed AS (
      UPDATE ${relation} t SET ${updates}, "updatedAt" = i."lastSyncedAt"
      FROM incoming i WHERE t."syncKey" = i."syncKey"
    )
    SELECT "syncKey", "isNew" FROM differences`;
  const newRows = changed.filter(r => r.isNew).map(r => rows.get(r.syncKey)!);
  if (newRows.length) await insert(newRows); // Prisma generates the same IDs as normal creation.
  if (changed.length) {
    await recordOfflineDatasetChanges(tx, entity, changed.map(r => r.syncKey), verifiedAt);
  } else {
    // Verification is observable in the manifest, even when its revision is stable.
    const scopeKey = OFFLINE_DATASET_SCOPE;
    await tx.offlineDatasetState.upsert({
      where: { scopeKey_entity: { scopeKey, entity } },
      create: { scopeKey, entity, lastSourceUpdateAt: verifiedAt },
      update: { lastSourceUpdateAt: verifiedAt },
    });
  }
}

export function applyManagerReservations(tx: Tx, rows: Map<string, Prisma.ManagerStockReservationCreateManyInput>, time: Date) {
  return applyRows(tx, 'manager-stock', rows, time, data => tx.managerStockReservation.createMany({ data }));
}

export function applySellingPrices(tx: Tx, rows: Map<string, Prisma.SellingPriceCreateManyInput>, time: Date) {
  return applyRows(tx, 'selling-prices', rows, time, data => tx.sellingPrice.createMany({ data }));
}
