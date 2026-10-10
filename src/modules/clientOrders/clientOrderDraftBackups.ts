import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prisma/client';
import { clientOrderCreateSchema } from './clientOrders.schemas';

// A recovery copy is not a valid order yet: incomplete fields and empty lines are allowed.
const snapshot = z.record(z.string(), z.unknown()).refine(
  value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2 * 1024 * 1024,
  'Черновик превышает допустимый размер'
);
export const draftBackupSchema = z.object({
  clientRevision: z.number().int().min(1),
  payload: snapshot,
  order: snapshot.optional(),
});

export class DraftBackupConflict extends Error {
  constructor() { super('На сервере уже сохранена другая версия черновика. Локальная копия сохранена.'); }
}

export function draftBackupHash(payload: Record<string, unknown>) {
  // Transport/review choices do not change the commercial contents of the draft.
  const parsed = clientOrderCreateSchema.safeParse(payload);
  const canonical = parsed.success ? parsed.data : payload;
  const { intent, clientRevision, offlineReview, integrity, saveReason, geoEvents, ...content } = canonical as Record<string, unknown>;
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(JSON.parse(JSON.stringify(content))))).digest('hex');
}

export async function saveDraftBackup(userId: number, clientOrderId: string, data: z.infer<typeof draftBackupSchema>) {
  const payloadHash = draftBackupHash(data.payload);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`WITH draft_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${`draft-backup:${userId}:${clientOrderId}`}, 0))
    ) SELECT 1::integer AS locked FROM draft_lock`;
    const where = { userId_clientOrderId: { userId, clientOrderId } };
    const previous = await tx.clientOrderDraftBackup.findUnique({ where });
    if (previous && data.clientRevision < previous.clientRevision) throw new DraftBackupConflict();
    if (previous && data.clientRevision === previous.clientRevision && payloadHash !== previous.payloadHash) throw new DraftBackupConflict();
    const updated = !previous || data.clientRevision > previous.clientRevision;
    const values = {
      clientRevision: data.clientRevision, payloadHash, payload: data.payload as Prisma.InputJsonValue,
      ...(data.order ? { orderSnapshot: data.order as Prisma.InputJsonValue } : {}),
      ...(updated ? { review: Prisma.DbNull, submittedOrderGuid: null } : {}),
    };
    const saved = await tx.clientOrderDraftBackup.upsert({ where,
      create: { userId, clientOrderId, ...values }, update: values });
    return { clientRevision: saved.clientRevision, savedAt: saved.updatedAt.toISOString(),
      submittedOrderGuid: saved.submittedOrderGuid };
  });
}

export function getDraftBackup(userId: number, clientOrderId: string) {
  return prisma.clientOrderDraftBackup.findUnique({ where: { userId_clientOrderId: { userId, clientOrderId } } });
}

export async function recordDraftReview(userId: number, clientOrderId: string, clientRevision: number, review: unknown) {
  await prisma.clientOrderDraftBackup.updateMany({ where: { userId, clientOrderId, clientRevision },
    data: { review: JSON.parse(JSON.stringify(review)) as Prisma.InputJsonValue } });
}

export async function markDraftSubmitted(userId: number, clientOrderId: string, clientRevision: number, guid: string) {
  await prisma.clientOrderDraftBackup.updateMany({ where: { userId, clientOrderId, clientRevision },
    data: { submittedOrderGuid: guid, review: Prisma.DbNull } });
}
