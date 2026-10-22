import { Prisma, type OrderShareLink } from '@prisma/client';
import prisma from '../../prisma/client';
import { getClientOrderByGuid } from '../clientOrders/clientOrders.service';
import { isInvoiceShadowOrder } from '../clientOrders/clientOrders.invoiceShadow';
import { restoreClientOrderDetailSnapshot } from '../clientOrders/clientOrders.onecLive';
import { resolveClientContacts } from './clientContacts';
import { createShareToken, decryptShareToken, encryptShareToken, projectShareOrder, shareTokenHash, shareVersion, type ShareSnapshot } from './orderShare.model';
import { summarizeShareWeights } from './orderShare.weights';
import { scheduleShareWeightRefresh } from './orderShare.weightRefresh';
import { logShareError, ShareError } from './orderShare.errors';
export { ShareError } from './orderShare.errors';

// This select is intentionally independent of the employee order DTO.
export const publicOrderSelect = {
  id: true, guid: true, createdByUserId: true, number1c: true, date1c: true, createdAt: true,
  updatedAt: true, deliveryDate: true, deliveryMethod: true, status: true, totalAmount: true, currency: true,
  deliveryAddress: { select: { fullAddress: true } },
  counterparty: { select: { name: true, guid: true } },
  items: { orderBy: { createdAt: 'asc' as const }, select: {
    id: true, lineGuid: true, quantity: true, price: true, lineAmount: true, isCancelled: true,
    product: { select: { name: true, guid: true, isWeight: true,
      baseUnit: { select: { guid: true, name: true, symbol: true, code: true } } } },
    package: { select: { guid: true, name: true, multiplier: true,
      unit: { select: { guid: true, name: true, symbol: true, code: true } } } },
    unit: { select: { guid: true, name: true, symbol: true, code: true } },
  } },
} satisfies Prisma.OrderSelect;

export const sharingEnabled = () => process.env.ORDER_SHARING_ENABLED === '1';
const unavailable = () => new ShareError(410, 'Ссылка недоступна. Обратитесь к менеджеру.');

// Read the potentially large invoice snapshot only for an empty relational model.
// An ordinary incomplete draft must never fall through to unrelated 1C data.
async function invoiceShadowSource(client: Pick<Prisma.TransactionClient, 'order'>,
  local: { id: string; guid: string | null; createdByUserId: number | null; items: unknown[] }) {
  if (local.items.length || !local.id) return null;
  const source = await client.order.findUnique({ where: { id: local.id }, select: {
    guid: true, createdByUserId: true, clientOrderId: true, syncState: true, last1cSnapshot: true,
    _count: { select: { items: true } },
  } });
  if (!source || source.guid !== local.guid || source.createdByUserId !== local.createdByUserId || source._count?.items !== 0) return null;
  return isInvoiceShadowOrder({ ...source, items: [] }) ? source : null;
}

function savedInvoiceShadow(source: NonNullable<Awaited<ReturnType<typeof invoiceShadowSource>>>) {
  const root = source.last1cSnapshot as Record<string, unknown>;
  const item = root.item && typeof root.item === 'object' && !Array.isArray(root.item)
    ? root.item as Record<string, unknown> : root;
  const documentGuid = typeof item.documentGuid === 'string' ? item.documentGuid : '';
  const matches = documentGuid.toLowerCase() === source.guid?.toLowerCase()
    || (typeof item.appGuid === 'string' && item.appGuid.toLowerCase() === source.guid?.toLowerCase());
  const detail = documentGuid && matches ? restoreClientOrderDetailSnapshot(item, documentGuid) : null;
  if (!detail) throw new ShareError(503, 'Не удалось загрузить товары заказа. Попробуйте ещё раз.', 'ORDER_SNAPSHOT_UNAVAILABLE');
  return detail;
}

function publicShareOrigin() {
  const origin = process.env.ORDER_SHARE_PUBLIC_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/.test(origin)) throw new ShareError(503, 'Публикация заказов ещё не настроена', 'SHARING_NOT_CONFIGURED');
  return origin;
}

