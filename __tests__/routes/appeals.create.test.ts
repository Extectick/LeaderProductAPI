import request from 'supertest';
import prisma from '../../src/prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';

let app: any;

describe('Appeals create title fallback', () => {
  let employeeUser: any;
  let employeeToken: string;
  let toDepartmentId: number;

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

    employeeUser = await createUserWithRole('title-fallback@example.com', 'employee', 'EMPLOYEE');
    employeeToken = signToken(employeeUser.id, 'employee');

    const department = await prisma.department.create({
      data: { name: `TitleFallback_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` },
    });
    toDepartmentId = department.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('uses first message text as title when title is empty', async () => {
    const text = '  Текст как заголовок  ';
    const res = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(toDepartmentId))
      .field('text', text);

    expect(res.status).toBe(201);
    const appealId = res.body?.data?.id as number;
    expect(appealId).toBeDefined();

    const saved = await prisma.appeal.findUnique({ where: { id: appealId } });
    expect(saved?.title).toBe('Текст как заголовок');
  });

  test('keeps explicit title when it is provided', async () => {
    const text = 'Текст сообщения';
    const title = '  Явный заголовок  ';
    const res = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(toDepartmentId))
      .field('title', title)
      .field('text', text);

    expect(res.status).toBe(201);
    const appealId = res.body?.data?.id as number;
    expect(appealId).toBeDefined();

    const saved = await prisma.appeal.findUnique({ where: { id: appealId } });
    expect(saved?.title).toBe('Явный заголовок');
  });
});
