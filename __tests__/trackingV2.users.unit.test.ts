import express from 'express';
import request from 'supertest';

const mockPrisma = {
  user: { findMany: jest.fn(), findUnique: jest.fn() },
  trackingDeviceToken: { findMany: jest.fn() },
};
let mockViewer = { userId: 7, role: 'admin', permissions: [] as string[] };
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: () => void) => { req.user = mockViewer; next(); } }));
jest.mock('../src/middleware/checkUserStatus', () => ({ checkUserStatus: (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/middleware/serviceAccess', () => ({ authorizeServiceAccess: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/middleware/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock('../src/services/pushService', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../src/storage/minio', () => ({ resolveObjectUrl: jest.fn(async (value: string) => value ? `https://files.test/${value}` : null) }));
import router from '../src/routes/trackingV2';
const app = express();
app.use('/tracking', router);

beforeEach(() => {
  jest.clearAllMocks();
  mockViewer = { userId: 7, role: 'admin', permissions: [] };
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue({ employeeProfile: { departmentId: 3 }, departmentRoles: [] });
  mockPrisma.trackingDeviceToken.findMany.mockResolvedValue([]);
});

it('requires an active employee profile and active non-deleted account, regardless of selected profile type', async () => {
  expect((await request(app).get('/tracking/users')).status).toBe(200);
  const { where } = mockPrisma.user.findMany.mock.calls[0][0];
  expect(where).toMatchObject({ isActive: true, deletedAt: null, profileStatus: 'ACTIVE', employeeProfile: { is: { status: 'ACTIVE' } } });
  expect(where.currentProfileType).toBeUndefined();
});

it('keeps department visibility AND full-name/department/role search together', async () => {
  mockViewer.role = 'department_manager';
  await request(app).get('/tracking/users').query({ q: 'Иванов Иван продажи' });
  const { where } = mockPrisma.user.findMany.mock.calls[0][0];
  expect(where.OR).toBeUndefined();
  expect(where.AND).toHaveLength(4);
  expect(where.AND[0].OR).toContainEqual({ employeeProfile: { departmentId: { in: [3] } } });
  expect(where.AND[0].OR).toContainEqual({ id: 7 });
  expect(where.AND[1].OR).toContainEqual({ lastName: { contains: 'Иванов', mode: 'insensitive' } });
  expect(where.AND[2].OR).toContainEqual({ firstName: { contains: 'Иван', mode: 'insensitive' } });
  expect(where.AND[3].OR).toContainEqual({ employeeProfile: { department: { name: { contains: 'продажи', mode: 'insensitive' } } } });
  expect(where.AND[3].OR).toContainEqual({ role: { OR: [{ name: { contains: 'продажи', mode: 'insensitive' } }, { displayName: { contains: 'продажи', mode: 'insensitive' } }] } });
});

it('selects self by authenticated id, independent of alphabetical pages', async () => {
  await request(app).get('/tracking/users').query({ self: 'true', offset: 100, userId: 99 });
  expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [{ id: 7 }] }), skip: 0, take: 1 }));
});

it('does not broaden employee visibility on search, and supports stable subsequent pages', async () => {
  mockViewer.role = 'employee';
  await request(app).get('/tracking/users').query({ q: 'Начальник', offset: 100 });
  const options = mockPrisma.user.findMany.mock.calls[0][0];
  expect(options.where.AND[0]).toEqual({ id: 7 });
  expect(options.skip).toBe(100);
  expect(options.orderBy).toContainEqual({ id: 'asc' });
});

it('returns the employee avatar, current department and unique readable roles', async () => {
  const role = { id: 1, name: 'manager', displayName: 'Менеджер' };
  const department = { id: 3, name: 'Продажи' };
  mockPrisma.user.findMany.mockResolvedValue([{ id: 7, firstName: 'Иван', role, departmentRoles: [{ role }], avatarUrl: 'old.jpg', employeeProfile: { avatarUrl: 'employee.jpg', activeDepartment: department, departmentRoles: [] } }]);
  const response = await request(app).get('/tracking/users');
  expect(response.status).toBe(200);
  expect(response.body.data[0]).toMatchObject({ id: 7, avatarUrl: 'https://files.test/employee.jpg', department, role, roles: [role] });
});
