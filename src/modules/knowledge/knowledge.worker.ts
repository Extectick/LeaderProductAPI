import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { KnowledgeConfig, KnowledgeError, MAX_FILE_BYTES, SCAN_INTERVAL_MS, documentSection, knowledgeConfig, safeErrorCode, supportedExtension } from './knowledge.config';
import { DavEntry, KnowledgeDav } from './knowledge.dav';
import { chunkKnowledgeText, extractKnowledgeText } from './knowledge.extract';
import { publishFolderVersion, reconcileFolderPublications } from './knowledge.folder';

type Tx = Prisma.TransactionClient;
type Lease = { id: string; token: string };
export async function lockKnowledgeSource(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "KnowledgeSource" WHERE "id"=${id} FOR UPDATE`;
}
export async function lockKnowledgeDocument(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id"=${id} FOR UPDATE`;
}
async function assertScanLease(tx: Tx, lease: Lease) {
  const rows = await tx.$queryRaw<any[]>`SELECT "id" FROM "KnowledgeSource" WHERE "id"=${lease.id} AND "enabled"=true AND "scanLeaseToken"=${lease.token} AND "scanLeaseUntil">NOW() FOR UPDATE`;
  if (!rows.length) throw new KnowledgeError(409, 'SCAN_LEASE_LOST');
}

