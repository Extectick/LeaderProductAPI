import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prisma/client';
import { proveAcceptedSubmissionOperation } from './acceptedClientOperation';

export const clientOrderStatesSchema = z.object({
  identifiers: z.array(z.string().trim().min(8).max(128)).min(1).max(50),
  proofClientOrderIds: z.array(z.string().trim().min(8).max(128)).max(50).default([]),
}).strict();

const select = {
  guid: true, clientOrderId: true, clientRevision: true, clientPayloadHash: true,
  createdByUserId: true, source: true, revision: true, status: true, syncState: true,
  number1c: true, date1c: true, isPostedIn1c: true, hasRealization: true,
  deliveryDate: true, totalAmount: true, lastExportError: true, last1cError: true,
  cancelRequestedAt: true, queuedAt: true, sentTo1cAt: true, updatedAt: true,
  _count: { select: { items: { where: { isCancelled: false } } } },
} satisfies Prisma.OrderSelect;

/** A bounded, owner-scoped READ. No live 1C, queue writes or receipt state changes.
 * A receipt's QUEUED means accepted for export, not the current state of its order. */
export async function getClientOrderStates(userId: number, identifiers: string[], proofClientOrderIds: string[] = []) {
  const parsed = clientOrderStatesSchema.parse({ identifiers, proofClientOrderIds });
  const ids = [...new Set(parsed.identifiers)];
  const orders = await prisma.order.findMany({ where: { createdByUserId: userId, source: 'MANAGER_APP',
    OR: [{ guid: { in: ids } }, { clientOrderId: { in: ids } }] }, select, take: 50 });
  const accepted = orders.filter(order => order.clientOrderId && order.clientRevision
    && parsed.proofClientOrderIds.includes(order.clientOrderId) && order.syncState === 'SYNCED' && order.isPostedIn1c);
  const receipts = accepted.length ? await prisma.clientOrderSubmission.findMany({
    where: { userId, state: 'QUEUED', OR: accepted.map(order => ({
      clientOrderId: order.clientOrderId!, clientRevision: order.clientRevision!, orderGuid: order.guid,
    })) }, select: { userId: true, clientOrderId: true, clientRevision: true, orderGuid: true,
      state: true, payloadHash: true, payload: true }, take: 50,
  }) : [];
  return { items: orders.map(order => {
    const { clientPayloadHash: _hash, createdByUserId, _count, ...state } = order;
    const receipt = receipts.find(row => row.clientOrderId === order.clientOrderId && row.clientRevision === order.clientRevision);
    return { ...state, appGuid: order.guid, createdByUser: { id: createdByUserId }, itemsCount: _count.items,
      totalAmount: order.totalAmount == null ? null : Number(order.totalAmount),
      acceptedClientOperation: proveAcceptedSubmissionOperation(order, receipt ?? null, userId) };
  }) };
}