export async function getOwnedShare(orderGuid: string, ownerId: number) {
  return prisma.orderShareLink.findUnique({ where: { ownerId_orderGuid: { ownerId, orderGuid } } });
}
export function presentOwnedShare(link: OrderShareLink) {
  const origin = publicShareOrigin();
  // Enable only after the public page and token-redacted nginx route are deployed.
  const prefix = process.env.ORDER_SHARE_PATH_LINKS_ENABLED === '1' ? '' : '#';
  return { url: `${origin}/order/${prefix}${decryptShareToken(link.tokenEncrypted)}`, expiresAt: link.expiresAt.toISOString(),
    active: !link.revokedAt && link.expiresAt.getTime() > Date.now() };
}

export async function publishOrder(orderGuid: string, ownerId: number, rotate: boolean) {
  const local = await prisma.order.findUnique({ where: { guid: orderGuid }, select: publicOrderSelect });
  // Never allow a manager to share another manager's local order.
  if (local && local.createdByUserId !== ownerId) throw new ShareError(404, 'Заказ не найден');
  publicShareOrigin(); // Reject configuration errors before publishing anything.
  const shadow = local ? await invoiceShadowSource(prisma, local) : null;
  const localSource = local && !shadow ? local : null;
  const order = localSource || await getClientOrderByGuid(orderGuid, ownerId);
  let snapshot = projectShareOrder(order);
  if (!snapshot.counterpartyGuid) throw new ShareError(400, 'Выберите клиента');
  if (local && snapshot.counterpartyGuid !== local.counterparty?.guid) {
    throw new ShareError(409, 'Заказ изменился. Обновите документ и повторите создание ссылки.', 'ORDER_CHANGED');
  }
  const link = await prisma.$transaction(async tx => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-share:${ownerId}:${orderGuid}`}, 0))`;
  const existing = await tx.orderShareLink.findUnique({ where: { ownerId_orderGuid: { ownerId, orderGuid } } });
  const weightCache = existing?.counterpartyGuid === snapshot.counterpartyGuid ? existing?.snapshot as any : null;
  if (localSource && weightCache) snapshot = { ...projectShareOrder(order, weightCache._weightReferences),
    ...Object.fromEntries(Object.entries(weightCache).filter(([key]) => ['_weightReferences','_weightOrderKey','_weightCursor','_weightCheckedAt'].includes(key))) };
  const replaceToken = rotate || !existing || !!existing.revokedAt || existing.expiresAt.getTime() <= Date.now()
    || existing.counterpartyGuid !== snapshot.counterpartyGuid;
  const token = replaceToken ? createShareToken() : decryptShareToken(existing!.tokenEncrypted);
  const data = { localOrderId: localSource?.id ?? null, counterpartyGuid: snapshot.counterpartyGuid,
    tokenHash: shareTokenHash(token), tokenEncrypted: encryptShareToken(token), snapshot,
    version: shareVersion(snapshot), revokedAt: null, refreshedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400_000) };
  // A concurrent first publication must return the winning stable link.
  return tx.orderShareLink.upsert({
    where: { ownerId_orderGuid: { ownerId, orderGuid } },
    create: { orderGuid, ownerId, ...data }, update: data,
  });
  });
  if (localSource) scheduleShareWeightRefresh(link, localSource);
  return presentOwnedShare(link);
}

