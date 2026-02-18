import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Users RBAC metadata and hierarchy', () => {
  let adminToken = '';

  beforeAll(async () => {
    const mod = await import('../../src/index');
    app = mod.default;
    attachIoStub(app);

    const admin = await createUserWithRole('rbac-admin@example.com', 'admin', 'EMPLOYEE');
    adminToken = signToken(admin.id, 'admin');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /users/permissions returns metadata fields', async () => {
    const res = await request(app)
      .get('/users/permissions')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data)).toBe(true);
    expect(res.body?.data?.length).toBeGreaterThan(0);
    expect(res.body?.data?.[0]).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        name: expect.any(String),
        displayName: expect.any(String),
        description: expect.any(String),
        group: expect.objectContaining({
          id: expect.any(Number),
          key: expect.any(String),
          displayName: expect.any(String),
          description: expect.any(String),
          isSystem: expect.any(Boolean),
        }),
      })
    );
  });

  test('permission groups CRUD and moving permission to another group', async () => {
    const unique = Date.now();
    const createRes = await request(app)
      .post('/users/permission-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: `qa_custom_group_${unique}`,
        displayName: 'QA Группа',
        description: 'Тестовая группа',
        sortOrder: 777,
      });

    expect(createRes.status).toBe(200);
    const createdGroupId = createRes.body?.data?.id;
    expect(createdGroupId).toBeTruthy();

    const listRes = await request(app)
      .get('/users/permission-groups')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const listed = (listRes.body?.data || []).find((g: any) => g.id === createdGroupId);
    expect(listed).toBeTruthy();

    const updateRes = await request(app)
      .patch(`/users/permission-groups/${createdGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayName: 'QA Группа (обновлено)', sortOrder: 778 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body?.data?.displayName).toBe('QA Группа (обновлено)');

    const anyPermission = await prisma.permission.findFirst({
      where: { name: 'view_profile' },
      select: { id: true },
    });
    expect(anyPermission).toBeTruthy();

    const moveRes = await request(app)
      .patch(`/users/permissions/${anyPermission!.id}/group`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ groupId: createdGroupId });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body?.data?.group?.id).toBe(createdGroupId);

    const deleteRes = await request(app)
      .delete(`/users/permission-groups/${createdGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.status).toBe(200);
  });

  test('GET /users/roles returns displayName and parentRole.displayName', async () => {
    const res = await request(app)
      .get('/users/roles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data)).toBe(true);
    const employeeRole = (res.body?.data || []).find((r: any) => r.name === 'employee');
    expect(employeeRole).toBeTruthy();
    expect(employeeRole.displayName).toBeTruthy();
    if (employeeRole?.parentRole) {
      expect(employeeRole.parentRole).toEqual(
        expect.objectContaining({
          id: expect.any(Number),
          name: expect.any(String),
          displayName: expect.any(String),
        })
      );
    }
  });

  test('POST /users/roles creates role with displayName and parent', async () => {
    const parent = await prisma.role.findUnique({ where: { name: 'employee' } });
    expect(parent).toBeTruthy();

    const roleName = `qa_role_${Date.now()}`;
    const res = await request(app)
      .post('/users/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: roleName,
        displayName: 'Тестовая роль',
        parentRoleId: parent!.id,
        permissions: ['view_profile'],
      });

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data).toEqual(
      expect.objectContaining({
        name: roleName,
        displayName: 'Тестовая роль',
      })
    );
    expect(res.body?.data?.parentRole?.id).toBe(parent!.id);
  });

  test('PATCH /users/roles/:id updates displayName and prevents name update', async () => {
    const roleName = `qa_role_patch_${Date.now()}`;
    const created = await prisma.role.create({
      data: {
        name: roleName,
        displayName: 'Старое имя роли',
      },
    });

    const resUpdate = await request(app)
      .patch(`/users/roles/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayName: 'Новое имя роли' });

    expect(resUpdate.status).toBe(200);
    expect(resUpdate.body?.data?.displayName).toBe('Новое имя роли');

    const resRejectName = await request(app)
      .patch(`/users/roles/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'cannot_change_code' });

    expect(resRejectName.status).toBe(400);
  });

  test('PATCH /users/roles/:id rejects self-parent and cycles', async () => {
    const roleA = await prisma.role.create({
      data: {
        name: `qa_cycle_a_${Date.now()}`,
        displayName: 'Цикл A',
      },
    });
    const roleB = await prisma.role.create({
      data: {
        name: `qa_cycle_b_${Date.now()}`,
        displayName: 'Цикл B',
        parentRoleId: roleA.id,
      },
    });

    const selfParent = await request(app)
      .patch(`/users/roles/${roleA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parentRoleId: roleA.id });
    expect(selfParent.status).toBe(400);

    const cycle = await request(app)
      .patch(`/users/roles/${roleA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parentRoleId: roleB.id });
    expect(cycle.status).toBe(400);
  });

  test('DELETE /users/roles/:id rejects deleting base roles', async () => {
    const baseRole = await prisma.role.findUnique({ where: { name: 'user' } });
    expect(baseRole).toBeTruthy();

    const res = await request(app)
      .delete(`/users/roles/${baseRole!.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });
});
