import prisma from '../../prisma/client';
import {
  OnecLpAppHttpError,
  requestOnecLpAppClientOrderInvoice,
} from '../onec/onec.lpApp.client';
import { processInvoice, syncQueueItem } from '../../services/clientOrderInvoiceWorker';
import { downloadBuffer } from '../../storage/minio';
import { ErrorCodes } from '../../utils/apiResponse';
import { ClientOrdersError } from './clientOrders.service';
import { findLiveClientOrder, getLiveClientOrder } from './clientOrders.onecLive';

const publicInvoiceSelect = {
  id: true,
  realizationGuid: true,
  realizationNumber: true,
  realizationDate: true,
  version: true,
  state: true,
  waitReason: true,
  lastError: true,
  s3Key: true,
  fileName: true,
  sentAt: true,
} as const;

const accessibleOrderSelect = {
  id: true,
  guid: true,
  number1c: true,
  createdByUserId: true,
  last1cSnapshot: true,
} as const;

type AccessibleOrder = {
  id: string;
  guid: string | null;
  number1c: string | null;
  createdByUserId: number | null;
  last1cSnapshot: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedString(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function snapshotIdentity(snapshot: unknown) {
  const root = asRecord(snapshot);
  const item = asRecord(root?.item) ?? root;
  return {
    appGuid: normalizedString(item?.appGuid),
    documentGuid: normalizedString(item?.documentGuid) || normalizedString(item?.guid),
    managerGuid: normalizedString(item?.managerGuid),
    number1c: normalizedString(item?.number1c),
  };
}

async function findOrderByInvoiceIdentifier(identifier: string): Promise<AccessibleOrder | null> {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  const direct = await prisma.order.findFirst({
    where: { guid: normalizedIdentifier },
    select: accessibleOrderSelect,
  });
  if (direct) return direct;

  return prisma.order.findFirst({
    where: {
      OR: [
        { last1cSnapshot: { path: ['item', 'appGuid'], equals: normalizedIdentifier } },
        { last1cSnapshot: { path: ['item', 'documentGuid'], equals: normalizedIdentifier } },
        { last1cSnapshot: { path: ['item', 'guid'], equals: normalizedIdentifier } },
        { last1cSnapshot: { path: ['appGuid'], equals: normalizedIdentifier } },
        { last1cSnapshot: { path: ['documentGuid'], equals: normalizedIdentifier } },
        { last1cSnapshot: { path: ['guid'], equals: normalizedIdentifier } },
      ],
    },
    select: accessibleOrderSelect,
  });
}

function dateOrNull(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shadowOrderStatus(status: string) {
  return ['DRAFT', 'QUEUED', 'SENT_TO_1C', 'CONFIRMED', 'PARTIAL', 'REJECTED', 'CANCELLED'].includes(status)
    ? status as 'DRAFT' | 'QUEUED' | 'SENT_TO_1C' | 'CONFIRMED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED'
    : 'CONFIRMED';
}

async function createInvoiceShadowOrder(detail: Awaited<ReturnType<typeof getLiveClientOrder>>, userId: number) {
  const orderGuid = normalizedString(detail.appGuid) || normalizedString(detail.documentGuid) || normalizedString(detail.guid);
  if (!orderGuid || !detail.counterparty?.guid) return null;
  const sourceUpdatedAt = dateOrNull(detail.lastStatusSyncAt) ?? new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findFirst({
        where: {
          OR: [
            { guid: orderGuid },
            ...(detail.number1c ? [{ number1c: detail.number1c }] : []),
          ],
        },
        select: accessibleOrderSelect,
      });
      if (existing) return existing;

      const counterparty = await tx.counterparty.upsert({
        where: { guid: detail.counterparty!.guid },
        create: {
          guid: detail.counterparty!.guid,
          name: detail.counterparty!.name || detail.counterparty!.guid,
          fullName: detail.counterparty!.fullName ?? null,
          inn: detail.counterparty!.inn ?? null,
          kpp: detail.counterparty!.kpp ?? null,
          isActive: true,
          sourceUpdatedAt,
          lastSyncedAt: sourceUpdatedAt,
        },
        update: {
          name: detail.counterparty!.name || detail.counterparty!.guid,
          fullName: detail.counterparty!.fullName ?? null,
          inn: detail.counterparty!.inn ?? null,
          kpp: detail.counterparty!.kpp ?? null,
          sourceUpdatedAt,
          lastSyncedAt: sourceUpdatedAt,
        },
        select: { id: true },
      });
      const organization = detail.organization?.guid
        ? await tx.organization.upsert({
            where: { guid: detail.organization.guid },
            create: {
              guid: detail.organization.guid,
              name: detail.organization.name || detail.organization.guid,
              code: detail.organization.code ?? null,
              isActive: detail.organization.isActive ?? true,
              sourceUpdatedAt,
              lastSyncedAt: sourceUpdatedAt,
            },
            update: {
              name: detail.organization.name || detail.organization.guid,
              code: detail.organization.code ?? null,
              isActive: detail.organization.isActive ?? true,
              sourceUpdatedAt,
              lastSyncedAt: sourceUpdatedAt,
            },
            select: { id: true },
          })
        : null;

      return tx.order.create({
        data: {
          guid: orderGuid,
          number1c: detail.number1c,
          date1c: dateOrNull(detail.date1c),
          source: 'MANAGER_APP',
          revision: Math.max(1, Number(detail.revision) || 1),
          syncState: 'SYNCED',
          status: shadowOrderStatus(detail.status),
          counterpartyId: counterparty.id,
          organizationId: organization?.id ?? null,
          createdByUserId: userId,
          comment: detail.comment,
          deliveryDate: dateOrNull(detail.deliveryDate),
          paymentForm: detail.paymentForm,
          deliveryMethod: detail.deliveryMethod,
          totalAmount: detail.totalAmount,
          currency: detail.currency,
          sentTo1cAt: dateOrNull(detail.sentTo1cAt),
          lastStatusSyncAt: sourceUpdatedAt,
          isPostedIn1c: detail.isPostedIn1c,
          hasRealization: detail.hasRealization,
          invoiceRequested: false,
          realizationDetectedAt: detail.hasRealization ? sourceUpdatedAt : null,
          last1cSnapshot: JSON.parse(JSON.stringify({ item: detail, invoiceShadow: true })),
          sourceUpdatedAt,
          lastSyncedAt: sourceUpdatedAt,
        },
        select: accessibleOrderSelect,
      });
    });
  } catch {
    return prisma.order.findFirst({
      where: {
        OR: [
          { guid: orderGuid },
          ...(detail.number1c ? [{ number1c: detail.number1c }] : []),
        ],
      },
      select: accessibleOrderSelect,
    });
  }
}

