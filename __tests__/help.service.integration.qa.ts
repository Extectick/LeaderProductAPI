import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { helpS3 as s3 } from '../src/modules/help/help.storage';
import helpRouter, { helpBucket } from '../src/modules/help/help.routes';
import filesRouter from '../src/routes/files';
import { registerHelpSocket, isHelpRoom, publishHelpUpdates } from '../src/modules/help/help.socket';
import prisma, { pool } from '../src/prisma/client';
import {
  createHelpTicket, sendHelpMessage, helpDetail, helpActor, listHelpTickets,
  changeHelpStatus, editHelpMessage, reactHelpMessage, helpItAction,
  readHelpTicket, replayHelp, type HelpActor,
} from '../src/modules/help/help.service';

// Dedicated .qa.ts is excluded from the shared integration runner and its destructive setup.
// Fail closed before any test mutation. The dedicated runner creates this database.
const databaseUrl = new URL(process.env.DATABASE_URL || 'http://invalid');
const database = databaseUrl.pathname.slice(1);
if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '54329' || !/^help_qa_\d+_\d+$/.test(database) || process.env.HELP_QA_DATABASE !== database) {
  throw new Error('Help integration requires the isolated scripts/run-help-integration.cjs database');
}
const input = (text = 'Не открывается заказ') => ({ clientMessageId: randomUUID(), text });
let owner: HelpActor;
let stranger: HelpActor;
let it: HelpActor;
let secondIt: HelpActor;
let serviceId: number;
let managerRoleId: number;
let permissionId: number;
const api = express();
api.use(express.json());
api.use('/help', helpRouter);
api.use('/files', filesRouter);
const token = (actor: HelpActor) => jwt.sign({ userId: actor.userId, role: 'help_qa_employee' }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: '5m' });
const bearer = (actor: HelpActor) => `Bearer ${token(actor)}`;
async function ticket(actor = owner, text?: string) {
  return createHelpTicket(actor, { ...input(text), clientTicketId: randomUUID() });
}

beforeAll(async () => {
  const role = await prisma.role.upsert({ where: { name: 'help_qa_employee' }, create: { name: 'help_qa_employee' }, update: {} });
  const managerRole = await prisma.role.upsert({ where: { name: 'help_qa_it' }, create: { name: 'help_qa_it' }, update: {} });
  managerRoleId = managerRole.id;
  const permission = await prisma.permission.upsert({ where: { name: 'manage_help' }, create: { name: 'manage_help' }, update: {} });
  permissionId = permission.id;
  await prisma.rolePermissions.upsert({ where: { roleId_permissionId: { roleId: managerRole.id, permissionId: permission.id } }, create: { roleId: managerRole.id, permissionId: permission.id }, update: {} });
  const service = await prisma.service.upsert({ where: { key: 'help' }, create: { key: 'help', name: 'Помощь', defaultVisible: true, defaultEnabled: true }, update: {} });
  serviceId = service.id;
  async function actor(roleId: number, name: string) {
    const user = await prisma.user.create({ data: { roleId, firstName: name, isActive: true, profileStatus: 'ACTIVE', currentProfileType: 'EMPLOYEE' } });
    return helpActor(user.id);
  }
  owner = await actor(role.id, 'Автор');
  stranger = await actor(role.id, 'Другой пользователь');
  it = await actor(managerRole.id, 'Специалист');
  secondIt = await actor(managerRole.id, 'Второй специалист');
});
afterAll(async () => { await prisma.$disconnect(); await pool.end(); });

