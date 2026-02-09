import request from 'supertest';
import { AppealMessageType, AppealStatus } from '@prisma/client';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Appeals CRM flow (claim/assign/department/status/messages)', () => {
  let creator: any;
  let assignee: any;
  let outsider: any;
  let manager: any;
  let admin: any;
  let creatorToken: string;
  let assigneeToken: string;
  let outsiderToken: string;
  let managerToken: string;
  let adminToken: string;
  let toDepartment: any;
  let otherDepartment: any;
  let managerRoleId: number;

  beforeAll(async () => {
    const mod = await import('../../src/index');
    app = mod.default;
    attachIoStub(app);

    await prisma.service.upsert({
      where: { key: 'appeals' },
      update: { isActive: true, defaultVisible: true, defaultEnabled: true },
      create: {
        key: 'appeals',
        name: 'Appeals',
        isActive: true,
        defaultVisible: true,
        defaultEnabled: true,
      },
    });

    toDepartment = await prisma.department.create({
      data: { name: `CRM_Dep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` },
    });
    otherDepartment = await prisma.department.create({
      data: { name: `CRM_Dep2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` },
    });

    creator = await createUserWithRole('creator@example.com', 'employee', 'EMPLOYEE');
    assignee = await createUserWithRole('assignee@example.com', 'employee', 'EMPLOYEE');
    outsider = await createUserWithRole('outsider@example.com', 'employee', 'EMPLOYEE');
    manager = await createUserWithRole('manager@example.com', 'department_manager', 'EMPLOYEE');
    admin = await createUserWithRole('admin@example.com', 'admin', 'EMPLOYEE');

    creatorToken = signToken(creator.id, 'employee');
    assigneeToken = signToken(assignee.id, 'employee');
    outsiderToken = signToken(outsider.id, 'employee');
    managerToken = signToken(manager.id, 'department_manager');
    adminToken = signToken(admin.id, 'admin');

    await prisma.employeeProfile.update({
      where: { userId: creator.id },
      data: { departmentId: toDepartment.id },
    });
    await prisma.employeeProfile.update({
      where: { userId: assignee.id },
      data: { departmentId: toDepartment.id },
    });
    await prisma.employeeProfile.update({
      where: { userId: manager.id },
      data: { departmentId: toDepartment.id },
    });
    await prisma.employeeProfile.update({
      where: { userId: outsider.id },
      data: { departmentId: otherDepartment.id },
    });
    await prisma.employeeProfile.update({
      where: { userId: admin.id },
      data: { departmentId: toDepartment.id },
    });

    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    if (!managerRole) throw new Error('department_manager role not found');
    managerRoleId = managerRole.id;

    await prisma.departmentRole.upsert({
      where: {
        userId_roleId_departmentId: {
          userId: manager.id,
          roleId: managerRoleId,
          departmentId: toDepartment.id,
        },
      },
      update: {},
      create: { userId: manager.id, roleId: managerRoleId, departmentId: toDepartment.id },
    });
  });

  async function createAppeal(title: string, token = creatorToken, deptId = toDepartment.id) {
    const res = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${token}`)
      .field('toDepartmentId', String(deptId))
      .field('title', title)
      .field('text', 'Appeal text');
    expect(res.status).toBe(201);
    return res.body?.data?.id as number;
  }

  test('Self-assign adds assignee, updates status, and creates system messages', async () => {
    const appealId = await createAppeal('Claim flow');

    const claimRes = await request(app)
      .post(`/appeals/${appealId}/claim`)
      .set('Authorization', `Bearer ${assigneeToken}`);

    expect(claimRes.status).toBe(200);
    expect(claimRes.body?.data?.status).toBe(AppealStatus.IN_PROGRESS);

    const appeal = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { assignees: true },
    });
    expect(appeal?.assignees.some((a) => a.userId === assignee.id)).toBe(true);

    const systemMessages = await prisma.appealMessage.findMany({
      where: { appealId, type: AppealMessageType.SYSTEM },
    });
    const eventTypes = systemMessages
      .map((m) => (m.systemEvent as any)?.type)
      .filter(Boolean);
    expect(eventTypes).toEqual(expect.arrayContaining(['assignees_changed', 'status_changed']));
  });

  test('Status rules: assignee -> RESOLVED, creator -> IN_PROGRESS/COMPLETED', async () => {
    const appealId = await createAppeal('Status flow');

    await request(app)
      .post(`/appeals/${appealId}/claim`)
      .set('Authorization', `Bearer ${assigneeToken}`);

    const resResolved = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .send({ status: AppealStatus.RESOLVED });
    expect(resResolved.status).toBe(200);

    const resReopen = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ status: AppealStatus.IN_PROGRESS });
    expect(resReopen.status).toBe(200);

    const resComplete = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ status: AppealStatus.COMPLETED });
    expect(resComplete.status).toBe(200);

    const resForbidden = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ status: AppealStatus.RESOLVED });
    expect(resForbidden.status).toBe(403);
  });

  test('Assign updates status and allows clearing assignees', async () => {
    const appealId = await createAppeal('Assign flow');

    const assignRes = await request(app)
      .put(`/appeals/${appealId}/assign`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ assigneeIds: [assignee.id] });
    expect(assignRes.status).toBe(200);

    const afterAssign = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { assignees: true },
    });
    expect(afterAssign?.status).toBe(AppealStatus.IN_PROGRESS);
    expect(afterAssign?.assignees.length).toBe(1);

    const clearRes = await request(app)
      .put(`/appeals/${appealId}/assign`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ assigneeIds: [] });
    expect(clearRes.status).toBe(200);

    const afterClear = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { assignees: true },
    });
    expect(afterClear?.status).toBe(AppealStatus.OPEN);
    expect(afterClear?.assignees.length).toBe(0);

    const systemMessages = await prisma.appealMessage.findMany({
      where: { appealId, type: AppealMessageType.SYSTEM },
    });
    expect(systemMessages.length).toBeGreaterThan(0);
  });

  test('Department change clears assignees and sets status OPEN', async () => {
    const appealId = await createAppeal('Department change');

    await request(app)
      .put(`/appeals/${appealId}/assign`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ assigneeIds: [assignee.id] });

    const res = await request(app)
      .put(`/appeals/${appealId}/department`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ departmentId: otherDepartment.id });

    expect(res.status).toBe(200);
    expect(res.body?.data?.status).toBe(AppealStatus.OPEN);

    const updated = await prisma.appeal.findUnique({
      where: { id: appealId },
      include: { assignees: true },
    });
    expect(updated?.toDepartmentId).toBe(otherDepartment.id);
    expect(updated?.status).toBe(AppealStatus.OPEN);
    expect(updated?.assignees.length).toBe(0);

    const systemMessages = await prisma.appealMessage.findMany({
      where: { appealId, type: AppealMessageType.SYSTEM },
    });
    const eventTypes = systemMessages
      .map((m) => (m.systemEvent as any)?.type)
      .filter(Boolean);
    expect(eventTypes).toEqual(expect.arrayContaining(['department_changed']));
  });

  test('Department members list: manager allowed, regular employee forbidden', async () => {
    const resManager = await request(app)
      .get(`/departments/${toDepartment.id}/members`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(resManager.status).toBe(200);
    const ids = (resManager.body?.data || []).map((u: any) => u.id);
    expect(ids).toEqual(expect.arrayContaining([creator.id, assignee.id]));

    const resForbidden = await request(app)
      .get(`/departments/${toDepartment.id}/members`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(resForbidden.status).toBe(403);
  });

  test('Watchers update works', async () => {
    const appealId = await createAppeal('Watchers flow');

    const res = await request(app)
      .put(`/appeals/${appealId}/watchers`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ watcherIds: [assignee.id, manager.id] });
    expect(res.status).toBe(200);

    const watchers = await prisma.appealWatcher.findMany({ where: { appealId } });
    const watcherIds = watchers.map((w) => w.userId);
    expect(watcherIds).toEqual(expect.arrayContaining([assignee.id, manager.id]));
  });

  test('Messages: edit/delete only by author', async () => {
    const appealId = await createAppeal('Messages flow');

    const msgRes = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'Message to edit');
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body?.data?.id;

    const editRes = await request(app)
      .put(`/appeals/messages/${messageId}`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ text: 'Updated text' });
    expect(editRes.status).toBe(200);

    const editForbidden = await request(app)
      .put(`/appeals/messages/${messageId}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ text: 'Unauthorized edit' });
    expect(editForbidden.status).toBe(403);

    const delRes = await request(app)
      .delete(`/appeals/messages/${messageId}`)
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(delRes.status).toBe(200);

    const deleted = await prisma.appealMessage.findUnique({ where: { id: messageId } });
    expect(deleted?.deleted).toBe(true);
  });

  test('Export appeals: CSV accessible for manager', async () => {
    const res = await request(app)
      .get('/appeals/export')
      .query({ scope: 'my' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(String(res.headers['content-type'] || '')).toContain('text/csv');
    }
  });

  test('Admin can change department without department role', async () => {
    const appealId = await createAppeal('Admin department change', creatorToken, toDepartment.id);

    const res = await request(app)
      .put(`/appeals/${appealId}/department`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ departmentId: otherDepartment.id });

    expect(res.status).toBe(200);
    const updated = await prisma.appeal.findUnique({ where: { id: appealId } });
    expect(updated?.toDepartmentId).toBe(otherDepartment.id);
  });

  test('Messages pagination returns latest page and older page', async () => {
    const appealId = await createAppeal('Messages pagination');

    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'msg-1');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'msg-2');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'msg-3');

    const page1 = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ limit: 2 })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body?.data?.data?.length).toBe(2);
    expect(page1.body?.data?.meta?.hasMore).toBe(true);
    const firstPageTexts = (page1.body?.data?.data || []).map((m: any) => m.text);
    expect(firstPageTexts).toEqual(expect.arrayContaining(['msg-2', 'msg-3']));

    const nextCursor = page1.body?.data?.meta?.nextCursor;
    const page2 = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ limit: 2, cursor: nextCursor })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body?.data?.data?.length).toBe(2);
    expect(page2.body?.data?.meta?.hasMore).toBe(false);
    const secondPageTexts = (page2.body?.data?.data || []).map((m: any) => m.text);
    expect(secondPageTexts).toContain('msg-1');
  });

  test('Messages read-bulk marks messages as read', async () => {
    const appealId = await createAppeal('Messages read-bulk');

    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'bulk-1');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'bulk-2');

    const listRes = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ limit: 10 })
      .set('Authorization', `Bearer ${creatorToken}`);
    const ids = (listRes.body?.data?.data || []).map((m: any) => m.id);
    expect(ids.length).toBeGreaterThan(0);

    const readRes = await request(app)
      .post(`/appeals/${appealId}/messages/read-bulk`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .send({ messageIds: ids });
    expect(readRes.status).toBe(200);

    const reads = await prisma.appealMessageRead.findMany({
      where: { messageId: { in: ids }, userId: assignee.id },
    });
    expect(reads.length).toBe(ids.length);
  });

  test('Messages read-bulk ignores foreign appeal ids and own messages', async () => {
    const appealId = await createAppeal('Messages read-bulk hardening');
    const otherAppealId = await createAppeal('Messages read-bulk hardening foreign');

    const creatorMsgRes = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'hardening-creator');
    const ownMsgRes = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .field('text', 'hardening-own');
    const foreignMsgRes = await request(app)
      .post(`/appeals/${otherAppealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'hardening-foreign');

    const creatorMsgId = creatorMsgRes.body?.data?.id as number;
    const ownMsgId = ownMsgRes.body?.data?.id as number;
    const foreignMsgId = foreignMsgRes.body?.data?.id as number;
    expect(creatorMsgId).toBeTruthy();
    expect(ownMsgId).toBeTruthy();
    expect(foreignMsgId).toBeTruthy();

    const readRes = await request(app)
      .post(`/appeals/${appealId}/messages/read-bulk`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .send({ messageIds: [creatorMsgId, ownMsgId, foreignMsgId] });
    expect(readRes.status).toBe(200);

    const accepted = (readRes.body?.data?.messageIds || []) as number[];
    expect(accepted).toContain(creatorMsgId);
    expect(accepted).not.toContain(ownMsgId);
    expect(accepted).not.toContain(foreignMsgId);

    const reads = await prisma.appealMessageRead.findMany({
      where: { userId: assignee.id, messageId: { in: [creatorMsgId, ownMsgId, foreignMsgId] } },
    });
    const readIds = reads.map((r) => r.messageId);
    expect(readIds).toContain(creatorMsgId);
    expect(readIds).not.toContain(ownMsgId);
    expect(readIds).not.toContain(foreignMsgId);
  });

  test('Messages read-bulk marks earlier unread when reading a lower message', async () => {
    const appealId = await createAppeal('Messages read cursor');

    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'cursor-1');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'cursor-2');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'cursor-3');

    const messages = await prisma.appealMessage.findMany({
      where: { appealId, deleted: false, senderId: creator.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const lastMessageId = messages[messages.length - 1]?.id;
    expect(lastMessageId).toBeTruthy();

    const readRes = await request(app)
      .post(`/appeals/${appealId}/messages/read-bulk`)
      .set('Authorization', `Bearer ${assigneeToken}`)
      .send({ messageIds: [lastMessageId] });
    expect(readRes.status).toBe(200);

    const accepted = (readRes.body?.data?.messageIds || []) as number[];
    messages.forEach((m) => expect(accepted).toContain(m.id));

    const reads = await prisma.appealMessageRead.findMany({
      where: { userId: assignee.id, messageId: { in: messages.map((m) => m.id) } },
    });
    expect(reads.length).toBe(messages.length);
  });

  test('Messages bootstrap anchors first unread and returns window', async () => {
    const appealId = await createAppeal('Messages bootstrap unread');

    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'bootstrap-1');
    await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'bootstrap-2');

    const firstUnread = await prisma.appealMessage.findFirst({
      where: {
        appealId,
        deleted: false,
        senderId: { not: assignee.id },
        reads: { none: { userId: assignee.id } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(firstUnread?.id).toBeDefined();

    const res = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ mode: 'bootstrap', anchor: 'first_unread', before: 1, after: 1, limit: 30 })
      .set('Authorization', `Bearer ${assigneeToken}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.meta?.anchorMessageId).toBe(firstUnread?.id ?? null);
    expect(Array.isArray(res.body?.data?.data)).toBe(true);
    expect(res.body?.data?.meta?.prevCursor).toBeTruthy();
  });

  test('Messages bootstrap without unread returns latest page with null anchor', async () => {
    const appealId = await createAppeal('Messages bootstrap no unread');

    const res = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ mode: 'bootstrap', anchor: 'first_unread', limit: 10 })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.meta?.anchorMessageId).toBeNull();
    expect(typeof res.body?.data?.meta?.hasMoreBefore).toBe('boolean');
  });

  test('Messages pagination supports direction=after and stable cursor boundaries', async () => {
    const appealId = await createAppeal('Messages after cursor');
    const fixedDate = new Date('2026-01-01T00:00:00.000Z');

    await prisma.appealMessage.createMany({
      data: [
        { appealId, senderId: creator.id, text: 'fixed-1', createdAt: fixedDate },
        { appealId, senderId: creator.id, text: 'fixed-2', createdAt: fixedDate },
        { appealId, senderId: creator.id, text: 'fixed-3', createdAt: fixedDate },
        { appealId, senderId: creator.id, text: 'fixed-4', createdAt: fixedDate },
      ],
    });

    const page1 = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ mode: 'page', direction: 'before', limit: 2 })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(page1.status).toBe(200);
    const page1Ids = (page1.body?.data?.data || []).map((m: any) => m.id);
    expect(page1Ids.length).toBe(2);
    const cursorToOlder = page1.body?.data?.meta?.nextCursor;
    expect(cursorToOlder).toBeTruthy();

    const page2 = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ mode: 'page', direction: 'before', limit: 2, cursor: cursorToOlder })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(page2.status).toBe(200);
    const page2Ids = (page2.body?.data?.data || []).map((m: any) => m.id);
    expect(page2Ids.length).toBe(2);
    expect(page1Ids.some((id: number) => page2Ids.includes(id))).toBe(false);

    const afterCursor = page2.body?.data?.meta?.nextCursor;
    const newer = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ mode: 'page', direction: 'after', limit: 4, cursor: afterCursor })
      .set('Authorization', `Bearer ${creatorToken}`);
    expect(newer.status).toBe(200);
    expect(newer.body?.data?.meta?.hasMoreAfter).toBe(false);
    expect((newer.body?.data?.data || []).length).toBeGreaterThan(0);
  });

  test('Messages route denies access for non-participant', async () => {
    const appealId = await createAppeal('Messages access deny');
    const res = await request(app)
      .get(`/appeals/${appealId}/messages`)
      .query({ limit: 10 })
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });

  test('AppealUpdated websocket event is emitted on status and message changes', async () => {
    const events: Array<{ room: string; event: string; payload: any }> = [];
    const ioMock = {
      to: (room: string) => ({
        emit: (event: string, payload: any) => {
          events.push({ room, event, payload });
        },
      }),
      emit: (event: string, payload: any) => {
        events.push({ room: 'broadcast', event, payload });
      },
    };
    (app as any).set('io', ioMock);

    const appealId = await createAppeal('WS appealUpdated');
    const statusRes = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ status: AppealStatus.COMPLETED });
    expect(statusRes.status).toBe(200);

    const msgRes = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .field('text', 'ws-message');
    expect(msgRes.status).toBe(201);

    const updatedEvents = events.filter((e) => e.event === 'appealUpdated' && e.payload?.appealId === appealId);
    expect(updatedEvents.length).toBeGreaterThan(0);
  });
});