export async function ensureKnowledgeSource(config: KnowledgeConfig) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(181931, hashtext(${config.key}))`;
    let source = await tx.knowledgeSource.findUnique({ where: { key: config.key } });
    if (!source) return tx.knowledgeSource.create({ data: { key: config.key, name: config.name, configFingerprint: config.fingerprint } });
    await lockKnowledgeSource(tx, source.id);
    if (source.configFingerprint !== config.fingerprint) {
      await tx.knowledgeDocument.updateMany({ where: { sourceId: source.id }, data: { deletedAt: new Date(), publishedRevision: null, publishedAt: null } });
      source = await tx.knowledgeSource.update({ where: { id: source.id }, data: { configFingerprint: config.fingerprint,
        lastSuccessAt: null, lastErrorCode: 'SOURCE_RECONFIGURED', nextScanAt: new Date(), scanLeaseToken: null, scanLeaseUntil: null } });
      await tx.knowledgeAuditEvent.create({ data: { sourceId: source.id, action: 'SOURCE_RECONFIGURED', detail: {} } });
    }
    return source;
  });
}

export async function claimKnowledgeScan(sourceId: string): Promise<Lease | null> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<{ id: string }[]>`UPDATE "KnowledgeSource" SET "scanLeaseToken"=${token}, "scanLeaseUntil"=NOW()+INTERVAL '90 seconds', "lastScanAt"=NOW(), "updatedAt"=NOW()
    WHERE "id"=${sourceId} AND "enabled"=true AND "nextScanAt"<=NOW() AND ("scanLeaseUntil" IS NULL OR "scanLeaseUntil"<NOW()) RETURNING "id"`;
  return rows.length ? { id: sourceId, token } : null;
}

async function observeEntry(lease: Lease, entry: DavEntry) {
  await prisma.$transaction(async tx => {
    await assertScanLease(tx, lease);
    let document = await tx.knowledgeDocument.findUnique({ where: { sourceId_remoteId: { sourceId: lease.id, remoteId: entry.remoteId } } });
    if (document) await lockKnowledgeDocument(tx, document.id);
    const section = documentSection(entry.path);
    const changed = !document || document.etag !== entry.etag || document.path !== entry.path || !!document.deletedAt;
    const common = { path: entry.path, title: entry.path.split('/').pop()!, section, etag: entry.etag,
      size: entry.size, mimeType: entry.mimeType, seenScanId: lease.token, lastSeenAt: new Date(), deletedAt: null };
    if (!document) {
      document = await tx.knowledgeDocument.create({ data: { ...common, sourceId: lease.id, remoteId: entry.remoteId, currentRevision: 1 } });
    } else {
      document = await tx.knowledgeDocument.update({ where: { id: document.id }, data: { ...common,
        ...(changed ? { currentRevision: { increment: 1 }, publishedRevision: null, publishedAt: null, publishedById: null } : {}) } });
    }
    if (!changed) return;
    await tx.knowledgeIngestionJob.updateMany({ where: { version: { documentId: document.id }, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null } });
    await tx.knowledgeVersion.updateMany({ where: { documentId: document.id, status: { in: ['QUEUED','PROCESSING'] } },
      data: { status: 'SKIPPED', errorCode: 'VERSION_SUPERSEDED' } });
    const eligible = section === 'COMPANY' || section === 'AI_WORKSPACE';
    const errorCode = !eligible ? 'EXCLUDED_SECTION' : !supportedExtension(entry.path) ? 'UNSUPPORTED_FORMAT' :
      entry.size > BigInt(MAX_FILE_BYTES) ? 'DOCUMENT_TOO_LARGE' : null;
    const version = await tx.knowledgeVersion.create({ data: { documentId: document.id, revision: document.currentRevision,
      path: entry.path, etag: entry.etag, status: errorCode ? 'SKIPPED' : 'QUEUED', errorCode } });
    if (!errorCode) await tx.knowledgeIngestionJob.create({ data: { versionId: version.id } });
    await tx.knowledgeAuditEvent.create({ data: { sourceId: lease.id, documentId: document.id, versionId: version.id,
      action: 'VERSION_DISCOVERED', detail: { revision: version.revision, section } } });
  }, { timeout: 15000 });
}

export async function scanKnowledgeSource(lease: Lease, dav: KnowledgeDav) {
  const heartbeat = async () => {
    const updated = await prisma.$executeRaw`UPDATE "KnowledgeSource" SET "scanLeaseUntil"=NOW()+INTERVAL '90 seconds'
      WHERE "id"=${lease.id} AND "enabled"=true AND "scanLeaseToken"=${lease.token} AND "scanLeaseUntil">NOW()`;
    if (!updated) throw new KnowledgeError(409, 'SCAN_LEASE_LOST');
  };
  try {
    const files = await dav.walk(heartbeat);
    // Missing files are removed only after the entire traversal and all observations succeed.
    for (const entry of files) { await heartbeat(); await observeEntry(lease, entry); }
    await prisma.$transaction(async tx => {
      await assertScanLease(tx, lease);
      const absent = { sourceId: lease.id, seenScanId: { not: lease.token }, deletedAt: null };
      await tx.knowledgeIngestionJob.updateMany({ where: { version: { document: absent }, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null } });
      await tx.knowledgeVersion.updateMany({ where: { document: absent, status: { in: ['QUEUED','PROCESSING'] } },
        data: { status: 'SKIPPED', errorCode: 'DOCUMENT_REMOVED' } });
      const removed = await tx.knowledgeDocument.updateMany({ where: absent,
        data: { deletedAt: new Date(), publishedRevision: null, publishedAt: null, publishedById: null } });
      await tx.knowledgeSource.update({ where: { id: lease.id }, data: { scanLeaseToken: null, scanLeaseUntil: null,
        lastSuccessAt: new Date(), lastErrorCode: null, nextScanAt: new Date(Date.now() + SCAN_INTERVAL_MS) } });
      await tx.knowledgeAuditEvent.create({ data: { sourceId: lease.id, action: 'SCAN_COMPLETED', detail: { files: files.length, removed: removed.count } } });
    });
    return true;
  } catch (error) {
    await prisma.knowledgeSource.updateMany({ where: { id: lease.id, scanLeaseToken: lease.token },
      data: { lastErrorCode: safeErrorCode(error), scanLeaseToken: null, scanLeaseUntil: null, nextScanAt: new Date(Date.now() + SCAN_INTERVAL_MS) } });
    return false;
  }
}

export async function claimKnowledgeJob(sourceId: string): Promise<Lease | null> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<{ id: string }[]>`UPDATE "KnowledgeIngestionJob" j SET "status"='RUNNING', "leaseToken"=${token},
    "leaseUntil"=NOW()+INTERVAL '90 seconds', "attempts"=j."attempts"+1, "updatedAt"=NOW()
    WHERE j."id"=(SELECT q."id" FROM "KnowledgeIngestionJob" q JOIN "KnowledgeVersion" v ON v."id"=q."versionId"
      JOIN "KnowledgeDocument" d ON d."id"=v."documentId" JOIN "KnowledgeSource" s ON s."id"=d."sourceId"
      WHERE s."id"=${sourceId} AND s."enabled"=true AND s."lastErrorCode" IS NULL AND d."deletedAt" IS NULL AND d."currentRevision"=v."revision"
        AND q."status" IN ('QUEUED','RUNNING') AND q."nextAt"<=NOW() AND (q."leaseUntil" IS NULL OR q."leaseUntil"<NOW())
      ORDER BY q."nextAt",q."id" FOR UPDATE OF q SKIP LOCKED LIMIT 1) RETURNING j."id"`;
  return rows[0] ? { id: rows[0].id, token } : null;
}

export async function processKnowledgeJob(lease: Lease, dav: KnowledgeDav, extract = extractKnowledgeText) {
  const initial = await prisma.knowledgeIngestionJob.findUnique({ where: { id: lease.id }, include: { version: { include: { document: true } } } });
  if (!initial || initial.leaseToken !== lease.token || initial.status !== 'RUNNING') return false;
  const { version } = initial, document = version.document;
  const renew = async () => {
    const count = await prisma.$executeRaw`UPDATE "KnowledgeIngestionJob" SET "leaseUntil"=NOW()+INTERVAL '90 seconds'
      WHERE "id"=${lease.id} AND "leaseToken"=${lease.token} AND "status"='RUNNING' AND "leaseUntil">NOW()`;
    if (!count) throw new KnowledgeError(409, 'JOB_LEASE_LOST');
  };
  try {
    await prisma.knowledgeVersion.updateMany({ where: { id: version.id, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'PROCESSING' } });
    const bytes = await dav.download({ path: version.path, remoteId: document.remoteId, etag: version.etag,
      size: document.size, mimeType: document.mimeType, directory: false });
    await renew();
    const text = await extract(bytes, supportedExtension(version.path)!);
    await renew();
    // Check identity again: a file can be replaced at the same path while processing.
    const current = await dav.stat(version.path);
    if (current.remoteId !== document.remoteId || current.etag !== version.etag) throw new KnowledgeError(409, 'DAV_CHANGED');
    const chunks = chunkKnowledgeText(text);
    return await prisma.$transaction(async tx => {
      await lockKnowledgeSource(tx, document.sourceId); await lockKnowledgeDocument(tx, document.id);
      const latest = await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: document.id }, include: { source: true } });
      if (latest.deletedAt || latest.currentRevision !== version.revision || latest.etag !== version.etag) {
        await tx.knowledgeIngestionJob.updateMany({ where: { id: lease.id, leaseToken: lease.token }, data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null } });
        return false;
      }
      if (!latest.source.enabled || latest.source.lastErrorCode) {
        await tx.knowledgeIngestionJob.updateMany({ where: { id: lease.id, leaseToken: lease.token },
          data: { status: 'QUEUED', nextAt: new Date(Date.now() + SCAN_INTERVAL_MS), leaseToken: null, leaseUntil: null } });
        return false;
      }
      const claimed = await tx.$executeRaw`UPDATE "KnowledgeIngestionJob" SET "status"='COMPLETED',"leaseToken"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=NOW()
        WHERE "id"=${lease.id} AND "leaseToken"=${lease.token} AND "status"='RUNNING' AND "leaseUntil">NOW()`;
      if (!claimed) return false;
      await tx.knowledgeChunk.deleteMany({ where: { versionId: version.id } });
      await tx.knowledgeChunk.createMany({ data: chunks.map((part, ordinal) => ({ versionId: version.id, ordinal, text: part })) });
      await tx.knowledgeVersion.update({ where: { id: version.id }, data: { status: 'READY', errorCode: null,
        sha256: createHash('sha256').update(bytes).digest('hex'), text, extractedAt: new Date() } });
      await tx.knowledgeAuditEvent.create({ data: { sourceId: document.sourceId, documentId: document.id, versionId: version.id,
        action: 'VERSION_READY', detail: { chunks: chunks.length } } });
      await publishFolderVersion(tx, latest, { ...version, status: 'READY' });
      return true;
    }, { timeout: 15000 });
  } catch (error) {
    const code = safeErrorCode(error);
    const permanent = error instanceof KnowledgeError && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status);
    await prisma.$transaction(async tx => {
      await lockKnowledgeSource(tx, document.sourceId); await lockKnowledgeDocument(tx, document.id);
      const changed = await tx.knowledgeIngestionJob.updateMany({ where: { id: lease.id, leaseToken: lease.token, status: 'RUNNING', leaseUntil: { gt: new Date() } },
        data: { status: permanent || initial.attempts >= 5 ? 'ERROR' : 'QUEUED', errorCode: code, leaseToken: null, leaseUntil: null,
          nextAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** initial.attempts)) } });
      if (!changed.count) return;
      await tx.knowledgeVersion.update({ where: { id: version.id }, data: { status: permanent || initial.attempts >= 5 ? 'ERROR' : 'QUEUED', errorCode: code } });
      if (['DAV_FORBIDDEN', 'DAV_UNAUTHORIZED', 'DAV_NOT_FOUND', 'DAV_CHANGED'].includes(code)) {
        await tx.knowledgeDocument.update({ where: { id: document.id }, data: { publishedRevision: null, publishedAt: null } });
        await tx.knowledgeSource.update({ where: { id: document.sourceId }, data: { nextScanAt: new Date(),
          ...(['DAV_FORBIDDEN','DAV_UNAUTHORIZED'].includes(code) ? { lastErrorCode: code } : {}) } });
      }
    });
    return false;
  }
}

export function startKnowledgeWorker() {
  const config = knowledgeConfig(), dav = new KnowledgeDav(config);
  let stopping = false, inFlight: Promise<void> | null = null;
  const tick = () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        const source = await ensureKnowledgeSource(config);
        const scan = await claimKnowledgeScan(source.id);
        if (scan) await scanKnowledgeSource(scan, dav);
        if (stopping) return;
        const job = await claimKnowledgeJob(source.id);
        if (job) await processKnowledgeJob(job, dav);
        await reconcileFolderPublications(source.id);
        await writeFile(path.join(tmpdir(), 'knowledge-worker-health.json'), JSON.stringify({ at: Date.now() }), { mode: 0o600 });
      } catch (error) { console.warn('[knowledge] worker iteration failed', { code: safeErrorCode(error) }); }
    })().finally(() => { inFlight = null; });
  };
  const timer = setInterval(tick, 1000); tick();
  return async () => { stopping = true; clearInterval(timer); await inFlight; };
}
