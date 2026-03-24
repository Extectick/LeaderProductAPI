import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';
import { AppealLaborPaymentStatus, AppealStatus } from '@prisma/client';

let app: any;

describe('Appeals analytics + labor', () => {
  let managerUser: any;
  let managerToken: string;
  let employeeUser: any;
  let employeeToken: string;
  let adminUser: any;
  let adminToken: string;
  let foreignManagerUser: any;
  let foreignManagerToken: string;
  let managerRoleId: number;
  let managerDepartmentId: number;

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

    managerUser = await createUserWithRole('analytics-manager@example.com', 'department_manager', 'EMPLOYEE');
    employeeUser = await createUserWithRole('analytics-employee@example.com', 'employee', 'EMPLOYEE');
    adminUser = await createUserWithRole('analytics-admin@example.com', 'admin', 'EMPLOYEE');
    foreignManagerUser = await createUserWithRole('analytics-foreign-manager@example.com', 'department_manager', 'EMPLOYEE');

    managerToken = signToken(managerUser.id, 'department_manager');
    employeeToken = signToken(employeeUser.id, 'employee');
    adminToken = signToken(adminUser.id, 'admin');
    foreignManagerToken = signToken(foreignManagerUser.id, 'department_manager');

    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    if (!managerRole) throw new Error('department_manager role not found');
    managerRoleId = managerRole.id;

    const managerEmployee = await prisma.employeeProfile.findUnique({ where: { userId: managerUser.id } });
    if (!managerEmployee?.departmentId) throw new Error('manager department not found');
    managerDepartmentId = managerEmployee.departmentId;

    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { departmentId: managerDepartmentId },
    });

    const viewAnalytics = await prisma.permission.upsert({
      where: { name: 'view_appeals_analytics' },
      update: {},
      create: {
        name: 'view_appeals_analytics',
        displayName: 'Просмотр аналитики обращений',
        description: 'test',
      },
    });
    const manageLabor = await prisma.permission.upsert({
      where: { name: 'manage_appeal_labor' },
      update: {},
      create: {
        name: 'manage_appeal_labor',
        displayName: 'Управление трудозатратами',
        description: 'test',
      },
    });
    await prisma.rolePermissions.upsert({
      where: { roleId_permissionId: { roleId: managerRoleId, permissionId: viewAnalytics.id } },
      update: {},
      create: { roleId: managerRoleId, permissionId: viewAnalytics.id },
    });
    await prisma.rolePermissions.upsert({
      where: { roleId_permissionId: { roleId: managerRoleId, permissionId: manageLabor.id } },
      update: {},
      create: { roleId: managerRoleId, permissionId: manageLabor.id },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('analytics meta: manager has access, employee forbidden', async () => {
    const managerRes = await request(app)
      .get('/appeals/analytics/meta')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(managerRes.status).toBe(200);
    expect(managerRes.body?.ok).toBe(true);
    expect(managerRes.body?.data?.role?.isDepartmentManager).toBe(true);
    expect(
      (managerRes.body?.data?.availableDepartments || []).some((d: any) => d.id === managerDepartmentId)
    ).toBe(true);
    expect(Array.isArray(managerRes.body?.data?.availableAssignees)).toBe(true);
    expect(
      (managerRes.body?.data?.availableAssignees || []).some((u: any) => u.id === employeeUser.id)
    ).toBe(true);

    const employeeRes = await request(app)
      .get('/appeals/analytics/meta')
      .set('Authorization', `Bearer ${employeeToken}`);
    expect([401, 403]).toContain(employeeRes.status);
  });

  test('analytics appeals returns paginated data and hasMore', async () => {
    const createdById = employeeUser.id;
    for (let i = 0; i < 3; i++) {
      const appeal = await prisma.appeal.create({
        data: {
          number: 900000 + i + Math.floor(Math.random() * 1000),
          toDepartmentId: managerDepartmentId,
          createdById,
          title: `Analytics Appeal ${i}`,
          status: AppealStatus.IN_PROGRESS,
        },
      });
      await prisma.appealStatusHistory.createMany({
        data: [
          {
            appealId: appeal.id,
            oldStatus: AppealStatus.OPEN,
            newStatus: AppealStatus.IN_PROGRESS,
            changedById: managerUser.id,
            changedAt: new Date(Date.now() - 60 * 60 * 1000),
          },
          {
            appealId: appeal.id,
            oldStatus: AppealStatus.IN_PROGRESS,
            newStatus: AppealStatus.RESOLVED,
            changedById: managerUser.id,
            changedAt: new Date(Date.now() - 30 * 60 * 1000),
          },
        ],
      });
    }

    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const page1 = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, limit: 2, offset: 0 })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body?.data?.meta?.hasMore).toBe(true);
    expect(page1.body?.data?.data?.length).toBe(2);
    expect(page1.body?.data?.data?.[0]?.sla?.openDurationMs).toBeDefined();
    expect(page1.body?.data?.data?.[0]?.sla?.workDurationMs).toBeDefined();
    expect(page1.body?.data?.data?.[0]?.createdBy?.id).toBeDefined();
    expect(Array.isArray(page1.body?.data?.data?.[0]?.allowedStatuses)).toBe(true);
    expect(page1.body?.data?.data?.[0]?.actionPermissions?.canOpenParticipants).toBe(true);

    const page2 = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, limit: 2, offset: 2 })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body?.data?.meta?.hasMore).toBe(false);
    expect(page2.body?.data?.data?.length).toBeGreaterThanOrEqual(1);
  });

  test('analytics appeals supports filters by status/assignee/search', async () => {
    const createdById = employeeUser.id;
    const appeal = await prisma.appeal.create({
      data: {
        number: 910000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById,
        title: `Searchable analytics ${Date.now()}`,
        status: AppealStatus.OPEN,
      },
    });
    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get('/appeals/analytics/appeals')
      .query({
        fromDate,
        toDate,
        status: AppealStatus.OPEN,
        assigneeUserId: employeeUser.id,
        search: 'Searchable analytics',
        limit: 20,
        offset: 0,
      })
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect((res.body?.data?.data || []).some((row: any) => row.id === appeal.id)).toBe(true);
  });

  test('analytics appeals + kpi support paymentState filters', async () => {
    const baseTitle = `Payment state ${Date.now()}`;
    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 100 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 100 },
    });

    const paidAppeal = await prisma.appeal.create({
      data: {
        number: 920000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: `${baseTitle} PAID`,
        status: AppealStatus.IN_PROGRESS,
      },
    });
    const partialAppeal = await prisma.appeal.create({
      data: {
        number: 921000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: `${baseTitle} PARTIAL`,
        status: AppealStatus.IN_PROGRESS,
      },
    });
    const unsetAppeal = await prisma.appeal.create({
      data: {
        number: 922000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: `${baseTitle} UNSET`,
        status: AppealStatus.OPEN,
      },
    });
    const notRequiredAppeal = await prisma.appeal.create({
      data: {
        number: 923000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: `${baseTitle} NOT_REQUIRED`,
        status: AppealStatus.IN_PROGRESS,
      },
    });

    for (const appeal of [paidAppeal, partialAppeal, unsetAppeal, notRequiredAppeal]) {
      await prisma.appealAssignee.create({
        data: { appealId: appeal.id, userId: employeeUser.id },
      });
    }

    const paidLaborRes = await request(app)
      .put(`/appeals/${paidAppeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 8, paidHours: 8 }],
      });
    expect(paidLaborRes.status).toBe(200);

    const partialLaborRes = await request(app)
      .put(`/appeals/${partialAppeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 8, paidHours: 3 }],
      });
    expect(partialLaborRes.status).toBe(200);

    const notRequiredLaborRes = await request(app)
      .put(`/appeals/${notRequiredAppeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        laborNotRequired: true,
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 0, paidHours: 0 }],
      });
    expect(notRequiredLaborRes.status).toBe(200);
    expect(notRequiredLaborRes.body?.data?.laborNotRequired).toBe(true);
    expect(notRequiredLaborRes.body?.data?.laborEntries?.[0]?.paymentStatus).toBe(AppealLaborPaymentStatus.NOT_REQUIRED);

    const paidRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'PAID' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(paidRes.status).toBe(200);
    const paidIds = new Set((paidRes.body?.data?.data || []).map((row: any) => row.id));
    expect(paidIds.has(paidAppeal.id)).toBe(true);
    expect(paidIds.has(partialAppeal.id)).toBe(false);
    expect(paidIds.has(unsetAppeal.id)).toBe(false);
    expect(paidIds.has(notRequiredAppeal.id)).toBe(false);

    const unpaidRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'UNPAID' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(unpaidRes.status).toBe(200);
    const unpaidIds = new Set((unpaidRes.body?.data?.data || []).map((row: any) => row.id));
    expect(unpaidIds.has(partialAppeal.id)).toBe(true);
    expect(unpaidIds.has(paidAppeal.id)).toBe(false);

    const notRequiredRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'NOT_REQUIRED' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(notRequiredRes.status).toBe(200);
    const notRequiredIds = new Set((notRequiredRes.body?.data?.data || []).map((row: any) => row.id));
    expect(notRequiredIds.has(notRequiredAppeal.id)).toBe(true);
    expect(notRequiredIds.has(unsetAppeal.id)).toBe(false);

    const unsetRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'UNSET' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(unsetRes.status).toBe(200);
    const unsetIds = new Set((unsetRes.body?.data?.data || []).map((row: any) => row.id));
    expect(unsetIds.has(unsetAppeal.id)).toBe(true);
    expect(unsetIds.has(notRequiredAppeal.id)).toBe(false);
    expect(unsetIds.has(partialAppeal.id)).toBe(false);

    const allKpiRes = await request(app)
      .get('/appeals/analytics/kpi-dashboard')
      .query({ fromDate, toDate, search: baseTitle })
      .set('Authorization', `Bearer ${managerToken}`);
    const unpaidKpiRes = await request(app)
      .get('/appeals/analytics/kpi-dashboard')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'UNPAID' })
      .set('Authorization', `Bearer ${managerToken}`);
    const unsetKpiRes = await request(app)
      .get('/appeals/analytics/kpi-dashboard')
      .query({ fromDate, toDate, search: baseTitle, paymentState: 'UNSET' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(allKpiRes.status).toBe(200);
    expect(unpaidKpiRes.status).toBe(200);
    expect(unsetKpiRes.status).toBe(200);
    expect(unpaidKpiRes.body?.data?.appeals?.totalCount).toBeLessThan(allKpiRes.body?.data?.appeals?.totalCount);
    expect(unsetKpiRes.body?.data?.appeals?.totalCount).toBeGreaterThanOrEqual(1);
  });

  test('explicit laborNotRequired can be reverted back to unset state', async () => {
    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 120 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 120 },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 924000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: `Explicit not required ${Date.now()}`,
        status: AppealStatus.IN_PROGRESS,
      },
    });

    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const enableRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        laborNotRequired: true,
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 0, paidHours: 0 }],
      });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body?.data?.laborNotRequired).toBe(true);
    expect(enableRes.body?.data?.laborEntries?.[0]?.paymentStatus).toBe(AppealLaborPaymentStatus.NOT_REQUIRED);

    const disableRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        laborNotRequired: false,
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 0, paidHours: 0 }],
      });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body?.data?.laborNotRequired).toBe(false);
    expect(disableRes.body?.data?.laborEntries || []).toHaveLength(0);

    const unsetRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({
        fromDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        toDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        search: appeal.title,
        paymentState: 'UNSET',
      })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(unsetRes.status).toBe(200);
    const unsetIds = new Set((unsetRes.body?.data?.data || []).map((row: any) => row.id));
    expect(unsetIds.has(appeal.id)).toBe(true);
  });

  test('labor upsert normalizes paymentStatus to NOT_REQUIRED for no-pay department', async () => {
    const noPayDepartment = await prisma.department.create({
      data: {
        name: `NoPay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        appealPaymentRequired: false,
      },
    });

    await prisma.departmentRole.upsert({
      where: {
        userId_roleId_departmentId: {
          userId: managerUser.id,
          roleId: managerRoleId,
          departmentId: noPayDepartment.id,
        },
      },
      update: {},
      create: {
        userId: managerUser.id,
        roleId: managerRoleId,
        departmentId: noPayDepartment.id,
      },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 980000 + Math.floor(Math.random() * 1000),
        toDepartmentId: noPayDepartment.id,
        createdById: employeeUser.id,
        title: 'No pay appeal',
        status: AppealStatus.IN_PROGRESS,
      },
    });

    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const laborRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [
          {
            assigneeUserId: employeeUser.id,
            hours: 2.5,
            paymentStatus: AppealLaborPaymentStatus.PAID,
          },
        ],
      });

    expect(laborRes.status).toBe(200);
    expect(laborRes.body?.ok).toBe(true);
    expect(laborRes.body?.data?.paymentRequired).toBe(false);
    expect(laborRes.body?.data?.laborEntries?.[0]?.paymentStatus).toBe(AppealLaborPaymentStatus.NOT_REQUIRED);
  });

  test('labor upsert supports partial payments with accrued/paid fields', async () => {
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 10 },
    });
    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 5 },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 981000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: 'Partial pay appeal',
        status: AppealStatus.IN_PROGRESS,
      },
    });
    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const res = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 8, paidHours: 3 }],
      });

    expect(res.status).toBe(200);
    const row = res.body?.data?.laborEntries?.[0];
    expect(row?.accruedHours).toBe(8);
    expect(row?.paidHours).toBe(3);
    expect(row?.remainingHours).toBe(5);
    expect(row?.paymentStatus).toBe(AppealLaborPaymentStatus.PARTIAL);
  });

  test('labor upsert rejects paidHours greater than accruedHours', async () => {
    const appeal = await prisma.appeal.create({
      data: {
        number: 982000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: 'Invalid paid hours appeal',
        status: AppealStatus.IN_PROGRESS,
      },
    });
    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const res = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 2, paidHours: 3 }],
      });
    expect(res.status).toBe(400);
  });

  test('analytics users endpoint aggregates stats and includes users without activity', async () => {
    const idleUser = await createUserWithRole('analytics-idle@example.com', 'employee', 'EMPLOYEE');
    await prisma.employeeProfile.update({
      where: { userId: idleUser.id },
      data: { departmentId: managerDepartmentId },
    });

    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .get('/appeals/analytics/users')
      .query({ fromDate, toDate, departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.data?.data)).toBe(true);
    const rows = res.body?.data?.data || [];
    expect(rows.some((r: any) => r.user?.id === idleUser.id)).toBe(true);
    const idle = rows.find((r: any) => r.user?.id === idleUser.id);
    expect(idle?.stats?.appealsCount).toBe(0);
    expect(idle?.stats?.accruedHours).toBe(0);
  });

  test('sla dashboard returns p50/p90 metrics', async () => {
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get('/appeals/analytics/sla-dashboard')
      .query({ fromDate, toDate, departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.data?.transitions)).toBe(true);
    expect(res.body?.data?.transitions?.length).toBe(3);
  });

  test('kpi dashboard returns counters, timing and labor aggregates', async () => {
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get('/appeals/analytics/kpi-dashboard')
      .query({ fromDate, toDate, departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.appeals?.totalCount).toBeDefined();
    expect(res.body?.data?.timing?.avgTakeMs).toBeDefined();
    expect(res.body?.data?.labor?.currency).toBe('RUB');
  });

  test('effective rate 0 forces NOT_REQUIRED even when department requires payment', async () => {
    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 10 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 0 },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 983000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title: 'Zero rate appeal',
        status: AppealStatus.IN_PROGRESS,
      },
    });
    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const res = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 4, paidHours: 2 }],
      });
    expect(res.status).toBe(200);
    expect(res.body?.data?.laborEntries?.[0]?.payable).toBe(false);
    expect(res.body?.data?.laborEntries?.[0]?.paymentStatus).toBe(AppealLaborPaymentStatus.NOT_REQUIRED);
  });

  test('hourly rate update endpoint enforces role scope', async () => {
    const okRes = await request(app)
      .put(`/appeals/analytics/users/${employeeUser.id}/hourly-rate`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ hourlyRateRub: 17.5 });
    expect(okRes.status).toBe(200);
    expect(okRes.body?.data?.hourlyRateRub).toBe(17.5);

    const forbiddenRes = await request(app)
      .put(`/appeals/analytics/users/${employeeUser.id}/hourly-rate`)
      .set('Authorization', `Bearer ${foreignManagerToken}`)
      .send({ hourlyRateRub: 20 });
    expect(forbiddenRes.status).toBe(403);
  });

  test('changing employee hourly rate does not recalculate saved labor amounts', async () => {
    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 1000 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 1000 },
    });

    const title = `Locked labor rate ${Date.now()}`;
    const appeal = await prisma.appeal.create({
      data: {
        number: 984000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title,
        status: AppealStatus.IN_PROGRESS,
      },
    });
    await prisma.appealAssignee.create({
      data: { appealId: appeal.id, userId: employeeUser.id },
    });

    const saveLaborRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [{ assigneeUserId: employeeUser.id, accruedHours: 10, paidHours: 10 }],
      });
    expect(saveLaborRes.status).toBe(200);
    expect(saveLaborRes.body?.data?.laborEntries?.[0]?.effectiveHourlyRateRub).toBe(1000);
    expect(saveLaborRes.body?.data?.laborEntries?.[0]?.amountAccruedRub).toBe(10000);
    expect(saveLaborRes.body?.data?.laborEntries?.[0]?.amountPaidRub).toBe(10000);

    const rateChangeRes = await request(app)
      .put(`/appeals/analytics/users/${employeeUser.id}/hourly-rate`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ hourlyRateRub: 1200 });
    expect(rateChangeRes.status).toBe(200);

    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const appealsRes = await request(app)
      .get('/appeals/analytics/appeals')
      .query({ fromDate, toDate, search: title, limit: 10, offset: 0 })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(appealsRes.status).toBe(200);

    const row = (appealsRes.body?.data?.data || []).find((x: any) => x.id === appeal.id);
    expect(row).toBeTruthy();
    const laborRow = row?.laborEntries?.find((x: any) => x.assigneeUserId === employeeUser.id);
    expect(laborRow?.effectiveHourlyRateRub).toBe(1000);
    expect(laborRow?.amountAccruedRub).toBe(10000);
    expect(laborRow?.amountPaidRub).toBe(10000);
    expect(laborRow?.amountRemainingRub).toBe(0);
  });

  test('payment queue + bulk paid endpoint works', async () => {
    const queueRes = await request(app)
      .get('/appeals/analytics/payment-queue')
      .query({ departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(queueRes.status).toBe(200);
    const firstRow = queueRes.body?.data?.data?.[0];
    const firstDep = firstRow?.departments?.[0];
    const firstItem = firstDep?.items?.[0];
    if (!firstItem) return;
    const markRes = await request(app)
      .put('/appeals/analytics/payment-queue/mark-paid')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ appealId: firstItem.appealId, assigneeUserId: firstRow.assignee.id }] });
    expect(markRes.status).toBe(200);
    expect(typeof markRes.body?.data?.updated).toBe('number');
  });

  test('funnel + forecast + heatmap endpoints are available', async () => {
    const funnelRes = await request(app)
      .get('/appeals/analytics/funnel')
      .query({ departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(funnelRes.status).toBe(200);
    expect(Array.isArray(funnelRes.body?.data?.byStatus)).toBe(true);

    const forecastRes = await request(app)
      .get('/appeals/analytics/forecast')
      .query({ departmentId: managerDepartmentId, horizon: 'week' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(forecastRes.status).toBe(200);
    expect(Array.isArray(forecastRes.body?.data?.departments)).toBe(true);

    const heatmapRes = await request(app)
      .get('/appeals/analytics/heatmap')
      .query({ departmentId: managerDepartmentId })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(heatmapRes.status).toBe(200);
    expect(Array.isArray(heatmapRes.body?.data?.data)).toBe(true);
  });

  test('analytics export appeals returns real XLSX binary', async () => {
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .get('/appeals/analytics/export/appeals')
      .query({ fromDate, toDate, departmentId: managerDepartmentId, format: 'xlsx' })
      .set('Authorization', `Bearer ${managerToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'] || '')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.slice(0, 2).toString()).toBe('PK');
  });

  test('analytics export appeals supports selected columns and keeps default full export', async () => {
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const title = `Export columns ${Date.now()}`;

    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 100 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 100 },
    });
    await prisma.employeeProfile.update({
      where: { userId: managerUser.id },
      data: { departmentId: managerDepartmentId, appealLaborHourlyRate: 120 },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 930000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title,
        status: AppealStatus.IN_PROGRESS,
      },
    });
    await prisma.appealAssignee.createMany({
      data: [
        { appealId: appeal.id, userId: employeeUser.id },
        { appealId: appeal.id, userId: managerUser.id },
      ],
      skipDuplicates: true,
    });
    const laborRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [
          { assigneeUserId: employeeUser.id, accruedHours: 4, paidHours: 2 },
          { assigneeUserId: managerUser.id, accruedHours: 3, paidHours: 3 },
        ],
      });
    expect(laborRes.status).toBe(200);

    const selectedRes = await request(app)
      .get('/appeals/analytics/export/appeals')
      .query({
        fromDate,
        toDate,
        departmentId: managerDepartmentId,
        search: title,
        format: 'csv',
        columns: 'number,title,assignees,hoursAccrued,amountPaid',
      })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(selectedRes.status).toBe(200);
    const selectedCsv = String(selectedRes.text || '');
    const selectedHeader = selectedCsv.split('\n')[0] || '';
    expect(selectedHeader).toContain('№');
    expect(selectedHeader).toContain('Обращение');
    expect(selectedHeader).toContain('Исполнители');
    expect(selectedHeader).toContain('Часы начислено');
    expect(selectedHeader).toContain('Сумма оплачено');
    expect(selectedHeader).not.toContain('Статус');
    expect(selectedCsv.split('\n').length).toBeGreaterThan(2);

    const defaultRes = await request(app)
      .get('/appeals/analytics/export/appeals')
      .query({
        fromDate,
        toDate,
        departmentId: managerDepartmentId,
        search: title,
        format: 'csv',
      })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(defaultRes.status).toBe(200);
    const defaultHeader = String(defaultRes.text || '').split('\n')[0] || '';
    expect(defaultHeader).toContain('Статус');
    expect(defaultHeader).toContain('Ставка ₽/ч');
    expect(defaultHeader).toContain('Сумма к доплате');
  });
  test('analytics export appeals writes numeric hours and currency amounts to xlsx cells', async () => {
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const title = `Export xlsx numeric ${Date.now()}`;

    await prisma.department.update({
      where: { id: managerDepartmentId },
      data: { appealPaymentRequired: true, appealLaborHourlyRate: 100 },
    });
    await prisma.employeeProfile.update({
      where: { userId: employeeUser.id },
      data: { appealLaborHourlyRate: 100 },
    });
    await prisma.employeeProfile.update({
      where: { userId: managerUser.id },
      data: { departmentId: managerDepartmentId, appealLaborHourlyRate: 120 },
    });

    const appeal = await prisma.appeal.create({
      data: {
        number: 940000 + Math.floor(Math.random() * 1000),
        toDepartmentId: managerDepartmentId,
        createdById: employeeUser.id,
        title,
        status: AppealStatus.IN_PROGRESS,
      },
    });

    await prisma.appealAssignee.createMany({
      data: [
        { appealId: appeal.id, userId: employeeUser.id },
        { appealId: appeal.id, userId: managerUser.id },
      ],
      skipDuplicates: true,
    });

    const laborRes = await request(app)
      .put(`/appeals/${appeal.id}/labor`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        items: [
          { assigneeUserId: employeeUser.id, accruedHours: 4, paidHours: 2 },
          { assigneeUserId: managerUser.id, accruedHours: 3, paidHours: 3 },
        ],
      });
    expect(laborRes.status).toBe(200);

    const res = await request(app)
      .get('/appeals/analytics/export/appeals')
      .query({
        fromDate,
        toDate,
        departmentId: managerDepartmentId,
        search: title,
        format: 'xlsx',
        columns: 'title,hoursAccrued,amountPaid',
      })
      .set('Authorization', `Bearer ${managerToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);

    const { Workbook } = require('exceljs') as { Workbook: new () => any };
    const workbook = new Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.getWorksheet('Appeals');

    expect(sheet).toBeTruthy();
    expect(sheet.getCell('A2').value).toBe(title);
    expect(sheet.getCell('B2').value).toBe(7);
    expect(sheet.getCell('B2').numFmt).toBe('0.00');
    expect(sheet.getCell('C2').value).toBe(560);
    expect(String(sheet.getCell('C2').numFmt || '')).toContain('₽');
  });
});
