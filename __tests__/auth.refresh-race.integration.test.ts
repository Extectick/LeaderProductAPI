import bcrypt from 'bcryptjs';
import request from 'supertest';
import app, { prisma } from '../src';

function uniq(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('Auth refresh race integration', () => {
  const createdUserIds = new Set<number>();
  const createdDepartmentIds = new Set<number>();

  async function cleanupUsers() {
    const ids = Array.from(createdUserIds);
    const departmentIds = Array.from(createdDepartmentIds);

    if (ids.length) {
      await prisma.routePoint.deleteMany({ where: { userId: { in: ids } } });
      await prisma.userRoute.deleteMany({ where: { userId: { in: ids } } });
      await prisma.loginAttempt.deleteMany({ where: { userId: { in: ids } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.deviceSession.deleteMany({ where: { userId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await prisma.departmentRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.clientProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.supplierProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    if (departmentIds.length) {
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    }

    createdUserIds.clear();
    createdDepartmentIds.clear();
  }

  beforeEach(async () => {
    await cleanupUsers();
  });

  afterEach(async () => {
    await cleanupUsers();
  });

  it('allows only one concurrent rotation for the same refresh token', async () => {
    const role = await prisma.role.findUnique({ where: { name: 'employee' } });
    expect(role).toBeTruthy();

    const password = 'RacePass123!';
    const department = await prisma.department.create({
      data: { name: uniq('refresh_race_dept') },
      select: { id: true },
    });
    createdDepartmentIds.add(department.id);
    const user = await prisma.user.create({
      data: {
        email: `${uniq('refresh_race')}@example.com`,
        passwordHash: await bcrypt.hash(password, 10),
        roleId: role!.id,
        isActive: true,
        profileStatus: 'ACTIVE',
        currentProfileType: 'EMPLOYEE',
        employeeProfile: {
          create: {
            departmentId: department.id,
            activeDepartmentId: department.id,
            status: 'ACTIVE',
          },
        },
      },
      select: { id: true, email: true },
    });
    createdUserIds.add(user.id);

    const loginResponse = await request(app)
      .post('/auth/login')
      .send({
        email: user.email,
        password,
        installId: 'refresh-race-install',
        platform: 'integration-test',
        appVersion: 'race',
        deviceName: 'Race Test',
      });
    expect(loginResponse.status).toBe(200);

    let refreshToken = loginResponse.body?.data?.refreshToken as string;
    const deviceSessionId = loginResponse.body?.data?.deviceSessionId as string;
    expect(refreshToken).toBeTruthy();
    expect(deviceSessionId).toBeTruthy();

    for (let round = 0; round < 5; round += 1) {
      const body = {
        refreshToken,
        deviceSessionId,
        installId: 'refresh-race-install',
        platform: 'integration-test',
        appVersion: `race-${round}`,
        deviceName: 'Race Test',
      };

      const [first, second] = await Promise.all([
        request(app).post('/auth/token').send(body),
        request(app).post('/auth/token').send(body),
      ]);
      const responses = [first, second];
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([200, 409]);

      const success = responses.find((response) => response.status === 200);
      const conflict = responses.find((response) => response.status === 409);
      expect(success?.body?.data?.refreshToken).toBeTruthy();
      expect(conflict?.body).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' },
      });
      expect(conflict?.body?.error?.details).toMatchObject({
        reason: 'REFRESH_TOKEN_ROTATED',
      });

      refreshToken = success!.body.data.refreshToken;
    }

    const tokenRows = await prisma.refreshToken.findMany({
      where: { userId: user.id },
      orderBy: { id: 'asc' },
    });
    expect(tokenRows.filter((row) => !row.revoked)).toHaveLength(1);
    expect(tokenRows.filter((row) => row.revoked)).toHaveLength(5);
    expect(tokenRows.slice(0, -1).every((row) => row.replacedById)).toBe(true);
  });
});
