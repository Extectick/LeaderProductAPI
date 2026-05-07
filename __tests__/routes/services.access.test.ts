import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Services access rules and diagnostics', () => {
  let adminToken = '';

  beforeAll(async () => {
    const mod = await import('../../src/index');
    app = mod.default;
    attachIoStub(app);

    const admin = await createUserWithRole('services-access-admin@example.com', 'admin', 'EMPLOYEE');
    adminToken = signToken(admin.id, 'admin');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('exact role rule overrides inherited parent role rule in effective service access', async () => {
    const unique = Date.now();
    const serviceKey = `svc_access_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Access Service ${unique}`,
        defaultVisible: false,
        defaultEnabled: false,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;
    expect(serviceId).toBeTruthy();

    const employeeRole = await prisma.role.findUnique({ where: { name: 'employee' } });
    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    expect(employeeRole).toBeTruthy();
    expect(managerRole).toBeTruthy();

    const rulesRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleAccess: [
          { roleId: employeeRole!.id, visible: false, enabled: false },
          { roleId: managerRole!.id, visible: true, enabled: true },
        ],
      });

    expect(rulesRes.status).toBe(200);
    expect(rulesRes.body?.data?.service?.roleAccess).toHaveLength(2);

    const managerUser = await createUserWithRole(
      'services-access-manager@example.com',
      'department_manager',
      'EMPLOYEE'
    );
    const managerToken = signToken(managerUser.id, 'department_manager');

    const listRes = await request(app)
      .get('/services')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(listRes.status).toBe(200);
    const service = (listRes.body?.data?.services || []).find((item: any) => item.key === serviceKey);
    expect(service).toBeTruthy();
    expect(service.visible).toBe(true);
    expect(service.enabled).toBe(true);

    const previewRes = await request(app)
      .get(`/services/${serviceId}/access-preview`)
      .query({ userId: managerUser.id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body?.data?.explanation?.access?.visible).toBe(true);
    expect(previewRes.body?.data?.explanation?.access?.enabled).toBe(true);
    expect(
      previewRes.body?.data?.explanation?.evaluation?.roleVisible?.matchedRules?.some(
        (rule: any) => rule.roleId === managerRole!.id
      )
    ).toBe(true);
  });

  test('access-rules endpoint replaces existing role and department rules', async () => {
    const unique = Date.now() + 1;
    const serviceKey = `svc_replace_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Replace Service ${unique}`,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;
    expect(serviceId).toBeTruthy();

    const employeeRole = await prisma.role.findUnique({ where: { name: 'employee' } });
    const department = await prisma.department.create({
      data: { name: `SvcReplaceDept_${unique}` },
    });

    const replaceRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleAccess: [{ roleId: employeeRole!.id, visible: true, enabled: true }],
        departmentAccess: [{ departmentId: department.id, visible: true, enabled: false }],
      });

    expect(replaceRes.status).toBe(200);
    expect(replaceRes.body?.data?.service?.roleAccess).toHaveLength(1);
    expect(replaceRes.body?.data?.service?.departmentAccess).toHaveLength(1);

    const clearRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleAccess: [],
        departmentAccess: [],
      });

    expect(clearRes.status).toBe(200);
    expect(clearRes.body?.data?.service?.roleAccess).toHaveLength(0);
    expect(clearRes.body?.data?.service?.departmentAccess).toHaveLength(0);
  });

  test('rejects impossible visible/enabled combinations', async () => {
    const unique = Date.now() + 2;
    const serviceKey = `svc_invalid_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Invalid Service ${unique}`,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;
    const employeeRole = await prisma.role.findUnique({ where: { name: 'employee' } });

    const invalidRuleRes = await request(app)
      .put(`/services/${serviceId}/role-access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleId: employeeRole!.id,
        visible: false,
        enabled: true,
      });

    expect(invalidRuleRes.status).toBe(400);
    expect(invalidRuleRes.body?.ok).toBe(false);

    const invalidServiceRes = await request(app)
      .patch(`/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        defaultVisible: false,
        defaultEnabled: true,
      });

    expect(invalidServiceRes.status).toBe(400);
    expect(invalidServiceRes.body?.ok).toBe(false);
  });

  test('user access override has priority over department and role rules', async () => {
    const unique = Date.now() + 3;
    const serviceKey = `svc_user_override_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `User Override Service ${unique}`,
        defaultVisible: false,
        defaultEnabled: false,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;
    expect(serviceId).toBeTruthy();

    const employeeRole = await prisma.role.findUnique({ where: { name: 'employee' } });
    const employeeUser = await createUserWithRole(
      'services-access-user-override@example.com',
      'employee',
      'EMPLOYEE'
    );
    const employeeToken = signToken(employeeUser.id, 'employee');
    const employeeProfile = await prisma.employeeProfile.findUnique({
      where: { userId: employeeUser.id },
      select: { departmentId: true },
    });

    const rulesRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleAccess: [{ roleId: employeeRole!.id, visible: true, enabled: true }],
        departmentAccess: [{ departmentId: employeeProfile!.departmentId!, visible: false, enabled: false }],
        userAccess: [{ userId: employeeUser.id, visible: true, enabled: true }],
      });

    expect(rulesRes.status).toBe(200);

    const listRes = await request(app)
      .get('/services')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(listRes.status).toBe(200);
    const service = (listRes.body?.data?.services || []).find((item: any) => item.key === serviceKey);
    expect(service).toBeTruthy();
    expect(service.visible).toBe(true);
    expect(service.enabled).toBe(true);

    const previewRes = await request(app)
      .get(`/services/${serviceId}/access-preview`)
      .query({ userId: employeeUser.id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body?.data?.explanation?.evaluation?.finalVisible?.source).toBe('user');
    expect(previewRes.body?.data?.explanation?.evaluation?.finalEnabled?.source).toBe('user');
    expect(previewRes.body?.data?.explanation?.access?.visible).toBe(true);
    expect(previewRes.body?.data?.explanation?.access?.enabled).toBe(true);
  });

  test('active department limits department rule evaluation to current context', async () => {
    const unique = Date.now() + 4;
    const serviceKey = `svc_active_department_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Active Department Service ${unique}`,
        defaultVisible: false,
        defaultEnabled: false,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;
    expect(serviceId).toBeTruthy();

    const employeeRole = await prisma.role.findUnique({ where: { name: 'employee' } });
    const employeeUser = await createUserWithRole(
      'services-access-active-department@example.com',
      'employee',
      'EMPLOYEE'
    );
    const employeeToken = signToken(employeeUser.id, 'employee');
    const employeeProfile = await prisma.employeeProfile.findUnique({
      where: { userId: employeeUser.id },
      select: { departmentId: true },
    });
    const secondaryDepartment = await prisma.department.create({
      data: { name: `SvcActiveDept_${unique}` },
    });

    await prisma.departmentRole.create({
      data: {
        userId: employeeUser.id,
        roleId: employeeRole!.id,
        departmentId: secondaryDepartment.id,
      },
    });

    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { activeDepartmentId: secondaryDepartment.id },
    });

    const rulesRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        departmentAccess: [
          { departmentId: employeeProfile!.departmentId!, visible: false, enabled: false },
          { departmentId: secondaryDepartment.id, visible: true, enabled: true },
        ],
      });

    expect(rulesRes.status).toBe(200);

    const listRes = await request(app)
      .get('/services')
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(listRes.status).toBe(200);
    const service = (listRes.body?.data?.services || []).find((item: any) => item.key === serviceKey);
    expect(service).toBeTruthy();
    expect(service.visible).toBe(true);
    expect(service.enabled).toBe(true);

    const previewRes = await request(app)
      .get(`/services/${serviceId}/access-preview`)
      .query({ userId: employeeUser.id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body?.data?.explanation?.context?.activeDepartmentId).toBe(secondaryDepartment.id);
    expect(previewRes.body?.data?.explanation?.evaluation?.finalVisible?.source).toBe('department');
    expect(
      previewRes.body?.data?.explanation?.evaluation?.departmentVisible?.matchedRules?.some(
        (rule: any) => rule.departmentId === secondaryDepartment.id
      )
    ).toBe(true);
    expect(
      previewRes.body?.data?.explanation?.evaluation?.departmentVisible?.matchedRules?.some(
        (rule: any) => rule.departmentId === employeeProfile!.departmentId
      )
    ).toBe(false);
  });

  test('access matrix returns evaluated access for matching users', async () => {
    const unique = Date.now() + 5;
    const serviceKey = `svc_matrix_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Matrix Service ${unique}`,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;

    const employeeUser = await createUserWithRole(
      'services-access-matrix@example.com',
      'employee',
      'EMPLOYEE'
    );

    const matrixRes = await request(app)
      .get(`/services/${serviceId}/access-matrix`)
      .query({ search: 'services-access-matrix', limit: 10 })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(matrixRes.status).toBe(200);
    expect(Array.isArray(matrixRes.body?.data?.items)).toBe(true);
    expect(matrixRes.body?.meta?.total).toBeGreaterThanOrEqual(1);
    expect(
      matrixRes.body?.data?.items?.some((item: any) => item.user?.id === employeeUser.id)
    ).toBe(true);
  });

  test('department role rule has priority over plain department rule', async () => {
    const unique = Date.now() + 6;
    const serviceKey = `svc_department_role_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Department Role Service ${unique}`,
        defaultVisible: false,
        defaultEnabled: false,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;

    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    const managerUser = await createUserWithRole(
      'services-access-department-role@example.com',
      'user',
      'EMPLOYEE'
    );
    const managerToken = signToken(managerUser.id, 'user');
    const managerProfile = await prisma.employeeProfile.findUnique({
      where: { userId: managerUser.id },
      select: { departmentId: true, activeDepartmentId: true },
    });

    await prisma.departmentRole.create({
      data: {
        userId: managerUser.id,
        roleId: managerRole!.id,
        departmentId: managerProfile!.departmentId!,
      },
    });
    await prisma.employeeProfile.update({
      where: { userId: managerUser.id },
      data: { activeDepartmentId: managerProfile!.departmentId! },
    });

    const rulesRes = await request(app)
      .put(`/services/${serviceId}/access-rules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        departmentAccess: [{ departmentId: managerProfile!.departmentId!, visible: false, enabled: false }],
        departmentRoleAccess: [
          {
            departmentId: managerProfile!.departmentId!,
            roleId: managerRole!.id,
            visible: true,
            enabled: true,
          },
        ],
      });

    expect(rulesRes.status).toBe(200);

    const listRes = await request(app)
      .get('/services')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(listRes.status).toBe(200);
    const service = (listRes.body?.data?.services || []).find((item: any) => item.key === serviceKey);
    expect(service).toBeTruthy();
    expect(service.visible).toBe(true);
    expect(service.enabled).toBe(true);

    const previewRes = await request(app)
      .get(`/services/${serviceId}/access-preview`)
      .query({ userId: managerUser.id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body?.data?.explanation?.evaluation?.finalVisible?.source).toBe('department_role');
    expect(previewRes.body?.data?.explanation?.evaluation?.finalEnabled?.source).toBe('department_role');
  });

  test('department reverse catalog endpoints save and return department role rules', async () => {
    const unique = Date.now() + 7;
    const serviceKey = `svc_department_catalog_${unique}`;

    const createRes = await request(app)
      .post('/services/admin')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        key: serviceKey,
        name: `Department Catalog Service ${unique}`,
        generatePermissionTemplate: false,
      });

    expect(createRes.status).toBe(200);
    const serviceId = createRes.body?.data?.service?.id;

    const department = await prisma.department.create({
      data: { name: `SvcCatalogDept_${unique}` },
    });
    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });

    const saveRes = await request(app)
      .put(`/services/departments/${department.id}/access-catalog`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        roleId: managerRole!.id,
        rules: [{ serviceId, visible: true, enabled: false }],
      });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body?.data?.role?.id).toBe(managerRole!.id);
    expect(
      saveRes.body?.data?.services?.find((item: any) => item.id === serviceId)?.departmentRoleRule?.visible
    ).toBe(true);

    const getRes = await request(app)
      .get(`/services/departments/${department.id}/access-catalog`)
      .query({ roleId: managerRole!.id })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.status).toBe(200);
    const serviceItem = getRes.body?.data?.services?.find((item: any) => item.id === serviceId);
    expect(serviceItem?.departmentRoleRule?.roleId).toBe(managerRole!.id);
    expect(serviceItem?.departmentRoleRule?.enabled).toBe(false);
  });
});
