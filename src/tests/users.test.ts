import request from 'supertest';
import app from '../index.ts';
import prisma from '../prisma/client';

describe('Users API', () => {
  let authTokenAdmin: string;
  let authTokenUser: string;
  let testUserId: number;
  let testDepartmentId: number;

  beforeAll(async () => {
    // Здесь можно создать тестовых пользователей, отделы и получить токены
    // Для упрощения предполагаем, что токены уже есть
    authTokenAdmin = 'Bearer admin-token';
    authTokenUser = 'Bearer user-token';

    // Создаем тестовый отдел
    const department = await prisma.department.create({ data: { name: 'Test Department' } });
    testDepartmentId = department.id;

    // Создаем тестового пользователя
    const user = await prisma.user.create({
      data: {
        email: 'testuser@example.com',
        passwordHash: 'hashedpassword',
        roleId: 1, // Предполагается, что роль с id=1 существует
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    // Удаляем связанные записи, чтобы избежать ошибок внешних ключей
    await prisma.departmentRole.deleteMany({ where: { userId: testUserId } });
    await prisma.refreshToken.deleteMany({ where: { userId: testUserId } });
    await prisma.auditLog.deleteMany({ where: { userId: testUserId } });

    await prisma.user.deleteMany({ where: { id: testUserId } });
    await prisma.department.deleteMany({ where: { id: testDepartmentId } });
    await prisma.$disconnect();
  });

  test('User can update own department', async () => {
    const res = await request(app)
      .put('/users/me/department')
      .set('Authorization', authTokenUser)
      .send({ departmentId: testDepartmentId });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Department updated for current user');
  });

  test('Admin can update user department', async () => {
    const res = await request(app)
      .put(`/users/${testUserId}/department`)
      .set('Authorization', authTokenAdmin)
      .send({ departmentId: testDepartmentId });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(`Department updated for user ${testUserId}`);
  });

  test('Admin can assign department manager', async () => {
    const res = await request(app)
      .post(`/users/${testUserId}/department/${testDepartmentId}/manager`)
      .set('Authorization', authTokenAdmin);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(`User ${testUserId} assigned as manager of department ${testDepartmentId}`);
  });
});