export async function authorizePublicShare(token: string) {
  const link = await prisma.orderShareLink.findUnique({ where: { tokenHash: shareTokenHash(token) } });
  if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw unavailable();
  const owner = await prisma.user.findFirst({ where: { id: link.ownerId, deletedAt: null, isActive: true, profileStatus: { not: 'BLOCKED' } },
    select: { firstName: true, lastName: true, phone: true, clientContacts: true } });
  if (!owner) throw unavailable();
  if (link.localOrderId == null) {
    // A 1C-backed link can still have invoice bookkeeping in the API. Clearing
    // the empty relational binding must not bypass an owner/customer change.
    const source = await prisma.order.findUnique({ where: { guid: link.orderGuid }, select: {
      createdByUserId: true, counterparty: { select: { guid: true } },
    } });
    if (source && (source.createdByUserId !== link.ownerId || source.counterparty?.guid !== link.counterpartyGuid)) {
      return revokeInvalidLink(link);
    }
  }
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
      id: true, guid: true, createdByUserId: true, counterparty: { select: { guid: true } },
      items: { where: { isCancelled: false, product: { guid: image.productGuid } }, select: { id: true }, take: 1 },
    } });
    if (!order || order.createdByUserId !== link.ownerId || order.counterparty?.guid !== link.counterpartyGuid) return revokeInvalidLink(link);
    if (!order.items.length) {
      const shadow = await invoiceShadowSource(prisma, order);
      if (!shadow) return null;
      const snapshot = projectShareOrder(savedInvoiceShadow(shadow));
      if (snapshot.counterpartyGuid !== link.counterpartyGuid) return revokeInvalidLink(link);
      if (!snapshot.items.some(item => item.productGuid === image.productGuid)) return null;
    }
  } else if (!(link.snapshot as unknown as ShareSnapshot).items.some(item => item.productGuid === image.productGuid)) return null;
  return image.s3KeyPreview || image.s3KeyThumb;
}
export async function resolvePublicShare(token: string) {
  const { link, owner } = await authorizePublicShare(token);
  let snapshot = link.snapshot as unknown as ShareSnapshot;
  let updatedAt = link.refreshedAt;
  if (link.localOrderId != null) {
    const { local, shadow } = await prisma.$transaction(async tx => {
      const local = await tx.order.findUnique({ where: { id: link.localOrderId! }, select: publicOrderSelect });
      // Do not read invoice data until the owner and customer binding is checked.
      const bound = local && local.createdByUserId === link.ownerId && local.counterparty?.guid === link.counterpartyGuid;
      return { local, shadow: bound ? await invoiceShadowSource(tx, local) : null };
    },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!local || local.createdByUserId !== link.ownerId || local.counterparty?.guid !== link.counterpartyGuid) return revokeInvalidLink(link);
    // Header and relations are read in an explicit repeatable-read transaction;
    // the employee's save transaction commits header and lines together.
    if (shadow) {
      const detail = savedInvoiceShadow(shadow);
      snapshot = projectShareOrder({ ...detail, status: local.status === 'CANCELLED' ? 'CANCELLED' : detail.status });
      updatedAt = local.updatedAt;
      // Upgrade a legacy empty binding through the existing bounded live-source
      // refresh. First paint and image access remain usable without waiting for 1C.
      scheduleLiveRefresh(link, true);
    } else {
      snapshot = projectShareOrder(local, (link.snapshot as any)?._weightReferences);
      updatedAt = local.updatedAt;
      scheduleShareWeightRefresh(link, local);
    }
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
    deliveryMethod: snapshot.deliveryMethod ?? null, deliveryAddress: snapshot.deliveryAddress ?? null,
    currency: snapshot.currency, cancelled: snapshot.cancelled, total: snapshot.total, updatedAt: updatedAt.toISOString(),
    ...summarizeShareWeights(snapshot.items),
    manager: { name: [owner.firstName, owner.lastName].filter(Boolean).join(' '), ...resolveClientContacts(owner.clientContacts, owner.phone) },
    items: snapshot.items.map(item => {
      const { productGuid } = item;
      const image = imageByProduct.get(productGuid);
      return { id: item.id, name: item.name, quantity: item.quantity, unit: item.unit,
        unitPrice: item.unitPrice, amount: item.amount, weightKg: item.weightKg ?? null,
        image: image ? { id: image.id, version: image.updatedAt.toISOString() } : null };
    }),
  };
  return { link, snapshot, data, etag: `"${shareVersion(data)}"` };
}

// At most one bounded refresh per active 1C-only link/minute, irrespective of viewer count.
// Public requests return the last saved snapshot immediately and never wait for 1C.
const refreshes = new Map<string, number>();
function scheduleLiveRefresh(link: OrderShareLink, detachInvoiceShadow = false) {
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
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash,
          counterpartyGuid: link.counterpartyGuid, version: link.version }, data: { revokedAt: new Date() } });
      } else {
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash, revokedAt: null,
          counterpartyGuid: link.counterpartyGuid, version: link.version },
          data: { snapshot, version: shareVersion(snapshot), refreshedAt: new Date(),
            ...(detachInvoiceShadow ? { localOrderId: null } : {}) } });
      }
    } catch (error) {
      if ([403, 404].includes(Number((error as { status?: number }).status))) {
        await prisma.orderShareLink.updateMany({ where: { id: link.id, tokenHash: link.tokenHash,
          counterpartyGuid: link.counterpartyGuid, version: link.version }, data: { revokedAt: new Date() } });
      }
      logShareError(error, { operation: 'REFRESH', orderGuid: link.orderGuid, ownerId: link.ownerId });
    } finally { activeRefreshes--; }
  })().catch(() => undefined);
}
let activeRefreshes = 0;
