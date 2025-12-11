import request from 'supertest';
import { AppealStatus, AppealPriority } from '@prisma/client';
import { attachIoStub } from '../utils/app';
import { createUserWithRole, signToken } from '../utils/auth';
import prisma from '../../src/prisma/client';

let app: any;


describe('Appeals routes (auth + roles + permissions)', () => {
  let employeeUser: any;
  let employeeToken: string;
  let clientUser: any;
  let clientToken: string;
  let managerUser: any;
  let managerToken: string;

  beforeAll(async () => {
    const mod = await import('../../src/index'); // <<< динамический импорт
    app = mod.default;
    attachIoStub(app);
    // employee (может создавать обращения)
    employeeUser = await createUserWithRole('emp@example.com', 'employee', 'EMPLOYEE');
    employeeToken = signToken(employeeUser.id, 'employee');

    // client (не может создавать обращения)
    clientUser = await createUserWithRole('client@example.com', 'user', 'CLIENT');
    clientToken = signToken(clientUser.id, 'user');

    // руководитель отдела (назначение)
    managerUser = await createUserWithRole('manager@example.com', 'department_manager', 'EMPLOYEE');
    managerToken = signToken(managerUser.id, 'department_manager');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('Создание обращения — EMPLOYEE: 201, CLIENT: 403', async () => {
    // нужный отдел получателя (создадим)
    const dept = await prisma.department.create({ data: { name: `Accounting_${Date.now()}` } });

    // Успешно для employee
    const resOk = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Нужно подготовить документ')
      .field('text', 'Просьба подготовить акт сверки')
      .field('priority', AppealPriority.MEDIUM);

    expect(resOk.status).toBe(201);
    expect(resOk.body?.ok).toBe(true);
    const createdId = resOk.body?.data?.id;
    expect(createdId).toBeDefined();

    // Для client — запрет (нет прав create_appeal + не employee)
    const resForbidden = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${clientToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Запрос от клиента')
      .field('text', 'Сформировать документ');

    expect([401, 403]).toContain(resForbidden.status);
  });

  test('Список обращений scope=my — EMPLOYEE видит свои', async () => {
    const res = await request(app)
      .get('/appeals')
      .query({ scope: 'my', limit: 10, offset: 0 })
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(Array.isArray(res.body?.data?.data)).toBe(true);
    // meta
    expect(res.body?.data?.meta).toBeDefined();
  });

  test('Назначение исполнителей — только руководитель/менеджер', async () => {
    // Сначала — employee создаёт обращение
    const dept = await prisma.department.create({ data: { name: `IT_${Date.now()}` } });
    const created = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Тест назначений')
      .field('text', 'Надо назначить исполнителя');

    expect(created.status).toBe(201);
    const appealId = created.body?.data?.id;

    // Пытаемся назначить исполнителей как employee — должно быть запрещено (нет assign_appeal)
    const resForbidden = await request(app)
      .put(`/appeals/${appealId}/assign`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ assigneeIds: [employeeUser.id] });

    expect([401, 403]).toContain(resForbidden.status);

    // Назначаем как manager — ок
    const resManager = await request(app)
      .put(`/appeals/${appealId}/assign`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ assigneeIds: [employeeUser.id] });

    expect(resManager.status).toBe(200);
    expect(resManager.body?.ok).toBe(true);

    // Проверим, что статус IN_PROGRESS
    const dbAppeal = await prisma.appeal.findUnique({ where: { id: appealId } });
    expect(dbAppeal?.status).toBe(AppealStatus.IN_PROGRESS);
  });

  test('Смена статуса — только при наличии update_appeal_status', async () => {
    const dept = await prisma.department.create({ data: { name: `HR_${Date.now()}` } });
    const created = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Тест статусов')
      .field('text', 'Сменить статус');

    const appealId = created.body?.data?.id;

    // employee без прав update_appeal_status — должен получить запрет
    const resForbidden = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ status: AppealStatus.RESOLVED });

    expect([401, 403]).toContain(resForbidden.status);

    // manager — может
    const resOk = await request(app)
      .put(`/appeals/${appealId}/status`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ status: AppealStatus.RESOLVED });

    expect(resOk.status).toBe(200);
    const dbAppeal = await prisma.appeal.findUnique({ where: { id: appealId } });
    expect(dbAppeal?.status).toBe(AppealStatus.RESOLVED);
  });

  test('Детали обращения — автор/исполнитель/сотрудник отдела-получателя имеют доступ', async () => {
    const dept = await prisma.department.create({ data: { name: `ACC_${Date.now()}` } });
    const created = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Детали обращения')
      .field('text', 'Проверка доступа');

    const appealId = created.body?.data?.id;

    // автор (employee) — видит
    const res = await request(app)
      .get(`/appeals/${appealId}`)
      .set('Authorization', `Bearer ${employeeToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.id).toBe(appealId);
  });

  test('Повторная отправка сообщения создаёт новую запись', async () => {
    // создаём обращение
    const dept = await prisma.department.create({ data: { name: `MSG_${Date.now()}` } });
    const created = await request(app)
      .post('/appeals')
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('toDepartmentId', String(dept.id))
      .field('title', 'Message repeat test')
      .field('text', 'First appeal');

    const appealId = created.body?.data?.id;

    // отправляем два сообщения подряд
    const first = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('text', 'Hello');
    const second = await request(app)
      .post(`/appeals/${appealId}/messages`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .field('text', 'Hello again');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body?.data?.id).not.toBe(first.body?.data?.id);

    // в БД должно быть 3 сообщения (первое при создании + два отправленных)
    const count = await prisma.appealMessage.count({ where: { appealId } });
    expect(count).toBe(3);
  });
});
