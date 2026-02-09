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
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'] || '')).toContain('text/csv');
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
});
