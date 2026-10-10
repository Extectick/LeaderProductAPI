import { Prisma, type OrderShareLink } from '@prisma/client';
import prisma from '../../prisma/client';
import { getClientOrderByGuid } from '../clientOrders/clientOrders.service';
import { resolveClientContacts } from './clientContacts';
import { createShareToken, decryptShareToken, encryptShareToken, projectShareOrder, shareTokenHash, shareVersion, type ShareSnapshot } from './orderShare.model';

// This select is intentionally independent of the employee order DTO.
export const publicOrderSelect = {
  id: true, guid: true, createdByUserId: true, number1c: true, date1c: true, createdAt: true,
  updatedAt: true, deliveryDate: true, status: true, totalAmount: true, currency: true,
  counterparty: { select: { name: true, guid: true } },
  items: { orderBy: { createdAt: 'asc' as const }, select: {
    id: true, lineGuid: true, quantity: true, price: true, lineAmount: true, isCancelled: true,
    product: { select: { name: true, guid: true, isWeight: true } },
    package: { select: { name: true, multiplier: true } }, unit: { select: { name: true, symbol: true } },
  } },
} satisfies Prisma.OrderSelect;

export class ShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const sharingEnabled = () => process.env.ORDER_SHARING_ENABLED === '1';
const unavailable = () => new ShareError(410, 'Ссылка недоступна. Обратитесь к менеджеру.');

export async function getOwnedShare(orderGuid: string, ownerId: number) {
  return prisma.orderShareLink.findUnique({ where: { ownerId_orderGuid: { ownerId, orderGuid } } });
}
export function presentOwnedShare(link: OrderShareLink) {
  const origin = process.env.ORDER_SHARE_PUBLIC_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/.test(origin)) throw new ShareError(503, 'Публикация заказов ещё не настроена');
  return { url: `${origin}/order/#${decryptShareToken(link.tokenEncrypted)}`, expiresAt: link.expiresAt.toISOString(),
    active: !link.revokedAt && link.expiresAt.getTime() > Date.now() };
}

export async function publishOrder(orderGuid: string, ownerId: number, rotate: boolean) {
  const local = await prisma.order.findUnique({ where: { guid: orderGuid }, select: publicOrderSelect });
  // Never allow a manager to share another manager's local order.
  if (local && local.createdByUserId !== ownerId) throw new ShareError(404, 'Заказ не найден');
  const order = local || await getClientOrderByGuid(orderGuid, ownerId);
  const snapshot = projectShareOrder(order);
  if (!snapshot.counterpartyGuid) throw new ShareError(400, 'Выберите клиента');
  const link = await prisma.$transaction(async tx => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-share:${ownerId}:${orderGuid}`}, 0))`;
  const existing = await tx.orderShareLink.findUnique({ where: { ownerId_orderGuid: { ownerId, orderGuid } } });
  const replaceToken = rotate || !existing || !!existing.revokedAt || existing.expiresAt.getTime() <= Date.now()
    || existing.counterpartyGuid !== snapshot.counterpartyGuid;
  const token = replaceToken ? createShareToken() : decryptShareToken(existing!.tokenEncrypted);
  const data = { localOrderId: local?.id ?? null, counterpartyGuid: snapshot.counterpartyGuid,
    tokenHash: shareTokenHash(token), tokenEncrypted: encryptShareToken(token), snapshot,
    version: shareVersion(snapshot), revokedAt: null, refreshedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400_000) };
  // A concurrent first publication must return the winning stable link.
  return tx.orderShareLink.upsert({
    where: { ownerId_orderGuid: { ownerId, orderGuid } },
    create: { orderGuid, ownerId, ...data }, update: data,
  });
  });
  return presentOwnedShare(link);
}

