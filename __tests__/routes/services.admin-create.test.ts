import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Services admin creation with permission template', () => {
  let adminToken = '';

  beforeAll(async () => {
    const mod = await import('../../src/index');
    app = mod.default;
    attachIoStub(app);

    const admin = await createUserWithRole('service-admin@example.com', 'admin', 'EMPLOYEE');
    adminToken = signToken(admin.id, 'admin');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('POST /services/admin creates service + group + template permissions', async () => {
    const unique = Date.now();
    const serviceKey = `qa_service_${unique}`;
    const res = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `QA Service ${unique}`,
        route: `/services/${serviceKey}`,
        generatePermissionTemplate: true,
        permissionActions: ['view', 'create', 'update'],
      });

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.service?.key).toBe(serviceKey);
    expect(res.body?.data?.permissionGroup?.key).toBe(`service_${serviceKey}`);
    expect(Array.isArray(res.body?.data?.createdPermissions)).toBe(true);
    expect(res.body?.data?.createdPermissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: `view_${serviceKey}` }),
        expect.objectContaining({ name: `create_${serviceKey}` }),
        expect.objectContaining({ name: `update_${serviceKey}` }),
      ])
    );

    const adminRole = await prisma.role.findUnique({ where: { name: 'admin' }, select: { id: true } });
    expect(adminRole).toBeTruthy();
    const createdPermission = await prisma.permission.findUnique({
      where: { name: `view_${serviceKey}` },
      select: { id: true, group: { select: { key: true } } },
    });
    expect(createdPermission).toBeTruthy();
    expect(createdPermission?.group?.key).toBe(`service_${serviceKey}`);

    const rel = await prisma.rolePermissions.findUnique({
      where: {
        roleId_permissionId: {
          roleId: adminRole!.id,
          permissionId: createdPermission!.id,
        },
      },
    });
    expect(rel).toBeTruthy();
  });
});
