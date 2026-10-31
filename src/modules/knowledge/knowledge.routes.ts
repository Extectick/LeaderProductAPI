import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { authenticateToken, AuthRequest } from '../../middleware/auth';
import { KnowledgeError, MAX_FILE_BYTES, knowledgeConfig, knowledgeEnabled, folderPublicationEnabled, safeErrorCode } from './knowledge.config';
import * as service from './knowledge.service';
import { lockKnowledgeSource } from './knowledge.worker';

const router = express.Router();
router.use((_req, res, next) => {
  if (!knowledgeEnabled()) return res.status(404).json({ code: 'KNOWLEDGE_DISABLED' });
  res.setHeader('Cache-Control', 'private, no-store'); next();
});
router.use(authenticateToken);
const route = (fn: (req: Request, res: Response, actor: service.KnowledgeActor) => Promise<any>, manager = false) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(async () => {
      const actor = await service.knowledgeActor((req as AuthRequest).user!.userId);
      if (manager) service.requireKnowledgeManager(actor);
      return fn(req, res, actor);
    }).catch(next);
  };
const id = (req: Request) => z.string().uuid().parse(req.params.id);
const audience = z.array(z.number().int().positive()).max(200).refine(items => new Set(items).size === items.length).default([]);
router.get('/config', route(async (_req, res, actor) => res.json({ canManage: actor.canManage, formats: ['md','txt','pdf','docx'], maxFileBytes: MAX_FILE_BYTES, searchMode: 'fulltext', autoPublish: folderPublicationEnabled() })));
// Publication pickers expose names only and require the same privilege as publishing.
router.get('/audience', route(async (req, res) => {
  const query = z.object({ kind: z.enum(['user','department']), q: z.string().trim().max(100).default(''),
    cursor: z.coerce.number().int().positive().optional(),
    ids: z.string().max(2200).regex(/^\d+(,\d+)*$/).transform(value => value.split(',').map(Number))
      .refine(ids => ids.length <= 200 && ids.every(id => Number.isSafeInteger(id) && id > 0)).optional() }).strict().parse(req.query);
  const idFilter = query.ids ? { in: query.ids } : query.cursor ? { gt: query.cursor } : undefined;
  if (query.kind === 'department') {
    const rows = await prisma.department.findMany({ where: { id: idFilter, name: { contains: query.q, mode: 'insensitive' } },
      select: { id: true, name: true }, orderBy: { id: 'asc' }, take: query.ids ? 200 : 41 });
    return res.json({ items: rows.slice(0, query.ids ? 200 : 40), nextCursor: !query.ids && rows.length > 40 ? rows[39].id : null });
  }
  const rows = await prisma.user.findMany({ where: { id: idFilter, isActive: true, deletedAt: null, profileStatus: { not: 'BLOCKED' },
    AND: [{ OR: [{ employeeProfile: { status: { not: 'BLOCKED' } } }, { role: { name: 'admin' } }] },
      ...query.q.split(/\s+/).filter(Boolean).map(word => ({ OR: ['firstName','lastName','middleName'].map(field => ({ [field]: { contains: word, mode: 'insensitive' } })) }))] },
    select: { id: true, firstName: true, lastName: true, middleName: true, employeeProfile: { select: { department: { select: { name: true } } } } },
    orderBy: { id: 'asc' }, take: query.ids ? 200 : 41 });
  res.json({ items: rows.slice(0, query.ids ? 200 : 40).map(user => ({ id: user.id,
    name: [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || `Сотрудник №${user.id}`,
    description: user.employeeProfile?.department?.name || '' })), nextCursor: !query.ids && rows.length > 40 ? rows[39].id : null });
}, true));
router.get('/sources', route(async (_req, res) => res.json(await prisma.knowledgeSource.findMany({ where: { key: knowledgeConfig().key },
  select: { id: true, key: true, name: true, enabled: true, lastScanAt: true, lastSuccessAt: true, lastErrorCode: true, nextScanAt: true } })), true));
router.post('/sources/:id/sync', route(async (req, res, actor) => {
  z.object({}).strict().parse(req.body || {});
  const source = await prisma.knowledgeSource.findFirst({ where: { id: id(req), key: knowledgeConfig().key } });
  if (!source) throw new KnowledgeError(404, 'KNOWLEDGE_NOT_FOUND');
  await prisma.$transaction(async tx => {
    await lockKnowledgeSource(tx, source.id);
    await tx.knowledgeSource.update({ where: { id: source.id }, data: { nextScanAt: new Date() } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: source.id, actorId: actor.userId, action: 'SCAN_REQUESTED', detail: {} } });
  });
  res.status(202).json({ queued: true });
}, true));
router.patch('/sources/:id', route(async (req, res, actor) => {
  const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  const source = await prisma.knowledgeSource.findFirst({ where: { id: id(req), key: knowledgeConfig().key } });
  if (!source) throw new KnowledgeError(404, 'KNOWLEDGE_NOT_FOUND');
  await prisma.$transaction(async tx => {
    await lockKnowledgeSource(tx, source.id);
    await tx.knowledgeSource.update({ where: { id: source.id }, data: { enabled: body.enabled, nextScanAt: new Date(),
      lastSuccessAt: null, scanLeaseUntil: null, scanLeaseToken: null } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: source.id, actorId: actor.userId, action: body.enabled ? 'SOURCE_ENABLED' : 'SOURCE_DISABLED', detail: {} } });
  });
  res.json({ enabled: body.enabled });
}, true));
router.get('/documents', route(async (req, res) => {
  const query = z.object({ section: z.enum(['COMPANY','AI_WORKSPACE','ARCHIVE','OTHER']).optional(),
    view: z.enum(['all','pending','published','processing','errors']).default('all'),
    deleted: z.enum(['hide','show']).default('hide'),
    status: z.enum(['QUEUED','PROCESSING','READY','ERROR','SKIPPED']).optional(), q: z.string().trim().max(100).optional(),
    cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(req.query);
  const matches = await prisma.$queryRaw<Array<{ id: string }>>`SELECT d."id" FROM "KnowledgeDocument" d JOIN "KnowledgeSource" s ON s."id"=d."sourceId"
    WHERE s."key"=${knowledgeConfig().key}
      ${query.deleted === 'hide' ? Prisma.sql`AND d."deletedAt" IS NULL` : Prisma.empty}
      ${query.view === 'published' ? Prisma.sql`AND d."publishedRevision" IS NOT NULL` : Prisma.empty}
      ${query.view === 'pending' ? Prisma.sql`AND d."section"='COMPANY' AND d."publishedRevision" IS NULL AND EXISTS (SELECT 1 FROM "KnowledgeVersion" v WHERE v."documentId"=d."id" AND v."revision"=d."currentRevision" AND v."status"='READY')` : Prisma.empty}
      ${query.view === 'processing' ? Prisma.sql`AND EXISTS (SELECT 1 FROM "KnowledgeVersion" v WHERE v."documentId"=d."id" AND v."revision"=d."currentRevision" AND v."status" IN ('QUEUED','PROCESSING'))` : Prisma.empty}
      ${query.view === 'errors' ? Prisma.sql`AND EXISTS (SELECT 1 FROM "KnowledgeVersion" v WHERE v."documentId"=d."id" AND v."revision"=d."currentRevision" AND v."status"='ERROR')` : Prisma.empty}
      ${query.section ? Prisma.sql`AND d."section"=${query.section}` : Prisma.empty}
      ${query.q ? Prisma.sql`AND position(lower(${query.q}) in lower(d."path"))>0` : Prisma.empty}
      ${query.cursor ? Prisma.sql`AND d."id">${query.cursor}` : Prisma.empty}
      ${query.status ? Prisma.sql`AND EXISTS (SELECT 1 FROM "KnowledgeVersion" v WHERE v."documentId"=d."id" AND v."revision"=d."currentRevision" AND v."status"=${query.status})` : Prisma.empty}
    ORDER BY d."id" LIMIT ${query.limit + 1}`;
  const docs = await prisma.knowledgeDocument.findMany({ where: { id: { in: matches.map(x => x.id) } },
    orderBy: { id: 'asc' },
    include: { versions: { orderBy: { revision: 'desc' }, take: 1, select: { id: true, revision: true, status: true, errorCode: true, createdAt: true, extractedAt: true } } } });
  res.json({ documents: docs.slice(0, query.limit).map(service.documentDto), nextCursor: docs.length > query.limit ? docs[query.limit - 1].id : null });
}, true));
router.get('/documents/:id', route(async (req, res) => {
  const document = await service.knowledgeDocument(id(req));
  const versions = await prisma.knowledgeVersion.findMany({ where: { documentId: document.id }, orderBy: { revision: 'desc' }, take: 1,
    select: { id: true, revision: true, status: true, errorCode: true, createdAt: true, extractedAt: true } });
  res.json(service.documentDto({ ...document, versions }));
}, true));
router.get('/documents/:id/versions', route(async (req, res) => {
  const document = await service.knowledgeDocument(id(req));
  const query = z.object({ before: z.coerce.number().int().positive().optional() }).strict().parse(req.query);
  const versions = await prisma.knowledgeVersion.findMany({ where: { documentId: document.id, revision: query.before ? { lt: query.before } : undefined },
    orderBy: { revision: 'desc' }, take: 21, select: { id: true, revision: true, status: true, errorCode: true, createdAt: true, extractedAt: true } });
  res.json({ versions: versions.slice(0, 20), nextBefore: versions.length > 20 ? versions[19].revision : null });
}, true));
router.get('/documents/:id/versions/:revision', route(async (req, res) => {
  const document = await service.knowledgeDocument(id(req));
  const revision = z.coerce.number().int().positive().parse(req.params.revision);
  const version = await prisma.knowledgeVersion.findUnique({ where: { documentId_revision: { documentId: document.id, revision } } });
  if (!version) throw new KnowledgeError(404, 'KNOWLEDGE_NOT_FOUND');
  res.json({ document: service.documentDto(document), version });
}, true));
router.get('/documents/:id/audit', route(async (req, res) => {
  const document = await service.knowledgeDocument(id(req));
  res.json(await prisma.knowledgeAuditEvent.findMany({ where: { documentId: document.id }, orderBy: { createdAt: 'desc' }, take: 100 }));
}, true));
router.post('/documents/:id/publish', route(async (req, res, actor) => {
  const body = z.object({ versionId: z.string().uuid(), allEmployees: z.boolean().default(false), userIds: audience, departmentIds: audience }).strict().parse(req.body);
  res.json(await service.publishKnowledge(id(req), body, actor));
}, true));
router.post('/documents/:id/revoke', route(async (req, res, actor) => {
  z.object({}).strict().parse(req.body || {}); await service.revokeKnowledge(id(req), actor); res.json({ revoked: true });
}, true));
router.post('/documents/:id/retry', route(async (req, res, actor) => {
  z.object({}).strict().parse(req.body || {}); await service.retryKnowledge(id(req), actor); res.status(202).json({ queued: true });
}, true));
router.get('/search', route(async (req, res, actor) => {
  const query = z.object({ q: z.string().trim().min(1).max(300), limit: z.coerce.number().int().min(1).max(20).default(10) }).strict().parse(req.query);
  res.json({ mode: 'fulltext', results: await service.searchKnowledge(query.q, actor, query.limit) });
}));
router.get('/documents/:id/published', route(async (req, res, actor) => res.json(await service.publishedKnowledge(id(req), actor))));
router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof KnowledgeError) return res.status(error.status >= 400 && error.status < 600 ? error.status : 503).json({ code: error.code, message: error.message });
  if (error instanceof z.ZodError) return res.status(400).json({ code: 'KNOWLEDGE_VALIDATION_ERROR', message: 'Проверьте поля запроса' });
  console.error('[knowledge] request failed', { code: safeErrorCode(error) });
  res.status(500).json({ code: 'KNOWLEDGE_INTERNAL_ERROR', message: 'Не удалось выполнить действие' });
});
export default router;