export async function authorizePublicShare(token: string) {
  const link = await prisma.orderShareLink.findUnique({ where: { tokenHash: shareTokenHash(token) } });
  if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw unavailable();
  const owner = await prisma.user.findFirst({ where: { id: link.ownerId, deletedAt: null, isActive: true, profileStatus: { not: 'BLOCKED' } },
    select: { firstName: true, lastName: true, phone: true, clientContacts: true } });
  if (!owner) throw unavailable();
  return { link, owner };
}
async function revokeInvalidLink(link: OrderShareLink): Promise<never> {
  await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash }, data: { revokedAt: new Date() } });
  throw unavailable();
}
export async function sharedImageKey(token: string, imageId: string) {
  const { link } = await authorizePublicShare(token);
  const image = await prisma.productImage.findFirst({ where: { id: imageId, deletedAt: null, syncState: 'SYNCED' },
    select: { productGuid: true, s3KeyPreview: true, s3KeyThumb: true } });
  if (!image) return null;
  if (link.localOrderId) {
    const order = await prisma.order.findUnique({ where: { id: link.localOrderId }, select: {
      createdByUserId: true, counterparty: { select: { guid: true } },
      items: { where: { isCancelled: false, product: { guid: image.productGuid } }, select: { id: true }, take: 1 },
    } });
    if (!order || order.createdByUserId !== link.ownerId || order.counterparty?.guid !== link.counterpartyGuid) return revokeInvalidLink(link);
    if (!order.items.length) return null;
  } else if (!(link.snapshot as unknown as ShareSnapshot).items.some(item => item.productGuid === image.productGuid)) return null;
  return image.s3KeyPreview || image.s3KeyThumb;
}
export async function resolvePublicShare(token: string) {
  const { link, owner } = await authorizePublicShare(token);
  let snapshot = link.snapshot as unknown as ShareSnapshot;
  let updatedAt = link.refreshedAt;
  if (link.localOrderId != null) {
    const local = await prisma.$transaction(tx => tx.order.findUnique({ where: { id: link.localOrderId! }, select: publicOrderSelect }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!local || local.createdByUserId !== link.ownerId || local.counterparty?.guid !== link.counterpartyGuid) return revokeInvalidLink(link);
    // Header and relations are read in an explicit repeatable-read transaction;
    // the employee's save transaction commits header and lines together.
    snapshot = projectShareOrder(local);
    updatedAt = local.updatedAt;
  } else {
    scheduleLiveRefresh(link);
  }
  if (snapshot.counterpartyGuid !== link.counterpartyGuid) throw unavailable();
  const images = await prisma.productImage.findMany({ where: {
    productGuid: { in: [...new Set(snapshot.items.map(item => item.productGuid))] }, deletedAt: null, syncState: 'SYNCED',
  }, orderBy: [{ isMain: 'desc' }, { updatedAt: 'desc' }], select: { id: true, productGuid: true, updatedAt: true } });
  const imageByProduct = new Map<string, typeof images[number]>();
  for (const image of images) if (!imageByProduct.has(image.productGuid)) imageByProduct.set(image.productGuid, image);
  const data = {
    number: snapshot.number, date: snapshot.date, customer: snapshot.customer, deliveryDate: snapshot.deliveryDate,
    currency: snapshot.currency, cancelled: snapshot.cancelled, total: snapshot.total, updatedAt: updatedAt.toISOString(),
    manager: { name: [owner.firstName, owner.lastName].filter(Boolean).join(' '), ...resolveClientContacts(owner.clientContacts, owner.phone) },
    items: snapshot.items.map(({ productGuid, ...item }) => {
      const image = imageByProduct.get(productGuid);
      return { ...item, image: image ? { id: image.id, version: image.updatedAt.toISOString() } : null };
    }),
  };
  return { link, snapshot, data, etag: `"${shareVersion(data)}"` };
}

// At most one bounded refresh per active 1C-only link/minute, irrespective of viewer count.
// Public requests return the last saved snapshot immediately and never wait for 1C.
const refreshes = new Map<string, number>();
function scheduleLiveRefresh(link: OrderShareLink) {
  if (Date.now() - link.refreshedAt.getTime() < 60_000 || (refreshes.get(link.id) || 0) > Date.now()) return;
  if (refreshes.size > 1000) for (const [id, until] of refreshes) if (until < Date.now()) refreshes.delete(id);
  if (refreshes.size >= 1000 || activeRefreshes >= 3) return;
  refreshes.set(link.id, Date.now() + 60_000);
  activeRefreshes++;
  void (async () => {
    try {
      const order = await getClientOrderByGuid(link.orderGuid, link.ownerId);
      const snapshot = projectShareOrder(order);
      if (snapshot.counterpartyGuid !== link.counterpartyGuid) {
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash }, data: { revokedAt: new Date() } });
      } else {
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash, revokedAt: null },
          data: { snapshot, version: shareVersion(snapshot), refreshedAt: new Date() } });
      }
    } catch (error) {
      if ([403, 404].includes(Number((error as { status?: number }).status))) {
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash }, data: { revokedAt: new Date() } });
      }
      // Transient upstream failure keeps the last good snapshot; no credentials/DTOs in logs.
    } finally { activeRefreshes--; }
  })().catch(() => undefined);
}
let activeRefreshes = 0;
