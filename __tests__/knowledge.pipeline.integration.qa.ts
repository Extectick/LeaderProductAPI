/** Run only against the explicitly named disposable DB after build; never a shared dev/prod DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import prisma, { pool } from '../src/prisma/client';
import { knowledgeConfig, KnowledgeError } from '../src/modules/knowledge/knowledge.config';
import { DavEntry, KnowledgeDav } from '../src/modules/knowledge/knowledge.dav';
import { ensureKnowledgeSource, claimKnowledgeScan, scanKnowledgeSource, claimKnowledgeJob, processKnowledgeJob } from '../src/modules/knowledge/knowledge.worker';
import { publishKnowledge, revokeKnowledge, searchKnowledge, publishedKnowledge } from '../src/modules/knowledge/knowledge.service';
import { extractKnowledgeText } from '../src/modules/knowledge/knowledge.extract';

async function main() {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/LeaderAPI_knowledge_test_20261031');
  process.env.KNOWLEDGE_ENABLED = 'true';
  process.env.KNOWLEDGE_SOURCE_KEY = 'qa-' + randomUUID();
  process.env.KNOWLEDGE_NEXTCLOUD_URL = 'https://knowledge.example.org';
  process.env.KNOWLEDGE_NEXTCLOUD_USER = 'reader';
  process.env.KNOWLEDGE_NEXTCLOUD_PASSWORD = 'test-only';
  delete process.env.KNOWLEDGE_NEXTCLOUD_PASSWORD_FILE;
  const config = knowledgeConfig(), source = await ensureKnowledgeSource(config);
  const role = await prisma.role.create({ data: { name: config.key } });
  const reader = await prisma.user.create({ data: { roleId: role.id, isActive: true } });
  const actor = { userId: reader.id, canManage: true, departmentIds: [] };
  const allowed = { ...actor, canManage: false }, denied = { userId: -1, canManage: false, departmentIds: [] };
  const entries = new Map<string, { entry: DavEntry; text: string }>();
  const add = (remoteId: string, filepath: string, etag: string, text = 'Инструкция: принтер не печатает. Проверьте питание, кабель и очередь печати.') =>
    entries.set(remoteId, { entry: { remoteId, path: filepath, etag, size: BigInt(Buffer.byteLength(text)), mimeType: 'text/markdown', directory: false }, text });
  const dav = new KnowledgeDav(config);
  let failScan = false;
  dav.walk = async heartbeat => { await heartbeat(); if (failScan) throw new KnowledgeError(403, 'DAV_FORBIDDEN'); return [...entries.values()].map(x => ({ ...x.entry })); };
  dav.stat = async filepath => {
    const current = [...entries.values()].find(x => x.entry.path === filepath);
    if (!current) throw new KnowledgeError(404, 'DAV_NOT_FOUND'); return { ...current.entry };
  };
  dav.download = async entry => {
    const current = entries.get(entry.remoteId);
    if (!current || current.entry.etag !== entry.etag || current.entry.path !== entry.path) throw new KnowledgeError(412, 'DAV_CHANGED');
    return Buffer.from(current.text);
  };
  const scan = async (success = true) => {
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { nextScanAt: new Date(0) } });
    const lease = await claimKnowledgeScan(source.id); assert(lease);
    assert.equal(await scanKnowledgeSource(lease, dav), success);
  };
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      const job = await claimKnowledgeJob(source.id); if (!job) return;
      assert.equal(await processKnowledgeJob(job, dav), true);
    }
    throw new Error('Queue did not drain');
  };
  const doc = () => prisma.knowledgeDocument.findUniqueOrThrow({ where: { sourceId_remoteId: { sourceId: source.id, remoteId: '101' } } });
  const version = async () => { const d = await doc(); return prisma.knowledgeVersion.findUniqueOrThrow({ where: { documentId_revision: { documentId: d.id, revision: d.currentRevision } } }); };
  const publish = async () => { const d = await doc(), v = await version(); await publishKnowledge(d.id, { versionId: v.id, allEmployees: false, userIds: [reader.id], departmentIds: [] }, actor, dav); };
  try {
    add('101', 'Материалы компании/Печать.md', '"v1"');
    add('102', 'Рабочая область ИИ/Черновики инструкций/Печать.md', '"draft"');
    add('103', 'Архив/Материалы компании/Печать.md', '"archive"');
    add('104', 'Материалы компании/program.exe', '"binary"');
    await scan(); await drain();
    assert.equal((await version()).status, 'READY');
    assert.equal((await searchKnowledge('принтер', actor)).length, 0, 'ready is not published');
    const original = await doc(), originalVersion = await version();
    await publish();
    assert.equal((await searchKnowledge('принтер', allowed)).length, 1);
    assert.equal((await searchKnowledge('принтер', denied)).length, 0);
    await assert.rejects(publishedKnowledge(original.id, denied), /Материал недоступен/);
    assert((await publishedKnowledge(original.id, allowed)).text?.includes('принтер'));
    await assert.rejects(publishKnowledge(original.id, { versionId: originalVersion.id, allEmployees: true, userIds: [], departmentIds: [] }, denied, dav), /Требуется право/);
    for (const remoteId of ['102','103']) {
      const d = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { sourceId_remoteId: { sourceId: source.id, remoteId } }, include: { versions: true } });
      await assert.rejects(publishKnowledge(d.id, { versionId: d.versions[0].id, allEmployees: true, userIds: [], departmentIds: [] }, actor, dav), /не готов/);
    }
    await scan();
    assert.equal(await prisma.knowledgeVersion.count({ where: { documentId: original.id } }), 1, 'unchanged scan is idempotent');
    await revokeKnowledge(original.id, actor);
    assert.equal((await searchKnowledge('принтер', allowed)).length, 0);
    await publish();
    failScan = true; await scan(false);
    assert.equal((await doc()).deletedAt, null, 'partial/forbidden traversal must not mark files deleted');
    assert.equal((await searchKnowledge('принтер', actor)).length, 0, 'source outage fails closed');
    failScan = false; await scan();
    assert.equal((await searchKnowledge('принтер', allowed)).length, 1);
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { lastSuccessAt: new Date(0) } });
    assert.equal((await searchKnowledge('принтер', allowed)).length, 0, 'stale sources fail closed');
    await scan();
    add('101', original.path, '"v2"'); await scan();
    assert.equal((await doc()).publishedRevision, null, 'content updates revoke old publication');
    await assert.rejects(publishKnowledge(original.id, { versionId: originalVersion.id, allEmployees: true, userIds: [], departmentIds: [] }, actor, dav), /не готов/);
    const first = await claimKnowledgeJob(source.id); assert(first);
    await prisma.knowledgeIngestionJob.update({ where: { id: first.id }, data: { leaseUntil: new Date(0) } });
    const replacement = await claimKnowledgeJob(source.id); assert(replacement); assert.equal(replacement.id, first.id); assert.notEqual(replacement.token, first.token);
    assert.equal(await processKnowledgeJob(first, dav), false, 'worker with an old lease cannot finish');
    assert.equal(await processKnowledgeJob(replacement, dav), true);
    const chunks = await prisma.knowledgeChunk.count({ where: { versionId: (await version()).id } });
    assert.equal(await processKnowledgeJob(replacement, dav), false);
    assert.equal(await prisma.knowledgeChunk.count({ where: { versionId: (await version()).id } }), chunks);
    await publish();
    add('101', original.path, '"v3"'); await scan();
    const racing = await claimKnowledgeJob(source.id); assert(racing);
    assert.equal(await processKnowledgeJob(racing, dav, async () => {
      add('101', original.path, '"v4"'); await scan(); return 'Старая версия';
    }), false, 'content superseded during extraction must not commit');
    await drain(); assert.equal((await version()).etag, '"v4"');
    await publish();
    add('101', 'Архив/Материалы компании/Перенесённая инструкция.md', '"v4"'); await scan();
    assert.equal((await doc()).id, original.id); assert.equal((await doc()).publishedRevision, null);
    assert.equal((await version()).status, 'SKIPPED');
    add('101', 'Материалы компании/Новое имя.md', '"v4"'); await scan(); await drain();
    assert.equal((await doc()).id, original.id, 'rename retains document identity');
    await publish(); entries.clear(); await scan();
    assert((await doc()).deletedAt); assert.equal((await searchKnowledge('принтер', actor)).length, 0);
    console.log('PASS: discovery, publication, permissions, revoke, partial scan, stale source, updates, lease recovery, supersession, rename, archive and deletion');

    for (const ext of ['txt','md','docx','pdf']) {
      const bytes = ['txt','md'].includes(ext) ? Buffer.from('Printer test 123') : fs.readFileSync(path.join(__dirname, 'fixtures/knowledge', 'sample.' + ext));
      assert.match(await extractKnowledgeText(bytes, ext), /Printer test 123/);
    }
    await assert.rejects(extractKnowledgeText(Buffer.from('%PDF-broken'), 'pdf'));
    console.log('PASS: actual isolated TXT, Markdown, DOCX, PDF parsing and corrupt-document failure');
  } finally {
    await prisma.knowledgeAuditEvent.deleteMany({ where: { sourceId: source.id } });
    await prisma.knowledgeSource.delete({ where: { id: source.id } });
    await prisma.user.delete({ where: { id: reader.id } }); await prisma.role.delete({ where: { id: role.id } });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); await pool.end(); });
