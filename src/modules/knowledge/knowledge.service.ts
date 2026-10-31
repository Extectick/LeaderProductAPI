import { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { explainServiceAccessForUser } from '../../services/serviceAccess';
import { KnowledgeError, SOURCE_FRESH_MS, knowledgeConfig, supportedExtension } from './knowledge.config';
import { KnowledgeDav } from './knowledge.dav';
import { lockKnowledgeDocument, lockKnowledgeSource } from './knowledge.worker';

export type KnowledgeActor = { userId: number; canManage: boolean; departmentIds: number[] };
export async function knowledgeActor(userId: number): Promise<KnowledgeActor> {
  const [user, access] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true, profileStatus: true, employeeProfile: { select: { status: true } } } }),
    explainServiceAccessForUser(userId, { serviceKey: 'help' }),
  ]);
  if (!user || !user.isActive || user.deletedAt || user.profileStatus === 'BLOCKED' || user.employeeProfile?.status === 'BLOCKED' ||
      !access?.access.enabled || !access.access.visible || (!access.access.isEmployee && !access.access.isAdmin)) {
    throw new KnowledgeError(403, 'KNOWLEDGE_FORBIDDEN', 'Нет доступа к базе знаний');
  }
  const permission = await prisma.rolePermissions.findFirst({ where: { roleId: { in: access.context.roleAssignments.map(x => x.roleId) }, permission: { name: 'manage_knowledge' } } });
  return { userId, canManage: access.access.isAdmin || !!permission,
    departmentIds: [...new Set(access.context.departmentAssignments.map(x => x.departmentId))] };
}
export function requireKnowledgeManager(actor: KnowledgeActor) {
  if (!actor.canManage) throw new KnowledgeError(403, 'KNOWLEDGE_MANAGE_REQUIRED', 'Требуется право управления базой знаний');
}
export function knowledgeAccessWhere(actor: KnowledgeActor): Prisma.KnowledgeDocumentWhereInput {
  return actor.canManage ? {} : { OR: [{ allEmployees: true }, { allowedUserIds: { has: actor.userId } }, { allowedDepartmentIds: { hasSome: actor.departmentIds } }] };
}
export function knowledgeSourceWhere(): Prisma.KnowledgeSourceWhereInput {
  const config = knowledgeConfig();
  return { key: config.key, configFingerprint: config.fingerprint, enabled: true, lastErrorCode: null,
    lastSuccessAt: { gt: new Date(Date.now() - SOURCE_FRESH_MS) } };
}
export const documentDto = (row: any) => ({ id: row.id, sourceId: row.sourceId, path: row.path, title: row.title,
  section: row.section, size: Number(row.size), mimeType: row.mimeType, currentRevision: row.currentRevision,
  publishedRevision: row.publishedRevision, publishedAt: row.publishedAt, deletedAt: row.deletedAt,
  allEmployees: row.allEmployees, allowedUserIds: row.allowedUserIds, allowedDepartmentIds: row.allowedDepartmentIds,
  updatedAt: row.updatedAt, versions: row.versions });

