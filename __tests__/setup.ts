import { execSync } from 'child_process';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

process.env.NODE_ENV = 'test';

// Подхватываем .env.test заранее, чтобы Prisma видел корректный postgres URL

// Инициализируем Prisma после загрузки env, чтобы взять правильный DATABASE_URL
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prisma = require('../src/prisma/client').default as typeof import('../src/prisma/client').default;
const {
  DEFAULT_PERMISSION_GROUP_KEY,
  DEFAULT_ROLE_DISPLAY_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_GROUP_CATALOG,
} = require('../src/rbac/permissionCatalog') as typeof import('../src/rbac/permissionCatalog');

// Отключаем Redis в тестах, чтобы не было лишних подключений/ошибок

// Явно требуем DATABASE_URL для postgres; без него тесты не имеют смысла
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for tests. Set DATABASE_URL or TEST_DATABASE_URL.');
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test_refresh_secret';

async function ensureTestS3Bucket() {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return;
  }

  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (headError) {
      lastError = headError;

      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        return;
      } catch (createError: any) {
        const status = createError?.$metadata?.httpStatusCode;
        const name = String(createError?.name || '');
        if (status === 409 || name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
          return;
        }
        lastError = createError;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Failed to initialize test S3 bucket ${bucket}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// Синхронизируем схему с тестовой БД (без миграций, чтобы не требовать history)
try {
  execSync('npx prisma db push --schema prisma --config prisma.config.js --accept-data-loss', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string },
    cwd: process.cwd(),
  });
} catch (e) {
  console.error('Failed to run prisma db push for tests', e);
  throw e;
}

beforeAll(async () => {
  await ensureTestS3Bucket();

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

  // Базовые сервисы, чтобы можно было привязать системные группы прав к сервисам
  const seededServices = [
    { key: 'appeals', name: 'Appeals' },
    { key: 'qrcodes', name: 'QR Codes' },
  ];
  const serviceByKey = new Map<string, number>();
  for (const svc of seededServices) {
    const service = await prisma.service.upsert({
      where: { key: svc.key },
      update: { isActive: true, defaultVisible: true, defaultEnabled: true },
      create: {
        key: svc.key,
        name: svc.name,
        isActive: true,
        defaultVisible: true,
        defaultEnabled: true,
      },
      select: { id: true, key: true },
    });
    serviceByKey.set(service.key, service.id);
  }

  const groupByKey = new Map<string, number>();
  for (const group of PERMISSION_GROUP_CATALOG) {
    const serviceId = group.serviceKey ? serviceByKey.get(group.serviceKey) ?? null : null;
    const savedGroup = await prisma.permissionGroup.upsert({
      where: { key: group.key },
      update: {
        displayName: group.displayName,
        description: group.description,
        sortOrder: group.sortOrder,
        isSystem: group.isSystem,
        serviceId,
      },
      create: {
        key: group.key,
        displayName: group.displayName,
        description: group.description,
        sortOrder: group.sortOrder,
        isSystem: group.isSystem,
        serviceId,
      },
      select: { id: true, key: true },
    });
    groupByKey.set(savedGroup.key, savedGroup.id);
  }

  const coreGroupId = groupByKey.get(DEFAULT_PERMISSION_GROUP_KEY);

  // Регистрируем базовые permissions/roles (минимально необходимые)
  for (const entry of PERMISSION_CATALOG) {
    const groupId = groupByKey.get(entry.groupKey) ?? coreGroupId ?? null;
    await prisma.permission.upsert({
      where: { name: entry.name },
      update: {
        displayName: entry.displayName,
        description: entry.description,
        ...(groupId ? { groupId } : {}),
      },
      create: {
        name: entry.name,
        displayName: entry.displayName,
        description: entry.description,
        ...(groupId ? { groupId } : {}),
      },
    });
  }

  const userRole = await prisma.role.upsert({
    where: { name: 'user' },
    update: { displayName: DEFAULT_ROLE_DISPLAY_NAMES.user, parentRoleId: null },
    create: { name: 'user', displayName: DEFAULT_ROLE_DISPLAY_NAMES.user },
  });
  const employeeRole = await prisma.role.upsert({
    where: { name: 'employee' },
    update: {
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.employee,
      parentRoleId: userRole.id,
    },
    create: {
      name: 'employee',
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.employee,
      parentRoleId: userRole.id,
    },
  });
  const managerRole = await prisma.role.upsert({
    where: { name: 'department_manager' },
    update: {
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.department_manager,
      parentRoleId: employeeRole.id,
    },
    create: {
      name: 'department_manager',
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.department_manager,
      parentRoleId: employeeRole.id,
    },
  });
  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.admin,
      parentRoleId: managerRole.id,
    },
    create: {
      name: 'admin',
      displayName: DEFAULT_ROLE_DISPLAY_NAMES.admin,
      parentRoleId: managerRole.id,
    },
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
  await give('user', DEFAULT_ROLE_PERMISSIONS.user);
  await give('employee', DEFAULT_ROLE_PERMISSIONS.employee);
  await give('department_manager', DEFAULT_ROLE_PERMISSIONS.department_manager);

  // админ — все
  const allPerms = await prisma.permission.findMany();
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } });
  for (const p of allPerms) {
    await prisma.rolePermissions.create({
      data: { roleId: adminRole.id, permissionId: p.id },
    });
  }

  // "appeals" уже создан выше, но поддержим идемпотентно
  await prisma.service.updateMany({
    where: { key: 'appeals' },
    data: { isActive: true, defaultVisible: true, defaultEnabled: true },
  });
});

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
