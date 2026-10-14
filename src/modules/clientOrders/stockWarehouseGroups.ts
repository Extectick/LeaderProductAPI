import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from '../../utils/cache';
import { getLiveWarehouses, findLiveWarehouse, type LiveWarehouse } from './clientOrders.onecLive';

type WarehouseGroupInfo = { guid: string; cityGuid: string | null; cityName: string | null; sortOrder: number | null };
const inFlight = new Map<string, Promise<WarehouseGroupInfo[]>>();

/** Display metadata only. Never replaces the stock scope or infers a city from a warehouse name. */
async function warehouseGroups(warehouses: Array<{ guid: string }>) {
  const scope = createHash('sha256').update(`${process.env.ONEC_LP_APP_BASE_URL || ''}|${warehouses.map(w => w.guid).sort().join(',')}`).digest('hex').slice(0, 16);
  const key = `stock-warehouse-groups:v1:${scope}`;
  const fresh = await cacheGet<WarehouseGroupInfo[]>(key);
  if (fresh) return fresh;
  const previous = await cacheGet<WarehouseGroupInfo[]>(`${key}:last-good`);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const items: WarehouseGroupInfo[] = [];
      const present = (w: LiveWarehouse): WarehouseGroupInfo => ({ guid: w.guid, cityGuid: w.cityGuid || w.parentGuid || null,
        cityName: w.cityName?.trim() || w.parentName?.trim() || null, sortOrder: w.sortOrder ?? null });
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await getLiveWarehouses({ limit: 100, offset, includeInactive: false });
        items.push(...page.items.map(present));
        if (page.total <= offset + page.items.length || !page.items.length) break;
      }
      // Stock history can include warehouses that are not selectable in new orders.
      // Read their display metadata by GUID; do not change any order allowlist.
      const known = new Set(items.map(w => w.guid));
      const missing = warehouses.filter(w => !known.has(w.guid)).slice(0, 100);
      for (let offset = 0; offset < missing.length; offset += 4) {
        const extra = await Promise.allSettled(missing.slice(offset, offset + 4).map(w => findLiveWarehouse(w.guid)));
        for (const result of extra) if (result.status === 'fulfilled' && result.value) items.push(present(result.value));
      }
      if (items.length) await Promise.all([cacheSet(key, items, 300), cacheSet(`${key}:last-good`, items, 7 * 86400)]);
      return items.length ? items : previous || [];
    })().catch(() => previous || []).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
  }
  // A temporary 1C outage must not delay an already known warehouse selector.
  return previous || pending;
}

export async function enrichStockWarehouseGroups<T extends { guid: string; name: string }>(warehouses: T[]) {
  if (!warehouses.length) return warehouses;
  const metadata = new Map((await warehouseGroups(warehouses)).map(w => [w.guid, w]));
  return warehouses.map(w => ({ ...w, ...(metadata.get(w.guid) || {}) }));
}