async function managerGuidForUser(userId: number) {
  const profile = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { onecUserGuid: true },
  });
  return normalizedString(profile?.onecUserGuid);
}

async function isOrderVisibleToManager(order: AccessibleOrder, managerGuid: string) {
  const snapshot = snapshotIdentity(order.last1cSnapshot);
  if (snapshot.managerGuid && snapshot.managerGuid === managerGuid) return true;

  try {
    return Boolean(await findLiveClientOrder({
      managerGuid,
      appGuid: order.guid || snapshot.appGuid || null,
      number1c: order.number1c || snapshot.number1c || null,
    }));
  } catch {
    return false;
  }
}

async function findOrderThroughLiveDocument(identifier: string, managerGuid: string, userId: number) {
  try {
    const detail = await getLiveClientOrder(identifier, { managerGuid });
    const visible = await findLiveClientOrder({
      managerGuid,
      appGuid: detail.appGuid,
      number1c: detail.number1c,
    });
    if (!visible) return null;
    const existing = await prisma.order.findFirst({
      where: {
        OR: [
          ...(detail.appGuid ? [{ guid: detail.appGuid }] : []),
          ...(detail.documentGuid ? [{ guid: detail.documentGuid }] : []),
          ...(detail.number1c ? [{ number1c: detail.number1c }] : []),
        ],
      },
      select: accessibleOrderSelect,
    });
    return existing ?? createInvoiceShadowOrder(detail, userId);
  } catch {
    return null;
  }
}

async function resolveAccessibleOrder(identifier: string, userId: number) {
  let order = await findOrderByInvoiceIdentifier(identifier);
  if (order?.createdByUserId === userId) return order;

  const managerGuid = await managerGuidForUser(userId);
  if (!managerGuid) return null;
  if (order && await isOrderVisibleToManager(order, managerGuid)) return order;

  if (!order) order = await findOrderThroughLiveDocument(identifier, managerGuid, userId);
  if (order && (order.createdByUserId === userId || await isOrderVisibleToManager(order, managerGuid))) return order;
  return null;
}

