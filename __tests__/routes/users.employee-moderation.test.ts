import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Users employee moderation API', () => {
  let adminToken = '';

  beforeAll(async () => {
    const mod = await import('../../src/index');
    app = mod.default;
    attachIoStub(app);

    const admin = await createUserWithRole('employee-moderation-admin@example.com', 'admin', 'EMPLOYEE');
    adminToken = signToken(admin.id, 'admin');
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });

  async function createEmployeeCandidate(params: {
    email: string;
    roleName: 'user' | 'employee' | 'department_manager' | 'admin';
    status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
    currentProfileType?: 'EMPLOYEE' | 'CLIENT' | 'SUPPLIER' | null;
  }) {
    const role = await prisma.role.findUnique({ where: { name: params.roleName }, select: { id: true } });
    if (!role) throw new Error(`Role ${params.roleName} not found`);

    const user = await prisma.user.create({
      data: {
        email: `${params.email}.${Date.now()}.${Math.random().toString(36).slice(2, 5)}@example.com`,
        passwordHash: 'x',
        isActive: true,
        profileStatus: 'ACTIVE',
        roleId: role.id,
        currentProfileType: params.currentProfileType === undefined ? 'EMPLOYEE' : params.currentProfileType,
      },
    });

    const department = await prisma.department.create({
      data: {
        name: `QA Moderation Dept ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`,
      },
    });

    await prisma.employeeProfile.create({
      data: {
        userId: user.id,
        departmentId: department.id,
        status: params.status,
      },
    });

    return user;
  }

  test('APPROVE sets employee profile ACTIVE and upgrades role user -> employee', async () => {
    const candidate = await createEmployeeCandidate({
      email: 'candidate-approve-user',
      roleName: 'user',
      status: 'PENDING',
      currentProfileType: 'EMPLOYEE',
    });

    const res = await request(app)
      .post(`/users/${candidate.id}/employee-moderation`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'APPROVE' });

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.moderation?.employeeStatusAfter).toBe('ACTIVE');

    const updated = await prisma.user.findUnique({
      where: { id: candidate.id },
      select: {
        role: { select: { name: true } },
        employeeProfile: { select: { status: true } },
      },
    });

    expect(updated?.employeeProfile?.status).toBe('ACTIVE');
    expect(updated?.role?.name).toBe('employee');

    const audit = await prisma.auditLog.findFirst({
      where: { targetType: 'EMPLOYEE_MODERATION', targetId: candidate.id },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  test('APPROVE does not overwrite higher role', async () => {
    const candidate = await createEmployeeCandidate({
      email: 'candidate-approve-admin',
      roleName: 'admin',
      status: 'PENDING',
      currentProfileType: 'EMPLOYEE',
    });

    const res = await request(app)
      .post(`/users/${candidate.id}/employee-moderation`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'APPROVE' });

    expect(res.status).toBe(200);

    const updated = await prisma.user.findUnique({
      where: { id: candidate.id },
      select: {
        role: { select: { name: true } },
        employeeProfile: { select: { status: true } },
      },
    });

    expect(updated?.employeeProfile?.status).toBe('ACTIVE');
    expect(updated?.role?.name).toBe('admin');
  });

  test('REJECT sets employee profile BLOCKED, downgrades role employee -> user and resets currentProfileType', async () => {
    const candidate = await createEmployeeCandidate({
      email: 'candidate-reject-employee',
      roleName: 'employee',
      status: 'ACTIVE',
      currentProfileType: 'EMPLOYEE',
    });

    const res = await request(app)
      .post(`/users/${candidate.id}/employee-moderation`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'REJECT', reason: 'Тестовая причина' });

    expect(res.status).toBe(200);
    expect(res.body?.data?.moderation?.employeeStatusAfter).toBe('BLOCKED');

    const updated = await prisma.user.findUnique({
      where: { id: candidate.id },
      select: {
        role: { select: { name: true } },
        currentProfileType: true,
        employeeProfile: { select: { status: true } },
      },
    });

    expect(updated?.employeeProfile?.status).toBe('BLOCKED');
    expect(updated?.role?.name).toBe('user');
    expect(updated?.currentProfileType).toBeNull();
  });

  test('GET /users/admin/list returns paginated data with moderationState filter', async () => {
    await createEmployeeCandidate({
      email: 'candidate-list-pending-1',
      roleName: 'user',
      status: 'PENDING',
      currentProfileType: 'EMPLOYEE',
    });
    await createEmployeeCandidate({
      email: 'candidate-list-pending-2',
      roleName: 'user',
      status: 'PENDING',
      currentProfileType: 'EMPLOYEE',
    });

    const res = await request(app)
      .get('/users/admin/list?moderationState=EMPLOYEE_PENDING&page=1&limit=5&sortBy=name&sortDir=asc')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data?.items)).toBe(true);
    expect(typeof res.body?.data?.meta?.total).toBe('number');
    expect(res.body?.data?.meta?.page).toBe(1);
    expect(res.body?.data?.meta?.limit).toBe(5);

    for (const item of res.body?.data?.items || []) {
      expect(item.moderationState).toBe('EMPLOYEE_PENDING');
    }
  });
});
