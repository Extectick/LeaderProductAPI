import { createHash } from 'node:crypto';
import { z } from 'zod';
import prisma from '../../prisma/client';

const guid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
export const offlineExportPolicySchema = z.object({
  asOfDate: day,
  products: z.array(z.object({ guid, lastMovementDate: day })).max(200_000),
  priceTypes: z.array(z.object({ guid, dependencies: z.array(guid).max(2000) })).max(20_000),
  organizationGuids: z.array(guid).max(1000),
  warehouseGuids: z.array(guid).max(10_000),
  // Legacy stock export attaches warehouse-wide balances to one technical organization.
  stockOrganizationGuid: guid.optional(),
});
export type OfflineExportPolicy = z.infer<typeof offlineExportPolicySchema>;

/** Calendar months, clamped at month end (not an approximate 90-day window). */
export function threeMonthsBefore(dayString: string) {
  const date = new Date(`${dayString}T00:00:00Z`);
  const dayNumber = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 3);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayNumber, last));
  return date.toISOString().slice(0, 10);
}

export function buildOfflinePolicy(payload: OfflineExportPolicy, today: string) {
  const cutoff = threeMonthsBefore(today);
  const productGuids = [...new Set(payload.products
    .filter(item => item.lastMovementDate >= cutoff && item.lastMovementDate <= today)
    .map(item => item.guid))].sort();
  const priceTypes = [...payload.priceTypes].map(item => ({
    guid: item.guid, dependencies: [...new Set(item.dependencies)].sort(),
  })).sort((a, b) => a.guid.localeCompare(b.guid));
  const organizationGuids = [...new Set(payload.organizationGuids)].sort();
  const warehouseGuids = [...new Set(payload.warehouseGuids)].sort();
  const stockOrganizationGuid = payload.stockOrganizationGuid;
  // Stable on identical re-exports. Changes at rolling expiry even if 1C is offline.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    productGuids, priceTypes, organizationGuids, warehouseGuids, stockOrganizationGuid,
  })).digest('hex');
  return { productGuids, priceTypes, organizationGuids, warehouseGuids, stockOrganizationGuid, fingerprint };
}
export type ResolvedOfflinePolicy = ReturnType<typeof buildOfflinePolicy>;

export function priceTypeClosure(roots: string[], graph: OfflineExportPolicy['priceTypes']) {
  const edges = new Map(graph.map(item => [item.guid, item.dependencies]));
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(edges.get(current) ?? []));
  }
  return [...seen].sort();
}

export async function getOfflineExportPolicy(): Promise<ResolvedOfflinePolicy | null> {
  const row = await prisma.offlineExportPolicy.findUnique({ where: { id: 'client-orders' } });
  if (!row) return null; // Old 1C versions keep working until the first policy is published.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Omsk', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return buildOfflinePolicy(offlineExportPolicySchema.parse(row.payload), today);
}

export function scopedEpoch(epoch: string, policy: ResolvedOfflinePolicy | null, managerGuid = '') {
  if (!policy) return epoch;
  const hash = createHash('sha256').update(`${epoch}|offline-v2|${managerGuid}|${policy.fingerprint}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function saveOfflineExportPolicy(input: unknown) {
  const payload = offlineExportPolicySchema.parse(input);
  await prisma.offlineExportPolicy.upsert({
    where: { id: 'client-orders' }, create: { id: 'client-orders', payload }, update: { payload },
  });
  return { products: payload.products.length, priceTypes: payload.priceTypes.length };
}
