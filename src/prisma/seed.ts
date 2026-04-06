import prisma from './client';
import {
  DEFAULT_PERMISSION_GROUP_KEY,
  DEFAULT_ROLE_DISPLAY_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_GROUP_CATALOG,
} from '../rbac/permissionCatalog';

async function main() {
  const departmentNames = [
    'IT Отдел',
    'Бухгалтерия',
    'Маркетинг',
    'Менеджеры',
  ];

  const services = [
    {
      key: 'qrcodes',
      name: 'QR генератор и аналитика',
      kind: 'CLOUD' as const,
      route: '/services/qrcodes',
      icon: 'qr-code-outline',
      description: 'Создание QR-кодов, печать и аналитика по сканам.',
      gradientStart: '#5B21B6',
      gradientEnd: '#7C3AED',
      defaultVisible: true,
      defaultEnabled: true,
      isActive: true,
    },
    {
      key: 'appeals',
      name: 'Обращения',
      kind: 'CLOUD' as const,
      route: '/services/appeals',
      icon: 'documents',
      description: 'Центр общения с клиентами и партнёрами.',
      gradientStart: '#a8d5ba',
      gradientEnd: '#4cad50',
      defaultVisible: true,
      defaultEnabled: true,
      isActive: true,
    },
    {
      key: 'tracking',
      name: 'Геомаршруты',
      kind: 'CLOUD' as const,
      route: '/services/tracking',
      icon: 'map-outline',
      description: 'Маршруты, точки и контроль передвижений.',
      gradientStart: '#ffd89b',
      gradientEnd: '#19547b',
      defaultVisible: true,
      defaultEnabled: true,
      isActive: true,
    },
    {
      key: 'stock_balances',
      name: 'Остатки по складам',
      kind: 'CLOUD' as const,
      route: '/services/stock_balances',
      icon: 'cube-outline',
      description: 'Остатки по складам, организациям и сериям товаров.',
      gradientStart: '#0F766E',
      gradientEnd: '#22C55E',
      defaultVisible: true,
      defaultEnabled: true,
      isActive: true,
    },
    {
      key: 'client_orders',
      name: 'Заказы клиентов',
      kind: 'CLOUD' as const,
      route: '/services/client_orders',
      icon: 'receipt-outline',
      description: 'Менеджерские заказы клиентов с синхронизацией в 1С.',
      gradientStart: '#1D4ED8',
      gradientEnd: '#0EA5E9',
      defaultVisible: true,
      defaultEnabled: true,
      isActive: true,
    },
    {
      key: 'tasks',
      name: 'Задачи',
      kind: 'CLOUD' as const,
      route: '/tasks',
      icon: 'list-outline',
      description: 'Постановка и контроль задач команды.',
      gradientStart: '#90caf9',
      gradientEnd: '#2196f3',
      defaultVisible: true,
      defaultEnabled: false,
      isActive: true,
    },
    {
      key: 'reports',
      name: 'Отчёты',
      kind: 'CLOUD' as const,
      route: '/reports',
      icon: 'stats-chart-outline',
      description: 'Визуальные отчёты и показатели (скоро).',
      gradientStart: '#ce93d8',
      gradientEnd: '#9c27b0',
      defaultVisible: true,
      defaultEnabled: false,
      isActive: true,
    },
    {
      key: 'clients',
      name: 'Клиенты',
      kind: 'CLOUD' as const,
      route: '/clients',
      icon: 'people-outline',
      description: 'Управление клиентской базой (скоро).',
      gradientStart: '#ef9a9a',
      gradientEnd: '#f44336',
      defaultVisible: true,
      defaultEnabled: false,
      isActive: true,
    },
  ];

  const serviceByKey = new Map<string, number>();
  for (const service of services) {
    const upserted = await prisma.service.upsert({
      where: { key: service.key },
      update: {
        name: service.name,
        route: service.route,
        icon: service.icon,
        description: service.description,
        gradientStart: service.gradientStart,
        gradientEnd: service.gradientEnd,
        defaultVisible: service.defaultVisible,
        defaultEnabled: service.defaultEnabled,
        isActive: service.isActive,
      },
      create: {
        ...service,
      },
      select: { id: true, key: true },
    });
    serviceByKey.set(upserted.key, upserted.id);
  }

  const groupIdByKey = new Map<string, number>();
  for (const group of PERMISSION_GROUP_CATALOG) {
    const serviceId = group.serviceKey ? serviceByKey.get(group.serviceKey) ?? null : null;
    const upserted = await prisma.permissionGroup.upsert({
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
    groupIdByKey.set(upserted.key, upserted.id);
  }

  if (!groupIdByKey.has(DEFAULT_PERMISSION_GROUP_KEY)) {
    const fallbackCore = await prisma.permissionGroup.upsert({
      where: { key: DEFAULT_PERMISSION_GROUP_KEY },
      update: {
        displayName: 'Основные',
        description: 'Базовые права пользователя и общесистемные действия.',
        sortOrder: 10,
        isSystem: true,
      },
      create: {
        key: DEFAULT_PERMISSION_GROUP_KEY,
        displayName: 'Основные',
        description: 'Базовые права пользователя и общесистемные действия.',
        sortOrder: 10,
        isSystem: true,
      },
      select: { id: true, key: true },
    });
    groupIdByKey.set(fallbackCore.key, fallbackCore.id);
  }

  const coreGroupId = groupIdByKey.get(DEFAULT_PERMISSION_GROUP_KEY)!;

  for (const entry of PERMISSION_CATALOG) {
    const targetGroupId = groupIdByKey.get(entry.groupKey) ?? coreGroupId;
    const existing = await prisma.permission.findUnique({
      where: { name: entry.name },
      select: { id: true, groupId: true },
    });

    if (existing) {
      await prisma.permission.update({
        where: { id: existing.id },
        data: {
          displayName: entry.displayName,
          description: entry.description,
          ...(existing.groupId == null ? { groupId: targetGroupId } : {}),
        },
      });
    } else {
      await prisma.permission.create({
        data: {
          name: entry.name,
          displayName: entry.displayName,
          description: entry.description,
          groupId: targetGroupId,
        },
      });
    }
  }

  for (const name of departmentNames) {
    await prisma.department.upsert({
      where: { name },
      update: {},
      create: { name },
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

  const allPerms = await prisma.permission.findMany();
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } });
  for (const p of allPerms) {
    await prisma.rolePermissions.create({
      data: { roleId: adminRole.id, permissionId: p.id },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
