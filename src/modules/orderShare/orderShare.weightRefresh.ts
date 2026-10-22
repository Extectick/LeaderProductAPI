import { createHash } from 'node:crypto';
import type { OrderShareLink } from '@prisma/client';
import prisma from '../../prisma/client';
import { getLiveProductsByGuids } from '../clientOrders/clientOrders.onecLive';
import { collectWeightReferences, orderWeightKey } from './orderShare.weights';
import { shareVersion } from './orderShare.model';

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const BATCH_SIZE = 50;
const nextAllowed = new Map<string, number>();
const running = new Set<string>();
function plan(link: OrderShareLink, order: any) {
  const items = (order.items as any[]).filter(item => !item.isCancelled);
  const keys = [...new Set(items.map(orderWeightKey))].sort();
  const signature = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
  const snapshot = link.snapshot as any;
  const sameOrder = snapshot?._weightOrderKey === signature;
  const guids = [...new Set(items.map(item => String(item.product?.guid || '')).filter(Boolean))].sort();
  const savedCursor = sameOrder && Number.isInteger(snapshot._weightCursor) ? snapshot._weightCursor : 0;
  const cursor = savedCursor >= 0 && savedCursor < guids.length ? savedCursor : 0;
  const checkedAt = sameOrder ? Date.parse(snapshot._weightCheckedAt || '') : 0;
  return { items, keys, signature, guids, cursor, snapshot,
    due: !!guids.length && (!sameOrder || cursor > 0 || !checkedAt || Date.now() - checkedAt >= CHECK_INTERVAL_MS) };
}

/** Reference-only read. No order writes, import, posting or N+1 detail fallback. */
export async function refreshShareWeights(link: OrderShareLink, order: any) {
  const work = plan(link, order);
  if (!work.due) return;
  const batchGuids = work.guids.slice(work.cursor, work.cursor + BATCH_SIZE);
  const products = await getLiveProductsByGuids({ productGuids: batchGuids }, { skipMissingDetails: true });
  const fresh = collectWeightReferences(work.items, products);
  const references: Record<string, string> = {};
  const previous = work.snapshot?._weightReferences;
  const returned = new Set(products.map(product => product.guid.toLowerCase()));
  for (const item of work.items) {
    const key = orderWeightKey(item);
    // Explicitly missing weight on a returned reference clears the old value;
    // a missing/inactive reference keeps the last successful snapshot.
    const value = returned.has(String(item.product?.guid).toLowerCase()) ? fresh[key] : previous?.[key];
    if (typeof value === 'string' && /^[\d.e+-]+$/i.test(value) && value.length < 80) references[key] = value;
  }
  const next = work.cursor + batchGuids.length;
  const snapshot = { ...work.snapshot, _weightReferences: references, _weightOrderKey: work.signature,
    _weightCursor: next < work.guids.length ? next : 0, _weightCheckedAt: new Date().toISOString() };
  // A rotated, revoked or concurrently refreshed link cannot be overwritten.
  await prisma.orderShareLink.updateMany({ where: { id: link.id, ownerId: link.ownerId, orderGuid: link.orderGuid,
    tokenHash: link.tokenHash, counterpartyGuid: link.counterpartyGuid, revokedAt: null, version: link.version },
  data: { snapshot, version: shareVersion(snapshot) } });
}

/** Shared by all viewers; public reads never await 1C or database refresh writes. */
export function scheduleShareWeightRefresh(link: OrderShareLink, order: any) {
  if (process.env.ORDER_SHARE_WEIGHT_REFRESH_DISABLED === '1' || !plan(link, order).due) return;
  const now = Date.now();
  if (running.has(link.id) || running.size >= 3 || (nextAllowed.get(link.id) || 0) > now) return;
  if (nextAllowed.size >= 1000) for (const [id, until] of nextAllowed) if (until <= now) nextAllowed.delete(id);
  if (nextAllowed.size >= 1000) return;
  nextAllowed.set(link.id, now + 60_000);
  running.add(link.id);
  void refreshShareWeights(link, order).catch(() => {
    // A temporary 1C failure leaves the last good weights intact, without exposing technical errors.
  }).finally(() => running.delete(link.id));
}
