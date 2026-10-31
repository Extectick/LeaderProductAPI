import type { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { folderPublicationEnabled, knowledgeConfig, SOURCE_FRESH_MS } from './knowledge.config';

/** Caller holds source then document locks; manual ACLs and revocation take precedence. */
export async function publishFolderVersion(tx: Prisma.TransactionClient, document: {
  id: string; sourceId: string; section: string; deletedAt: Date | null; currentRevision: number; publishedRevision: number | null;
  allEmployees: boolean; allowedUserIds: number[]; allowedDepartmentIds: number[];
  source: { enabled: boolean; lastSuccessAt: Date | null; lastErrorCode: string | null; configFingerprint: string };
}, version: { id: string; revision: number; status: string }) {
  if (!folderPublicationEnabled() || document.section !== 'COMPANY' || document.deletedAt || version.status !== 'READY' ||
      document.currentRevision !== version.revision || document.publishedRevision === version.revision ||
      !document.source.enabled || document.source.lastErrorCode || !document.source.lastSuccessAt ||
      document.source.lastSuccessAt.getTime() <= Date.now() - SOURCE_FRESH_MS ||
      document.source.configFingerprint !== knowledgeConfig().fingerprint) return false;
  const [published, revoked] = await Promise.all([
    tx.knowledgeAuditEvent.findFirst({ where: { documentId: document.id, action: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    tx.knowledgeAuditEvent.findFirst({ where: { documentId: document.id, action: 'REVOKED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  if (revoked && (!published || revoked.createdAt >= published.createdAt)) return false;
  const defaultAudience = !published && !document.allowedUserIds.length && !document.allowedDepartmentIds.length;
  await tx.knowledgeDocument.update({ where: { id: document.id }, data: {
    publishedRevision: version.revision, publishedAt: new Date(), publishedById: null,
    ...(defaultAudience ? { allEmployees: true } : {}),
  } });
  await tx.knowledgeAuditEvent.create({ data: { sourceId: document.sourceId, documentId: document.id, versionId: version.id,
    action: 'FOLDER_PUBLISHED', detail: { revision: version.revision, allEmployees: defaultAudience || document.allEmployees, policy: 'company-folder' } } });
  return true;
}

/** Also handles READY documents indexed before folder mode was enabled. Bounded and idempotent. */
export async function reconcileFolderPublications(sourceId: string) {
  if (!folderPublicationEnabled()) return 0;
  const config = knowledgeConfig();
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>`SELECT d."id" FROM "KnowledgeDocument" d
    JOIN "KnowledgeVersion" v ON v."documentId"=d."id" AND v."revision"=d."currentRevision"
    JOIN "KnowledgeSource" s ON s."id"=d."sourceId"
    WHERE d."sourceId"=${sourceId} AND d."section"='COMPANY' AND d."deletedAt" IS NULL AND d."publishedRevision" IS NULL AND v."status"='READY'
      AND s."enabled"=true AND s."configFingerprint"=${config.fingerprint} AND s."lastErrorCode" IS NULL
      AND s."lastSuccessAt">${new Date(Date.now() - SOURCE_FRESH_MS)}
      AND NOT EXISTS (SELECT 1 FROM "KnowledgeAuditEvent" r WHERE r."documentId"=d."id" AND r."action"='REVOKED'
        AND NOT EXISTS (SELECT 1 FROM "KnowledgeAuditEvent" p WHERE p."documentId"=d."id" AND p."action"='PUBLISHED' AND p."createdAt">r."createdAt"))
    ORDER BY d."id" LIMIT 100`;
  let count = 0;
  for (const candidate of candidates) {
    count += await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "KnowledgeSource" WHERE "id"=${sourceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id"=${candidate.id} FOR UPDATE`;
      const document = await tx.knowledgeDocument.findUnique({ where: { id: candidate.id }, include: { source: true } });
      if (!document) return 0;
      const version = await tx.knowledgeVersion.findUnique({ where: { documentId_revision: { documentId: document.id, revision: document.currentRevision } },
        select: { id: true, revision: true, status: true } });
      return version && await publishFolderVersion(tx, document, version) ? 1 : 0;
    });
  }
  return count;
}