describe('Help actual PostgreSQL service integration', () => {
  test('server search finds old tickets beyond first page by title, number and message without leaking another owner', async () => {
    const id=await ticket(owner,'Редкий заголовок поиска');
    await sendHelpMessage(id,owner,input('Уникальный поисковый маркер АрхивЗапрос'));
    await prisma.helpTicket.update({where:{id},data:{updatedAt:new Date('2000-01-01T00:00:00Z')}});
    const clientIds=Array.from({length:51},()=>randomUUID());
    await prisma.helpTicket.createMany({data:clientIds.map(clientTicketId=>({ownerId:owner.userId,clientTicketId,requestHash:'qa-search-fixture',title:'Новое обращение',updatedAt:new Date()}))});
    const newer=await prisma.helpTicket.findMany({where:{clientTicketId:{in:clientIds}},select:{id:true}});
    await prisma.helpMember.createMany({data:newer.map(row=>({ticketId:row.id,userId:owner.userId,role:'OWNER'}))});
    expect((await listHelpTickets(owner,'OPEN',false)).tickets.some(t=>t.id===id)).toBe(false);
    for(const q of ['редкий заголовок',String(id),'архивзапрос']) {
      expect((await listHelpTickets(owner,'OPEN',false,undefined,q)).tickets.map(t=>t.id)).toContain(id);
      expect((await listHelpTickets(stranger,'OPEN',false,undefined,q)).tickets.map(t=>t.id)).not.toContain(id);
    }
    const response=await request(api).get('/help/tickets').query({q:'АРХИВЗАПРОС'}).set('Authorization',bearer(owner));
    expect(response.status).toBe(200);
    expect(response.body.tickets.map((t:any)=>t.id)).toContain(id);
    expect((await request(api).get('/help/tickets').query({q:'x'.repeat(101)}).set('Authorization',bearer(owner))).status).toBe(400);
  });

  test('targeted dev migration runner applies once and verifies repeat without touching public schema', async () => {
    const connection = new Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    try {
      await connection.query('CREATE SCHEMA help_migration_runner');
      for (const table of ['Service', 'PermissionGroup', 'Permission']) {
        await connection.query(`CREATE TABLE help_migration_runner."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
    } finally { await connection.end(); }
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', '-c search_path=help_migration_runner,public');
    const env = { ...process.env, DATABASE_URL: url.toString(), HELP_MIGRATION_TARGET: 'dev', HELP_MIGRATION_DATABASE_CONFIRM: database, DB_ACCEPT_DATA_LOSS: '0' };
    const run = () => spawnSync(process.execPath, ['scripts/apply-help-migration.js'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20000 });
    const first = run();
    expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, action: 'applied', tables: 8 });
    const second = run();
    expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, action: 'verified', tables: 8 });
    const denied = spawnSync(process.execPath, ['scripts/apply-help-migration.js'], { cwd: process.cwd(), env: { ...env, HELP_MIGRATION_TARGET: 'prod' }, encoding: 'utf8', timeout: 5000 });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('explicitly approved development target');
  });

  test('additive migration executes against a fresh schema and installs constraints without changing existing service rows', async () => {
    const migration = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261023070000_help_service/migration.sql'), 'utf8');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    const before = await prisma.service.findMany({ orderBy: { id: 'asc' } });
    const connection = new Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('CREATE SCHEMA help_migration_trial');
      await connection.query('SET LOCAL search_path TO help_migration_trial, public');
      for (const table of ['Service', 'PermissionGroup', 'Permission']) {
        await connection.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await connection.query(migration);
      const tables = await connection.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='help_migration_trial' AND table_name LIKE 'Help%'");
      expect(tables.rows[0].count).toBe(8);
      const constraints = await connection.query("SELECT conname FROM pg_constraint WHERE connamespace='help_migration_trial'::regnamespace AND contype='c'");
      expect(constraints.rows.map((r: any) => r.conname)).toEqual(expect.arrayContaining(['HelpTicket_status_check', 'HelpMessage_rating_check', 'HelpMessage_sequence_check']));
      expect((await connection.query('SELECT "key" FROM "Service"')).rows).toEqual([{ key: 'help' }]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { await connection.end(); }
    expect(await prisma.service.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  test('first message and ticket persist atomically, AI remains disabled', async () => {
    const id = await ticket();
    const detail = await helpDetail(id, owner);
    expect(detail.messages).toHaveLength(1);
    expect(detail.ticket).toMatchObject({ id, status: 'OPEN', ownerId: owner.userId, aiEnabled: false });
    expect(detail.messages[0]).toMatchObject({ authorId: owner.userId, sequence: 1, text: 'Не открывается заказ' });
    // Separate database connection proves this is committed storage, not an in-memory DTO.
    const reader = new Client({ connectionString: process.env.DATABASE_URL });
    await reader.connect();
    try {
      const result = await reader.query('SELECT "title", "messageSequence" FROM "HelpTicket" WHERE "id"=$1', [id]);
      expect(result.rows[0]).toEqual({ title: 'Не открывается заказ', messageSequence: 1 });
    } finally { await reader.end(); }
  });

  test('empty first message never creates a ticket', async () => {
    const before = await prisma.helpTicket.count();
    await expect(ticket(owner, '   ')).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' });
    expect(await prisma.helpTicket.count()).toBe(before);
  });

  test('invalid first-message attachment rolls back ticket, message and event together', async () => {
    const before = await Promise.all([prisma.helpTicket.count(), prisma.helpMessage.count(), prisma.helpEvent.count()]);
    await expect(createHelpTicket(owner, { ...input(), clientTicketId: randomUUID(), attachmentIds: [randomUUID()] })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENTS' });
    expect(await Promise.all([prisma.helpTicket.count(), prisma.helpMessage.count(), prisma.helpEvent.count()])).toEqual(before);
  });

  test('parallel first-send retries allocate one ticket and first message', async () => {
    const payload = { ...input(), clientTicketId: randomUUID() };
    const ids = await Promise.all(Array.from({ length: 4 }, () => createHelpTicket(owner, payload)));
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.helpMessage.count({ where: { ticketId: ids[0] } })).toBe(1);
  });

  test('reused create identity with changed content is a conflict', async () => {
    const payload = { ...input(), clientTicketId: randomUUID() };
    await createHelpTicket(owner, payload);
    await expect(createHelpTicket(owner, { ...payload, text: 'Другой вопрос' })).rejects.toMatchObject({ status: 409 });
  });

  test('parallel message retry is idempotent; changed payload conflicts', async () => {
    const id = await ticket();
    const payload = input('Уточнение');
    await Promise.all(Array.from({ length: 4 }, () => sendHelpMessage(id, owner, payload)));
    expect((await helpDetail(id, owner)).messages).toHaveLength(2);
    await expect(sendHelpMessage(id, owner, { ...payload, text: 'Подмена' })).rejects.toMatchObject({ status: 409 });
  });

  test('owner, list, replay and mutation ACL do not reveal another user ticket', async () => {
    const id = await ticket();
    await expect(helpDetail(id, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(sendHelpMessage(id, stranger, input())).rejects.toMatchObject({ status: 404 });
    expect((await listHelpTickets(stranger, 'OPEN', true)).tickets.some(t => t.id === id)).toBe(false);
    expect((await replayHelp(stranger, 0)).events.some(e => e.ticketId === id)).toBe(false);
  });

  test('DB current service permissions and IT permissions are reread', async () => {
    await prisma.serviceUserAccess.create({ data: { serviceId, userId: stranger.userId, enabled: false } });
    await expect(helpActor(stranger.userId)).rejects.toMatchObject({ status: 403 });
    await prisma.serviceUserAccess.update({ where: { serviceId_userId: { serviceId, userId: stranger.userId } }, data: { enabled: true } });
    expect((await helpActor(stranger.userId)).canManage).toBe(false);
    await prisma.rolePermissions.delete({ where: { roleId_permissionId: { roleId: managerRoleId, permissionId } } });
    expect((await helpActor(it.userId)).canManage).toBe(false);
    await prisma.rolePermissions.create({ data: { roleId: managerRoleId, permissionId } });
  });

  test('multiple IT members can claim and send, nonmember IT cannot send before claim', async () => {
    const id = await ticket();
    await expect(sendHelpMessage(id, it, input())).rejects.toMatchObject({ status: 404 });
    await Promise.all([helpItAction(id, it, true), helpItAction(id, secondIt, true)]);
    await expect(changeHelpStatus(id, it, input('IT не должен закрывать за автора'), 'close')).rejects.toMatchObject({ status: 403 });
    await sendHelpMessage(id, it, input('Проверяю'));
    await sendHelpMessage(id, secondIt, input('Подключился'));
    const detail = await helpDetail(id, owner);
    expect(detail.ticket.members.filter((m: any) => m.role === 'IT')).toHaveLength(2);
    expect(detail.messages.slice(1).every(m => m.authorRole === 'IT')).toBe(true);
    const notifications = await prisma.helpNotification.findMany({ where: { ticketId: id } });
    expect(notifications.some(n => n.userId === owner.userId)).toBe(true);
    const event = await prisma.helpEvent.findFirstOrThrow({ where: { ticketId: id, actorId: secondIt.userId, type: 'MESSAGE_CREATED' } });
    expect(notifications.some(n => n.eventId === event.id && n.userId === secondIt.userId)).toBe(false);
  });

  test('own reply works and cross-ticket reply/forward cannot bypass ACL', async () => {
    const id = await ticket();
    const message = (await helpDetail(id, owner)).messages[0];
    await sendHelpMessage(id, owner, { ...input('Ответ себе'), replyToId: message.id });
    expect((await helpDetail(id, owner)).messages[1].replyTo?.id).toBe(message.id);
    const privateId = await ticket(stranger);
    const foreign = (await helpDetail(privateId, stranger)).messages[0];
    await expect(sendHelpMessage(id, owner, { ...input(), replyToId: foreign.id })).rejects.toMatchObject({ code: 'INVALID_REPLY' });
    await expect(sendHelpMessage(id, owner, { ...input(), forwardedFromId: foreign.id })).rejects.toMatchObject({ status: 404 });
  });

  test('multiple distinct reactions deduplicate and removal preserves other reaction', async () => {
    const id = await ticket();
    const message = (await helpDetail(id, owner)).messages[0];
    await Promise.all([reactHelpMessage(message.id, owner, '❤️', false), reactHelpMessage(message.id, owner, '❤️', false), reactHelpMessage(message.id, owner, '👍', false)]);
    expect((await helpDetail(id, owner)).messages[0].reactions).toHaveLength(2);
    await reactHelpMessage(message.id, owner, '❤️', true);
    expect((await helpDetail(id, owner)).messages[0].reactions).toEqual([expect.objectContaining({ emoji: '👍', count: 1, mine: true })]);
  });

  test('empty closure persists zero stars; edit does not move closure deadline', async () => {
    const id = await ticket();
    await changeHelpStatus(id, owner, input(''), 'close');
    const closed = await helpDetail(id, owner);
    const closure = closed.messages.slice(-1)[0]!;
    expect(closure).toMatchObject({ kind: 'CLOSURE', rating: 0, text: '' });
    await editHelpMessage(closure.id, owner, 'Всё работает', 5);
    const edited = await helpDetail(id, owner);
    expect(edited.ticket.closedAt).toEqual(closed.ticket.closedAt);
    expect(edited.messages.slice(-1)[0]).toMatchObject({ rating: 5, text: 'Всё работает', editedAt: expect.any(Date) });
    await expect(sendHelpMessage(id, owner, input())).rejects.toMatchObject({ code: 'TICKET_CLOSED' });
  });

  test('own edit expires after an hour; another user cannot edit', async () => {
    const id = await ticket();
    const message = (await helpDetail(id, owner)).messages[0];
    await expect(editHelpMessage(message.id, stranger, 'Подмена')).rejects.toMatchObject({ status: 404 });
    await prisma.helpMessage.update({ where: { id: message.id }, data: { createdAt: new Date(Date.now() - 3600001) } });
    await expect(editHelpMessage(message.id, owner, 'Поздно')).rejects.toMatchObject({ code: 'EDIT_EXPIRED' });
  });

  test('retry after edit preserves edited content; action identity cannot reopen accidentally', async () => {
    const id = await ticket();
    const original = input('До изменения');
    await sendHelpMessage(id, owner, original);
    const message = (await helpDetail(id, owner)).messages.slice(-1)[0]!;
    await editHelpMessage(message.id, owner, 'После изменения');
    await sendHelpMessage(id, owner, original);
    expect((await helpDetail(id, owner)).messages.slice(-1)[0]?.text).toBe('После изменения');
    await changeHelpStatus(id, owner, input(''), 'close');
    await expect(changeHelpStatus(id, owner, original, 'reopen')).rejects.toMatchObject({ status: 409 });
    expect((await helpDetail(id, owner)).ticket.status).toBe('CLOSED');
  });

  test('reopen requires reason and expires after72h; new linked ticket preserves old', async () => {
    const id = await ticket();
    await changeHelpStatus(id, owner, input(''), 'close');
    await expect(changeHelpStatus(id, owner, input(''), 'reopen')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await changeHelpStatus(id, owner, input('Проблема повторилась'), 'reopen');
    expect((await helpDetail(id, owner)).ticket.status).toBe('OPEN');
    await changeHelpStatus(id, owner, input(''), 'close');
    await prisma.helpTicket.update({ where: { id }, data: { closedAt: new Date(Date.now() - 4 * 86400000) } });
    await expect(changeHelpStatus(id, owner, input('Повтор'), 'reopen')).rejects.toMatchObject({ code: 'REOPEN_EXPIRED' });
    const linked = await createHelpTicket(owner, { ...input('Снова ошибка'), clientTicketId: randomUUID(), sourceTicketId: id });
    expect((await helpDetail(linked, owner)).ticket.sourceTicket?.id).toBe(id);
    expect((await helpDetail(id, owner)).ticket.status).toBe('CLOSED');
    await expect(createHelpTicket(stranger, { ...input(), clientTicketId: randomUUID(), sourceTicketId: id })).rejects.toMatchObject({ status: 404 });
  });

  test('read sequence is monotonic and replay only includes authorized changes', async () => {
    const id = await ticket();
    await helpItAction(id, it, true);
    await sendHelpMessage(id, it, input('Ответ'));
    expect((await helpDetail(id, owner)).ticket.unreadCount).toBe(1);
    await readHelpTicket(id, owner, 99999);
    const eventCount = await prisma.helpEvent.count({ where: { ticketId: id } });
    await readHelpTicket(id, owner, 0);
    await readHelpTicket(id, owner, 99999);
    expect(await prisma.helpEvent.count({ where: { ticketId: id } })).toBe(eventCount);
    expect((await helpDetail(id, owner)).ticket.unreadCount).toBe(0);
    const events = (await replayHelp(owner, 0)).events.filter(e => e.ticketId === id);
    expect(events.some(e => e.type === 'MESSAGE_CREATED')).toBe(true);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
  });

  test('HTTP auth, validation, list and message ACL return proper statuses', async () => {
    const id = await ticket();
    await request(api).get('/help/config').expect(401);
    const config = await request(api).get('/help/config').set('Authorization', bearer(owner)).expect(200);
    expect(config.body.aiEnabled).toBe(false);
    await request(api).post('/help/tickets').set('Authorization', bearer(owner)).send({ clientTicketId: 'short' }).expect(400);
    await request(api).get(`/help/tickets/${id}`).set('Authorization', bearer(stranger)).expect(404);
    await request(api).get('/help/tickets?scope=queue').set('Authorization', bearer(stranger)).expect(403);
    await request(api).post(`/help/tickets/${id}/close`).set('Authorization', bearer(owner)).send({ ...input(), rating: 6 }).expect(400);
    await request(api).post(`/help/tickets/${id}/close`).set('Authorization', bearer(owner)).send({ ...input(), rating: -1 }).expect(400);
  });

  test('actual S3 mixed upload, private download/range, attachment ownership and forwarding', async () => {
    try { await s3.send(new HeadBucketCommand({ Bucket: helpBucket })); }
    catch (error: any) {
      if (error?.$metadata?.httpStatusCode !== 404) throw error;
      await s3.send(new CreateBucketCommand({ Bucket: helpBucket }));
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const text = Buffer.from('Пример файла для обращения', 'utf8');
    const uploaded = await request(api).post('/help/attachments').set('Authorization', bearer(owner))
      .attach('files', png, { filename: 'image.png', contentType: 'image/png' })
      .attach('files', text, { filename: 'notes.txt', contentType: 'text/plain' }).expect(201);
    const files = uploaded.body.attachments;
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ kind: 'IMAGE', mimeType: 'image/png', size: png.length });
    expect(files[0].objectKey).toBeUndefined();
    await request(api).get(files[0].url).expect(401);
    await request(api).get(files[0].url).set('Authorization', bearer(stranger)).expect(404);
    const image = await request(api).get(files[0].url).set('Authorization', bearer(owner)).expect(200);
    expect(image.body.equals(png)).toBe(true);
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['cache-control']).toBe('private, no-store');
    const slice = await request(api).get(files[0].url).set('Authorization', bearer(owner)).set('Range', 'bytes=0-7').expect(206);
    expect(slice.body.equals(png.subarray(0, 8))).toBe(true);
    const row = await prisma.helpAttachment.findUniqueOrThrow({ where: { id: files[0].id } });
    expect(helpBucket).toBe(process.env.S3_BUCKET);
    expect(row.objectKey.startsWith('help-qa/help/')).toBe(true);
    await request(api).get('/files/'+row.objectKey).expect(404);
    await request(api).get('/files/'+row.objectKey).set('Authorization',bearer(owner)).expect(404);
    const direct = await fetch(`http://127.0.0.1:9009/${helpBucket}/${row.objectKey}`);
    expect(direct.status).toBe(403);
    const id = await ticket();
    await expect(sendHelpMessage(id, stranger, { ...input(), attachmentIds: [files[0].id] })).rejects.toMatchObject({ status: 404 });
    const foreign = await ticket(stranger);
    await expect(sendHelpMessage(foreign, stranger, { ...input(), attachmentIds: [files[0].id] })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENTS' });
    await sendHelpMessage(id, owner, { ...input('Фотография и файл'), attachmentIds: files.map((f: any) => f.id) });
    const attached = (await helpDetail(id, owner)).messages.slice(-1)[0]!;
    expect(attached.attachments).toHaveLength(2);
    await helpItAction(id, it, true);
    await request(api).get(files[0].url).set('Authorization', bearer(it)).expect(200);
    const destination = await ticket();
    await sendHelpMessage(destination, owner, { ...input(''), forwardedFromId: attached.id });
    const forwarded = (await helpDetail(destination, owner)).messages.slice(-1)[0]!;
    expect(forwarded.attachments).toHaveLength(2);
    expect(forwarded.attachments[0].id).not.toBe(files[0].id);
    await request(api).get(forwarded.attachments[0].url).set('Authorization', bearer(owner)).expect(200);
    // Queue managers may inspect every ticket; an ordinary nonmember must not.
    await request(api).get(forwarded.attachments[0].url).set('Authorization', bearer(stranger)).expect(404);
  });

  test('storage denial returns safe503, creates no metadata, and upload can retry', async () => {
    const before=await prisma.helpAttachment.count();
    const spy=jest.spyOn(s3,'send').mockImplementationOnce(()=>{throw Object.assign(new Error('private provider details'),{name:'AccessDenied',$metadata:{httpStatusCode:403}});});
    try {
      const denied=await request(api).post('/help/attachments').set('Authorization',bearer(owner))
        .attach('files',Buffer.from('Отзыв'),{filename:'review.txt',contentType:'text/plain'}).expect(503);
      expect(denied.body.code).toBe('HELP_STORAGE_UNAVAILABLE');
      expect(JSON.stringify(denied.body)).not.toContain('private provider details');
      expect(await prisma.helpAttachment.count()).toBe(before);
    } finally { spy.mockRestore(); }
    await request(api).post('/help/attachments').set('Authorization',bearer(owner))
      .attach('files',Buffer.from('Повторная загрузка'),{filename:'retry.txt',contentType:'text/plain'}).expect(201);
  });

  test('closure edits attach/remove files, reject another owner files and preserve deadline', async () => {
    const id = await ticket();
    await changeHelpStatus(id, owner, input(''), 'close');
    const closed = await helpDetail(id, owner);
    const message = closed.messages.slice(-1)[0];
    const upload = async (actor: HelpActor) => (await request(api).post('/help/attachments').set('Authorization', bearer(actor))
      .attach('files', Buffer.from('Дополнение к отзыву'), { filename: 'review.txt', contentType: 'text/plain' }).expect(201)).body.attachments[0];
    const mine = await upload(owner);
    const foreign = await upload(stranger);
    const edited = await request(api).patch(`/help/messages/${message.id}`).set('Authorization', bearer(owner))
      .send({ text: '', rating: 4, attachmentIds: [mine.id] }).expect(200);
    expect(edited.body.messages.slice(-1)[0]).toMatchObject({ rating: 4, attachments: [expect.objectContaining({ id: mine.id })] });
    await request(api).patch(`/help/messages/${message.id}`).set('Authorization', bearer(owner))
      .send({ text: 'Подмена', attachmentIds: [foreign.id] }).expect(400);
    expect((await helpDetail(id, owner)).messages.slice(-1)[0].attachments[0].id).toBe(mine.id);
    await request(api).patch(`/help/messages/${message.id}`).set('Authorization', bearer(owner))
      .send({ text: '', rating: 0, attachmentIds: [] }).expect(200);
    const after = await helpDetail(id, owner);
    expect(after.ticket.closedAt).toEqual(closed.ticket.closedAt);
    expect(after.messages.slice(-1)[0]).toMatchObject({ rating: 0, text: '', attachments: [] });
    await request(api).get(mine.url).set('Authorization', bearer(owner)).expect(200);
    await request(api).get(mine.url).set('Authorization', bearer(stranger)).expect(404);
  });

  test('spoofed active content and executable upload is rejected before storage', async () => {
    const before = await prisma.helpAttachment.count();
    await request(api).post('/help/attachments').set('Authorization', bearer(owner))
      .attach('files', Buffer.from('<svg onload="alert(1)"></svg>'), { filename: 'safe.png', contentType: 'image/png' }).expect(415);
    await request(api).post('/help/attachments').set('Authorization', bearer(owner))
      .attach('files', Buffer.from([77, 90, 0, 0, 1, 0]), { filename: 'safe.pdf', contentType: 'application/pdf' }).expect(415);
    expect(await prisma.helpAttachment.count()).toBe(before);
    let tooMany = request(api).post('/help/attachments').set('Authorization', bearer(owner));
    for (let i = 0; i < 6; i++) tooMany = tooMany.attach('files', Buffer.from('text'), { filename: `file${i}.txt`, contentType: 'text/plain' });
    await tooMany.expect(413);
  });
});

// Raw Engine.IO/Socket.IO frames over Node's real WebSocket avoid adding a runtime dependency.
async function connectSocket(url: string, actor: HelpActor) {
  const connection = new WebSocket(url.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket');
  const packets: string[] = [];
  connection.addEventListener('message', e => {
    const packet = String(e.data);
    packets.push(packet);
    if (packet.startsWith('0')) connection.send(`40${JSON.stringify({ token: token(actor) })}`);
    if (packet === '2') connection.send('3');
  });
  const until = async (predicate: (packet: string) => boolean, timeout = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const index = packets.findIndex(predicate);
      if (index >= 0) return packets.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Socket response timeout');
  };
  await until(p => p.startsWith('40'));
  let sequence = 0;
  return {
    packets,
    connection,
    send: (name: string, payload: unknown) => connection.send(`42${JSON.stringify([name, payload])}`),
    ack: async (name: string, payload: unknown) => {
      const id = ++sequence;
      connection.send(`42${id}${JSON.stringify([name, payload])}`);
      const response = await until(p => p.startsWith(`43${id}[`));
      return JSON.parse(response.slice(2 + String(id).length))[0];
    },
    event: async (name: string) => JSON.parse((await until(p => p.startsWith('42[') && JSON.parse(p.slice(2))[0] === name)).slice(2))[1],
  };
}

describe('Help actual websocket authorization', () => {
  let http: HttpServer;
  let io: SocketServer;
  let baseUrl: string;
  const clients: Awaited<ReturnType<typeof connectSocket>>[] = [];
  beforeAll(async () => {
    http = createServer(api);
    io = new SocketServer(http);
    io.use((socket, next) => {
      try { socket.data.user = jwt.verify(String(socket.handshake.auth.token || ''), process.env.ACCESS_TOKEN_SECRET!); next(); }
      catch { next(new Error('Unauthorized')); }
    });
    io.on('connection', socket => {
      // Same shared guard used by src/index.ts for the legacy generic room handler.
      socket.on('join', (room: unknown) => { if (typeof room === 'string' && !isHelpRoom(room)) socket.join(room); });
      registerHelpSocket(io, socket);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { for (const client of clients) client.connection.close(); await new Promise<void>(resolve => io.close(() => resolve())); });

  test('foreign subscription/generic join cannot receive private events; revoked permission stops delivery', async () => {
    const id = await ticket();
    const authorized = await connectSocket(baseUrl, owner);
    const unauthorized = await connectSocket(baseUrl, stranger);
    clients.push(authorized, unauthorized);
    expect(await authorized.ack('help:subscribe', { ticketId: id })).toEqual({ ok: true });
    expect(await unauthorized.ack('help:subscribe', { ticketId: id })).toMatchObject({ ok: false });
    expect(await unauthorized.ack('help:subscribe', {})).toEqual({ ok: true });
    unauthorized.send('join', `help:${id}`);
    unauthorized.send('join', `help:user:${owner.userId}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect([...io.sockets.sockets.values()].some(socket => socket.rooms.has(`help:${id}`))).toBe(false);
    await sendHelpMessage(id, owner, input('Новое событие'));
    await publishHelpUpdates(id);
    expect((await authorized.event('help:event')).ticketId).toBe(id);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(unauthorized.packets.some(p => p.includes('help:event'))).toBe(false);
    await prisma.serviceUserAccess.create({ data: { serviceId, userId: owner.userId, enabled: false } });
    try {
      authorized.packets.splice(0);
      await sendHelpMessage(id, owner, input('После отзыва прав'));
      await publishHelpUpdates(id);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(authorized.packets.some(p => p.includes('help:event'))).toBe(false);
      expect(await authorized.ack('help:subscribe', { ticketId: id })).toMatchObject({ ok: false });
    } finally {
      await prisma.serviceUserAccess.update({ where: { serviceId_userId: { serviceId, userId: owner.userId } }, data: { enabled: true } });
    }
  });
});