export async function knowledgeDocument(id: string) {
  const document = await prisma.knowledgeDocument.findFirst({ where: { id, source: { key: knowledgeConfig().key } } });
  if (!document) throw new KnowledgeError(404, 'KNOWLEDGE_NOT_FOUND', 'Документ не найден');
  return document;
}
export type PublicationInput = { versionId: string; allEmployees: boolean; userIds: number[]; departmentIds: number[] };
export async function publishKnowledge(id: string, input: PublicationInput, actor: KnowledgeActor, dav = new KnowledgeDav(knowledgeConfig())) {
  requireKnowledgeManager(actor);
  const document = await knowledgeDocument(id);
  const live = await dav.stat(document.path);
  return prisma.$transaction(async tx => {
    await lockKnowledgeSource(tx, document.sourceId); await lockKnowledgeDocument(tx, id);
    const doc = await tx.knowledgeDocument.findUniqueOrThrow({ where: { id } });
    const source = await tx.knowledgeSource.findFirst({ where: { id: doc.sourceId, ...knowledgeSourceWhere() } });
    const version = await tx.knowledgeVersion.findFirst({ where: { id: input.versionId, documentId: id, revision: doc.currentRevision, status: 'READY' } });
    if (!source || doc.deletedAt || doc.section !== 'COMPANY' || !version || live.remoteId !== doc.remoteId || live.etag !== doc.etag || live.path !== doc.path || version.etag !== doc.etag) {
      throw new KnowledgeError(409, 'KNOWLEDGE_VERSION_CHANGED', 'Документ изменён, недоступен или ещё не готов к публикации');
    }
    const [users, departments] = await Promise.all([
      tx.user.count({ where: { id: { in: input.userIds }, isActive: true, deletedAt: null } }),
      tx.department.count({ where: { id: { in: input.departmentIds } } }),
    ]);
    if (users !== input.userIds.length || departments !== input.departmentIds.length) throw new KnowledgeError(400, 'KNOWLEDGE_INVALID_AUDIENCE', 'Проверьте список пользователей и отделов');
    await tx.knowledgeDocument.update({ where: { id }, data: { publishedRevision: version.revision, publishedAt: new Date(), publishedById: actor.userId,
      allEmployees: input.allEmployees, allowedUserIds: input.userIds, allowedDepartmentIds: input.departmentIds } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: doc.sourceId, documentId: id, versionId: version.id, actorId: actor.userId,
      action: 'PUBLISHED', detail: { revision: version.revision, allEmployees: input.allEmployees, userIds: input.userIds, departmentIds: input.departmentIds } } });
    return { publishedRevision: version.revision };
  });
}
export async function revokeKnowledge(id: string, actor: KnowledgeActor) {
  requireKnowledgeManager(actor);
  const document = await knowledgeDocument(id);
  return prisma.$transaction(async tx => {
    await lockKnowledgeSource(tx, document.sourceId); await lockKnowledgeDocument(tx, id);
    await tx.knowledgeDocument.update({ where: { id }, data: { publishedRevision: null, publishedAt: null, publishedById: null } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: document.sourceId, documentId: id, actorId: actor.userId, action: 'REVOKED', detail: {} } });
  });
}
export async function retryKnowledge(id: string, actor: KnowledgeActor) {
  requireKnowledgeManager(actor);
  const document = await knowledgeDocument(id);
  await prisma.$transaction(async tx => {
    await lockKnowledgeSource(tx, document.sourceId); await lockKnowledgeDocument(tx, id);
    const doc = await tx.knowledgeDocument.findUniqueOrThrow({ where: { id } });
    const version = await tx.knowledgeVersion.findUnique({ where: { documentId_revision: { documentId: id, revision: doc.currentRevision } } });
    if (doc.deletedAt || !['COMPANY', 'AI_WORKSPACE'].includes(doc.section) || !supportedExtension(doc.path) || !version || version.status !== 'ERROR') {
      throw new KnowledgeError(409, 'KNOWLEDGE_RETRY_UNAVAILABLE', 'Повтор доступен для текущей версии с ошибкой обработки');
    }
    await tx.knowledgeIngestionJob.update({ where: { versionId: version.id }, data: { status: 'QUEUED', attempts: 0, nextAt: new Date(), leaseToken: null, leaseUntil: null, errorCode: null } });
    await tx.knowledgeVersion.update({ where: { id: version.id }, data: { status: 'QUEUED', errorCode: null } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: doc.sourceId, documentId: id, versionId: version.id, actorId: actor.userId, action: 'RETRY_REQUESTED', detail: {} } });
  });
}
export type KnowledgeSearchRelevance = { terms: string[]; requiredTerms: string[]; minCoverage: number };
export async function searchKnowledge(query: string, actor: KnowledgeActor, limit = 10, sharedOnly = false, relevance?: KnowledgeSearchRelevance) {
  if (!query.trim() || query.length > 300 || limit < 1 || limit > 20) throw new KnowledgeError(400, 'KNOWLEDGE_INVALID_QUERY');
  const config = knowledgeConfig();
  const acl = actor.canManage ? Prisma.sql`TRUE` : Prisma.sql`(d."allEmployees"=true OR ${actor.userId}=ANY(d."allowedUserIds") OR d."allowedDepartmentIds" && ARRAY[${Prisma.join(actor.departmentIds.length ? actor.departmentIds : [-1])}]::int[])`;
  const coverage = relevance?.terms.length ? Prisma.sql`(SELECT count(*) FILTER (WHERE c."searchVector" @@ term)::float / greatest(count(*),1)
    FROM (SELECT DISTINCT plainto_tsquery('russian',word) || plainto_tsquery('simple',word) AS term
      FROM unnest(ARRAY[${Prisma.join(relevance.terms)}]::text[]) word) terms)` : Prisma.sql`1.0`;
  const required = relevance?.requiredTerms.length ? Prisma.sql`AND c."searchVector" @@ plainto_tsquery('simple',${relevance.requiredTerms.join(' ')})` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ chunkId: string; documentId: string; versionId: string; revision: number; title: string; path: string; text: string; score: number }>>`
    SELECT c."id" AS "chunkId",d."id" AS "documentId",v."id" AS "versionId",v."revision",d."title",d."path",c."text",ts_rank_cd(c."searchVector",q.term) AS score
    FROM "KnowledgeChunk" c JOIN "KnowledgeVersion" v ON v."id"=c."versionId" JOIN "KnowledgeDocument" d ON d."id"=v."documentId"
      JOIN "KnowledgeSource" s ON s."id"=d."sourceId",
      (SELECT websearch_to_tsquery('russian',${query}) || websearch_to_tsquery('simple',${query}) AS term) q
    WHERE s."key"=${config.key} AND s."configFingerprint"=${config.fingerprint} AND s."enabled"=true AND s."lastErrorCode" IS NULL
      AND s."lastSuccessAt">${new Date(Date.now() - SOURCE_FRESH_MS)} AND d."deletedAt" IS NULL AND d."section"='COMPANY'
      AND d."publishedRevision"=v."revision" AND d."currentRevision"=v."revision" AND v."status"='READY' AND ${acl}
      ${sharedOnly ? Prisma.sql`AND d."allEmployees"=true` : Prisma.empty} AND c."searchVector" @@ q.term
      AND ${coverage} >= ${relevance?.minCoverage ?? 0} ${required}
    ORDER BY ${coverage} DESC,score DESC,d."id",c."ordinal" LIMIT ${limit}`;
  return rows.map(({ text, ...row }) => ({ ...row, excerpt: text, sourceUrl: `/knowledge/documents/${row.documentId}/published` }));
}
export async function publishedKnowledge(id: string, actor: KnowledgeActor) {
  const config = knowledgeConfig();
  const acl = actor.canManage ? Prisma.sql`TRUE` : Prisma.sql`(d."allEmployees"=true OR ${actor.userId}=ANY(d."allowedUserIds") OR d."allowedDepartmentIds" && ARRAY[${Prisma.join(actor.departmentIds.length ? actor.departmentIds : [-1])}]::int[])`;
  // One statement observes publication, source freshness, ACL and version content together.
  const rows = await prisma.$queryRaw<Array<{ documentId: string; title: string; path: string; versionId: string; revision: number; text: string }>>`
    SELECT d."id" AS "documentId",d."title",d."path",v."id" AS "versionId",v."revision",v."text"
    FROM "KnowledgeDocument" d JOIN "KnowledgeSource" s ON s."id"=d."sourceId"
      JOIN "KnowledgeVersion" v ON v."documentId"=d."id" AND v."revision"=d."publishedRevision" AND v."revision"=d."currentRevision"
    WHERE d."id"=${id} AND s."key"=${config.key} AND s."configFingerprint"=${config.fingerprint} AND s."enabled"=true
      AND s."lastErrorCode" IS NULL AND s."lastSuccessAt">${new Date(Date.now() - SOURCE_FRESH_MS)}
      AND d."deletedAt" IS NULL AND d."section"='COMPANY' AND v."status"='READY' AND ${acl}`;
  if (!rows[0]) throw new KnowledgeError(404, 'KNOWLEDGE_NOT_FOUND', 'Материал недоступен');
  return rows[0];
}
