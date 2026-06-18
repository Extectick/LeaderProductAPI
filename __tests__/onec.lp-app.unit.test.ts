import request from 'supertest';
import jwt from 'jsonwebtoken';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.ONEC_SECRET = 'test-onec-secret';
process.env.ONEC_LP_APP_BASE_URL = 'http://onec.local/WMS10/hs/lp-app';
process.env.ONEC_LP_APP_API_KEY = 'lp-app-key';
process.env.ONEC_LP_APP_TIMEOUT_MS = '15000';

type Scenario = {
  userId: number;
  roleName: string;
  roleId: number;
  parentRoleId?: number | null;
  currentProfileType: 'EMPLOYEE' | 'CLIENT';
  onecUserGuid: string | null;
  onecPhysicalPersonGuid: string | null;
  permissions: string[];
};

const scenario: Scenario = {
  userId: 1,
  roleName: 'employee',
  roleId: 2,
  parentRoleId: 1,
  currentProfileType: 'EMPLOYEE',
  onecUserGuid: null,
  onecPhysicalPersonGuid: null,
  permissions: [],
};

const prismaMock = {
  $disconnect: jest.fn(),
  $connect: jest.fn(),
  user: {
    findUnique: jest.fn(async (args: any) => {
      if (args?.select?.profileStatus) {
        return { profileStatus: 'ACTIVE' };
      }

      if (args?.select?.employeeProfile && !args?.select?.roleId) {
        return {
          employeeProfile: {
            onecUserGuid: scenario.onecUserGuid,
            onecPhysicalPersonGuid: scenario.onecPhysicalPersonGuid,
          },
        };
      }

      if (args?.select?.roleId && args?.select?.role && args?.select?.currentProfileType) {
        return {
          id: scenario.userId,
          roleId: scenario.roleId,
          role: { name: scenario.roleName },
          currentProfileType: scenario.currentProfileType,
          employeeProfile: { departmentId: 1 },
          departmentRoles: [],
        };
      }

      if (args?.select?.roleId && args?.select?.departmentRoles) {
        return {
          roleId: scenario.roleId,
          departmentRoles: [],
        };
      }

      return null;
    }),
  },
  role: {
    findUnique: jest.fn(async (args: any) => {
      if (args?.where?.name) {
        if (args.where.name === 'admin') return { parentRole: null };
        if (args.where.name === 'department_manager') return { parentRole: { name: 'employee' } };
        if (args.where.name === 'employee') return { parentRole: { name: 'user' } };
        if (args.where.name === 'user') return { parentRole: null };
        return { parentRole: null };
      }

      if (args?.where?.id) {
        return { parentRoleId: args.where.id === scenario.roleId ? scenario.parentRoleId ?? null : null };
      }

      return null;
    }),
    findMany: jest.fn(async () => []),
  },
  rolePermissions: {
    findMany: jest.fn(async () =>
      scenario.permissions.map((name) => ({
        permission: { name },
      }))
    ),
  },
  service: {
    findUnique: jest.fn(async () => ({
      id: 10,
      key: 'transport_tasks',
      name: 'Задания на перевозку',
      kind: 'CLOUD',
      route: '/services/transport_tasks',
      icon: 'map-outline',
      description: null,
      gradientStart: null,
      gradientEnd: null,
      isActive: true,
      defaultVisible: true,
      defaultEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  },
  serviceRoleAccess: {
    findMany: jest.fn(async () => []),
  },
  serviceDepartmentAccess: {
    findMany: jest.fn(async () => []),
  },
};

jest.mock('../src/prisma/client', () => ({
  __esModule: true,
  default: prismaMock,
  prisma: prismaMock,
}));

import app from '../src/index';

const fetchMock = jest.fn();

function token(role = scenario.roleName) {
  return jwt.sign(
    { userId: scenario.userId, role, permissions: [], profileStatus: 'ACTIVE' },
    process.env.ACCESS_TOKEN_SECRET || 'test_jwt_secret',
    { expiresIn: '1h' }
  );
}

function setScenario(patch: Partial<Scenario>) {
  Object.assign(scenario, patch);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/1c/lp-app proxy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).fetch = fetchMock;
    setScenario({
      userId: 1,
      roleName: 'employee',
      roleId: 2,
      parentRoleId: 1,
      currentProfileType: 'EMPLOYEE',
      onecUserGuid: '11111111-1111-1111-1111-111111111111',
      onecPhysicalPersonGuid: '11111111-1111-1111-1111-111111111111',
      permissions: ['view_transport_tasks', 'update_transport_route_order'],
    });
    fetchMock.mockResolvedValue(jsonResponse({ status: 'success' }));
  });

  it('requires JWT', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await request(app).get('/api/1c/lp-app/ping');

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns 409 when employee has no 1C binding guid', async () => {
    setScenario({ onecUserGuid: null, onecPhysicalPersonGuid: null });

    const response = await request(app)
      .get('/api/1c/lp-app/transport-tasks')
      .set('Authorization', `Bearer ${token()}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores spoofed driverGuid for regular employee', async () => {
    await request(app)
      .get('/api/1c/lp-app/transport-tasks')
      .query({ driverGuid: '22222222-2222-2222-2222-222222222222', limit: 10 })
      .set('Authorization', `Bearer ${token()}`)
      .expect(200);

    const calledUrl = fetchMock.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get('driverGuid')).toBeNull();
    expect(calledUrl.searchParams.get('driverPhysicalPersonGuid')).toBe('11111111-1111-1111-1111-111111111111');
    expect(calledUrl.searchParams.get('driverUserGuid')).toBeNull();
    expect(calledUrl.searchParams.get('limit')).toBe('10');
  });

  it('allows manager to pass driverGuid', async () => {
    setScenario({
      roleName: 'department_manager',
      roleId: 3,
      parentRoleId: 2,
      permissions: ['view_transport_tasks', 'update_transport_route_order', 'manage_transport_tasks'],
    });

    await request(app)
      .get('/api/1c/lp-app/transport-tasks')
      .query({ driverGuid: '33333333-3333-3333-3333-333333333333' })
      .set('Authorization', `Bearer ${token('department_manager')}`)
      .expect(200);

    const calledUrl = fetchMock.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get('driverGuid')).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('validates route-order body', async () => {
    const response = await request(app)
      .post('/api/1c/lp-app/transport-tasks/task-guid/route-order')
      .set('Authorization', `Bearer ${token()}`)
      .send({ route: 'bad' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream 409 to conflict', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', error: 'Документ не в статусе КПогрузке' }, 409));

    const response = await request(app)
      .post('/api/1c/lp-app/transport-tasks/task-guid/route-order')
      .set('Authorization', `Bearer ${token()}`)
      .send({ route: [{ linkKey: 'link-1', order: 1 }] });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.message).toBe('Документ не в статусе КПогрузке');
  });

  it('maps network errors to 502', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const response = await request(app)
      .get('/api/1c/lp-app/ping')
      .set('Authorization', `Bearer ${token()}`);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.message).toBe('Ошибка обмена с 1С');
  });

  it('keeps old /api/1c schema route on ONEC_SECRET auth', async () => {
    const response = await request(app).get('/api/1c/schema').query({ secret: 'test-onec-secret' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('keeps old /api/1c batch routes protected by ONEC_SECRET', async () => {
    const response = await request(app).post('/api/1c/nomenclature/batch').send({ items: [] });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Unauthorized');
  });
});
