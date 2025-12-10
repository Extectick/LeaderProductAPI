import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { execSync } from 'child_process';

process.env.NODE_ENV = 'test';

// Подхватываем .env.test заранее, чтобы Prisma видел корректный postgres URL
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

// Отключаем Redis в тестах, чтобы не было лишних подключений/ошибок
process.env.REDIS_URL = '';

// Явно требуем DATABASE_URL для postgres; без него тесты не имеют смысла
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for tests. Set it in .env.test');
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test_refresh_secret';

// Применяем миграции к тестовой базе перед запуском
try {
  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string },
    cwd: process.cwd(),
  });
} catch (e) {
  // если миграции не проходят - падаем явно
  console.error('Failed to run prisma migrate deploy for tests', e);
  throw e;
}

const prisma = new PrismaClient();

beforeAll(async () => {
  // Применяем миграции
  // Если ты используешь Prisma Migrate, перед тестами имеет смысл выполнить миграции
  // В CI это можно сделать через shell-скрипт `npx prisma migrate deploy`
  // Здесь же сделаем простой sync через Prisma Client как демонстрацию (оставь deploy в скриптах CI)
  try {
    // Если есть миграции — раскомментируй:
    // await execa('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
  } catch (e) {
    // no-op
  }

  // Регистрируем базовые permissions/roles (минимально необходимые)
  const permissionNames = [
    // общие
    'view_profile', 'update_profile', 'logout',
    // обращения
    'create_appeal', 'view_appeal', 'assign_appeal',
    'update_appeal_status', 'add_appeal_message',
    'edit_appeal_message', 'delete_appeal_message',
    'manage_appeal_watchers',
    // для полноты — экспорт
    'export_appeals',
  ];
  for (const name of permissionNames) {
    await prisma.permission.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  const userRole = await prisma.role.upsert({
    where: { name: 'user' },
    update: {},
    create: { name: 'user' },
  });
  const employeeRole = await prisma.role.upsert({
    where: { name: 'employee' },
    update: {},
    create: { name: 'employee', parentRoleId: userRole.id },
  });
  const managerRole = await prisma.role.upsert({
    where: { name: 'department_manager' },
    update: {},
    create: { name: 'department_manager', parentRoleId: employeeRole.id },
  });
  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: { name: 'admin', parentRoleId: managerRole.id },
  });

// Назначаем базовые права
  const give = async (roleName: string, names: string[]) => {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) return;
    await prisma.rolePermissions.deleteMany({ where: { roleId: role.id } });
    for (const n of names) {
      const p = await prisma.permission.findUnique({ where: { name: n } });
      if (p) {
        await prisma.rolePermissions.create({
          data: { roleId: role.id, permissionId: p.id },
        });
      }
    }
  };
  await give('user', ['view_profile', 'update_profile', 'logout']);
  await give('employee', [
    'create_appeal',
    'view_appeal',
    'add_appeal_message',
    'edit_appeal_message',
    'delete_appeal_message',
    'manage_appeal_watchers',
  ]);
  await give('department_manager', ['assign_appeal', 'update_appeal_status', 'export_appeals']);

  // админ — все
  const allPerms = await prisma.permission.findMany();
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } });
  for (const p of allPerms) {
    await prisma.rolePermissions.create({
      data: { roleId: adminRole.id, permissionId: p.id },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  // Закрываем Prisma внутри src/index.ts (тот же инстанс используется приложением)
  try {
    const mod = await import('../src/index');
    if (mod.prisma) {
      await mod.prisma.$disconnect().catch(() => undefined);
    }
    const auth = await import('../src/middleware/auth');
    if (auth.authPrisma) {
      await auth.authPrisma.$disconnect().catch(() => undefined);
    }
    const checkStatus = await import('../src/middleware/checkUserStatus');
    if (checkStatus.checkStatusPrisma) {
      await checkStatus.checkStatusPrisma.$disconnect().catch(() => undefined);
    }
    const userSvc = await import('../src/services/userService');
    if (userSvc.userServicePrisma) {
      await userSvc.userServicePrisma.$disconnect().catch(() => undefined);
    }
  } catch {
    // ignore
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});