function mapInvoice(invoice: {
  id: string;
  realizationGuid: string;
  realizationNumber: string | null;
  realizationDate: Date | null;
  version: number;
  state: string;
  waitReason: string | null;
  lastError: string | null;
  s3Key: string | null;
  fileName: string | null;
  sentAt: Date | null;
}) {
  return {
    id: invoice.id,
    realizationGuid: invoice.realizationGuid,
    realizationNumber: invoice.realizationNumber,
    realizationDate: invoice.realizationDate,
    version: invoice.version,
    state: invoice.state,
    waitReason: invoice.waitReason ?? invoice.lastError,
    downloadAvailable: Boolean(invoice.s3Key),
    fileName: invoice.fileName,
    sentAt: invoice.sentAt,
  };
}

export async function listClientOrderInvoices(guid: string, userId: number) {
  const order = await resolveAccessibleOrder(guid, userId);
  if (!order) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }
  const invoices = await prisma.clientOrderInvoice.findMany({
    where: { orderId: order.id, state: { notIn: ['SUPERSEDED', 'CANCELLED'] } },
    orderBy: [{ realizationGuid: 'asc' }, { version: 'desc' }, { updatedAt: 'desc' }],
    select: publicInvoiceSelect,
  });
  return { items: invoices.map(mapInvoice) };
}

export async function requestClientOrderInvoice(guid: string, userId: number) {
  const startedAt = Date.now();
  const order = await resolveAccessibleOrder(guid, userId);
  if (!order?.guid) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }

  try {
    const requested = await requestOnecLpAppClientOrderInvoice(order.guid);
    const queueItems = requested.items ?? [];
    const immediateProtocol = requested.protocolVersion === '2026-08-05-immediate-invoice-v2';
    for (const item of queueItems) await syncQueueItem(item, { immediate: immediateProtocol });

    // A manual request is an explicit user action, so it must not wait for the
    // periodic worker tick. The regular worker remains a recovery mechanism for
    // automatic 1C events, restarts and transient failures.
    const tokens = [...new Set(queueItems.map((item) => item.token).filter(Boolean))];
    let processedImmediately = 0;
    if (tokens.length) {
      const candidates = await prisma.clientOrderInvoice.findMany({
        where: {
          orderId: order.id,
          token: { in: tokens },
          state: 'QUEUED',
          ...(immediateProtocol ? {} : { OR: [{ readyAt: null }, { readyAt: { lte: new Date() } }] }),
        },
        select: { id: true },
      });
      for (const candidate of candidates) await processInvoice(candidate.id);
      processedImmediately = candidates.length;
    }

    const result = await listClientOrderInvoices(guid, userId);
    const protocolVersion = requested.protocolVersion ?? 'legacy';
    const diagnostics = {
      orderGuid: order.guid,
      protocolVersion,
      queueItems: queueItems.length,
      processedImmediately,
      elapsedMs: Date.now() - startedAt,
    };
    if (protocolVersion !== '2026-08-05-immediate-invoice-v2') {
      console.warn('[client-order-invoice] 1C invoice protocol is outdated', diagnostics);
    } else {
      console.info('[client-order-invoice] manual request completed', diagnostics);
    }

    return {
      requested: requested.requested !== false,
      message: requested.message ?? 'Формирование счёта запрошено',
      ...result,
    };
  } catch (error) {
    if (error instanceof OnecLpAppHttpError && error.upstreamStatus === 409) {
      throw new ClientOrdersError(409, ErrorCodes.CONFLICT, error.message);
    }
    const message = error instanceof Error ? error.message : 'Не удалось запросить счёт в 1С';
    throw new ClientOrdersError(502, ErrorCodes.INTERNAL_ERROR, message);
  }
}

export async function downloadClientOrderInvoice(guid: string, invoiceId: string, userId: number) {
  const order = await resolveAccessibleOrder(guid, userId);
  if (!order) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, `Заказ ${guid} не найден`);
  }
  const invoice = await prisma.clientOrderInvoice.findFirst({
    where: {
      id: invoiceId,
      orderId: order.id,
      s3Key: { not: null },
    },
    select: { s3Key: true, fileName: true, contentType: true },
  });
  if (!invoice?.s3Key) {
    throw new ClientOrdersError(404, ErrorCodes.NOT_FOUND, 'Счёт ещё не сформирован или не найден');
  }
  const file = await downloadBuffer(invoice.s3Key);
  return {
    body: file.body,
    contentType: invoice.contentType || file.contentType || 'application/pdf',
    fileName: invoice.fileName || `invoice_${invoiceId}.pdf`,
  };
}
