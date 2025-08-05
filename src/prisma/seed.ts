const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // Создаем роли USER и ADMIN
  const userRole = await prisma.role.upsert({
    where: { name: 'user' },
    update: {},
    create: { name: 'user' },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: { name: 'admin' },
  });

  // Получаем все права доступа
  const allPermissions = await prisma.permission.findMany();

  // Назначаем все права роли ADMIN
  await prisma.rolePermissions.deleteMany({ where: { roleId: adminRole.id } }); // очистить старые связи
  for (const permission of allPermissions) {
    await prisma.rolePermissions.create({
      data: {
        roleId: adminRole.id,
        permissionId: permission.id,
      },
    });
  }

  console.log('Seed completed: roles USER and ADMIN created, ADMIN has all permissions.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
