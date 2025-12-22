import request from 'supertest';
import jwt from 'jsonwebtoken';
import app, { prisma } from '../../src';
import { AppealStatus, ProfileStatus } from '@prisma/client';

/**
 * Генерирует Bearer-токен для пользователя с заданной ролью/правами.
 */
function createToken(userId: number, role: string) {
  const secret = process.env.ACCESS_TOKEN_SECRET || 'test_jwt_secret';
  return jwt.sign(
    {
      userId,
      role,
      permissions: ['create_appeal', 'view_appeal', 'add_appeal_message'],
      profileStatus: ProfileStatus.ACTIVE,
    },
    secret,
    { expiresIn: '1h' }
  );
}

describe('Appeals API', () => {
  let adminId: number;
  let token: string;
  let toDepartmentId: number;

  beforeAll(async () => {
    // Чистим связанные сущности, чтобы избежать конфликтов уникальности номеров
    await prisma.appealMessageRead.deleteMany();
    await prisma.appealAttachment.deleteMany();
    await prisma.appealMessage.deleteMany();
    await prisma.appealWatcher.deleteMany();
    await prisma.appealAssignee.deleteMany();
    await prisma.appealStatusHistory.deleteMany();
    await prisma.appeal.deleteMany();

    const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
    if (!adminRole) throw new Error('Admin role not found in test DB');

    const admin = await prisma.user.create({
      data: {
        email: 'appeals-admin@example.com',
        passwordHash: 'test-hash',
        roleId: adminRole.id,
        profileStatus: ProfileStatus.ACTIVE,
      },
    });
    adminId = admin.id;
    token = createToken(admin.id, 'admin');

    const dept = await prisma.department.upsert({
      where: { name: 'Test Department' },
      update: {},
      create: { name: 'Test Department' },
    });
    toDepartmentId = dept.id;
  });

  afterAll(async () => {
    await prisma.appealMessageRead.deleteMany();
    await prisma.appealAttachment.deleteMany();
    await prisma.appealMessage.deleteMany();
    await prisma.appealWatcher.deleteMany();
    await prisma.appealAssignee.deleteMany();
    await prisma.appealStatusHistory.deleteMany();
    await prisma.appeal.deleteMany();
    await prisma.user.deleteMany({ where: { id: adminId } });
  });

  it('должен создать обращение', async () => {
    const res = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${token}`)
      .field('toDepartmentId', String(toDepartmentId))
      .field('text', 'Первое тестовое сообщение')
      .field('title', 'Тестовое обращение');

    expect(res.status).toBe(201);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.id).toBeDefined();
    expect(res.body?.data?.status).toBe(AppealStatus.OPEN);
  });

  it('должен добавить сообщение и пометить его прочитанным', async () => {
    // Создаём новое обращение
    const createdAppeal = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${token}`)
      .field('toDepartmentId', String(toDepartmentId))
      .field('text', 'Сообщение для чата')
      .field('title', 'Обращение для сообщений');

    const appealId = createdAppeal.body.data.id as number;

    // Добавляем сообщение
    const msgRes = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Второе сообщение');

    expect(msgRes.status).toBe(201);
    expect(msgRes.body?.ok).toBe(true);
    const messageId = msgRes.body.data.id as number;

    // Помечаем прочитанным
    const readRes = await request(app)
      .post(`/appeals/${appealId}/messages/${messageId}/read`)
      .set('Authorization', `Bearer ${token}`);

    expect(readRes.status).toBe(200);
    expect(readRes.body?.ok).toBe(true);

    // Проверяем деталку: сообщение должно иметь readBy с нашим userId
    const detailRes = await request(app)
      .get(`/appeals/${appealId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(detailRes.status).toBe(200);
    const messages = detailRes.body?.data?.messages ?? [];
    const found = messages.find((m: any) => m.id === messageId);
    expect(found).toBeDefined();
    expect(found.isRead).toBe(true);
    expect(found.readBy.some((r: any) => r.userId === adminId)).toBe(true);
  });
});
