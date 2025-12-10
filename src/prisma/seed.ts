const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // ---------------------------------------------------------------
  // 1. Создаём набор прав (permissions).
  // Общие права для всех пользователей: просмотр/обновление профиля и выход.
  // Далее идут права, связанные с системой обращений.
  const permissionNames = [
    // Общие права
    'view_profile',
    'update_profile',
    'logout',
    // Обращения права
    'create_appeal',
    'view_appeal',
    'assign_appeal',
    'update_appeal_status',
    'add_appeal_message',
    'edit_appeal_message',
    'delete_appeal_message',
    'manage_appeal_watchers',
    'export_appeals',
    // QR-коды права
    'create_qr',
    'view_qr',
    'update_qr',
    'delete_qr',
    'restore_qr',
    'view_qr_analytics',
    'export_qr',
    'view_qr_stats',
  ];

  // Убеждаемся, что все permissions существуют (upsert создаёт при отсутствии)
  for (const name of permissionNames) {
    await prisma.permission.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // ---------------------------------------------------------------
  // 2. Создаём роли. Иерархия ролей:
  //    - user               : базовая роль
  //    - client             : наследует user (общие права)
  //    - supplier           : наследует user
  //    - employee           : наследует user, имеет права на обращения
  //    - department_manager : наследует employee, имеет права назначения и смены статусов
  //    - admin              : наследует department_manager, получает все права
  const userRole = await prisma.role.upsert({
    where: { name: 'user' },
    update: {},
    create: { name: 'user' },
  });
  const clientRole = await prisma.role.upsert({
    where: { name: 'client' },
    update: {},
    create: { name: 'client', parentRoleId: userRole.id },
  });
  const supplierRole = await prisma.role.upsert({
    where: { name: 'supplier' },
    update: {},
    create: { name: 'supplier', parentRoleId: userRole.id },
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

  // ---------------------------------------------------------------
  // 3. Определяем набор разрешений для каждой роли.
  // Базовая роль "user" — общие права
  const userPermissions = ['view_profile', 'update_profile', 'logout'];

  // Роли "client" и "supplier" не получают дополнительных прав — наследуют только userPermissions.

  // "employee" получает права на работу с обращениями
  const employeePermissions = [
    'create_appeal',
    'view_appeal',
    'add_appeal_message',
    'edit_appeal_message',
    'delete_appeal_message',
    'manage_appeal_watchers',
    'create_qr',
    'view_qr',
    'update_qr',
    'delete_qr',
    'restore_qr',
    'view_qr_analytics',
    'export_qr',
    'view_qr_stats',
    'update_appeal_status',
    'assign_appeal',
    'export_appeals',
  ];

  // // "department_manager" — права на назначение и изменение статусов, экспорт обращений
  // const managerPermissions = [
  //   'export_appeals'
  // ];

  // Вспомогательная функция: удаляет старые permissions роли и добавляет новые
  async function assignPermissions(
    roleId: number,
    permNames: string[]
  ): Promise<void> {
    await prisma.rolePermissions.deleteMany({ where: { roleId } });
    for (const name of permNames) {
      const perm = await prisma.permission.findUnique({ where: { name } });
      if (perm) {
        await prisma.rolePermissions.create({
          data: { roleId, permissionId: perm.id },
        });
      }
    }
  }

  // 4. Назначаем права ролям:
  // Общие права
  await assignPermissions(userRole.id, userPermissions);

  // Для "client" и "supplier" дополнительных прав нет
  await assignPermissions(clientRole.id, []);
  await assignPermissions(supplierRole.id, []);

  // Для "employee" — права на обращения
  await assignPermissions(employeeRole.id, employeePermissions);

  // // Для "department_manager" — свои дополнительные права
  // await assignPermissions(managerRole.id, managerPermissions);

  // Для "admin" — все существующие разрешения
  const allPermissions = await prisma.permission.findMany();
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } });
  for (const permission of allPermissions) {
    await prisma.rolePermissions.create({
      data: { roleId: adminRole.id, permissionId: permission.id },
    });
  }

  // ---------------------------------------------------------------
  // 5. ���������� ��������� �������� (departments).
  const departments = [
    'IT отдел',
    'Бухгалтерия',
    'Отдел продаж',
    'Отдел логистики',
    'Отдел кадров',
  ];

  for (const name of departments) {
    await prisma.department.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log(
    'Seed completed: roles, permissions and departments have been created and assigned.'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
