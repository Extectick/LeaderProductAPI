import prisma from './client';

async function main() {
  const permissionNames = [
    'view_profile',
    'update_profile',
    'logout',
    'manage_roles',
    'manage_permissions',
    'manage_services',
    'assign_roles',
    'assign_permissions',
    'manage_departments',
    'manage_users',
    'view_fin_reports',
    'approve_payments',
    'manage_payroll',
    'view_shipments',
    'manage_shipments',
    'manage_inventory',
    'create_appeal',
    'view_appeal',
    'assign_appeal',
    'update_appeal_status',
    'add_appeal_message',
    'edit_appeal_message',
    'delete_appeal_message',
    'manage_appeal_watchers',
    'export_appeals',
    'manage_updates',
  ];

  const departmentNames = [
    'IT Отдел',
    'Бухгалтерия',
    'Маркетинг',
    'Менеджеры',
  ];

  for (const name of permissionNames) {
    await prisma.permission.upsert({
      where: { name },
      update: {},
      create: { name },
    });
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

  const allPerms = await prisma.permission.findMany();
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } });
  for (const p of allPerms) {
    await prisma.rolePermissions.create({
      data: { roleId: adminRole.id, permissionId: p.id },
    });
  }

  const services = [
    {
      key: 'qrcodes',
      name: 'QR генератор и аналитика',
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
      key: 'tasks',
      name: 'Задачи',
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

  for (const service of services) {
    await prisma.service.upsert({
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
      create: service,
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
