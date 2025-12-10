// __tests__/utils/auth.ts
import jwt from 'jsonwebtoken';
import { PrismaClient, ProfileType, ProfileStatus } from '@prisma/client';

const prisma = new PrismaClient();

function uniqEmail(base: string): string {
  const [local, domain = 'example.com'] = base.split('@');
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return `${local}+${suffix}@${domain}`;
}

export async function createUserWithRole(
  email: string,
  roleName: 'user' | 'employee' | 'department_manager' | 'admin',
  profileType: ProfileType = 'EMPLOYEE'
) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) throw new Error(`Role ${roleName} not found`);

  // всегда генерим уникальный email (игнорируем коллизии)
  const uniqueEmail = uniqEmail(email);

  const user = await prisma.user.create({
    data: {
      email: uniqueEmail,
      passwordHash: 'x',
      isActive: true,
      roleId: role.id,
      currentProfileType: profileType,
      profileStatus: ProfileStatus.ACTIVE,
    },
  });

  if (profileType === 'EMPLOYEE') {
    const dept = await prisma.department.create({
      data: { name: `Dept_${roleName}_${Date.now()}_${Math.random().toString(36).slice(2,5)}` },
    });
    await prisma.employeeProfile.create({
      data: {
        userId: user.id,
        departmentId: dept.id,
        status: ProfileStatus.ACTIVE,
      },
    });
  } else if (profileType === 'CLIENT') {
    await prisma.clientProfile.create({
      data: { userId: user.id, status: ProfileStatus.ACTIVE },
    });
  } else if (profileType === 'SUPPLIER') {
    await prisma.supplierProfile.create({
      data: { userId: user.id, status: ProfileStatus.ACTIVE },
    });
  }

  return user;
}

export function signToken(userId: number, roleName: string) {
  const jwtSecret = process.env.JWT_SECRET || 'test_jwt_secret';
  return jwt.sign({ userId, role: roleName.toUpperCase() }, jwtSecret, { expiresIn: '1h' });
}

// Закрываем подключение после завершения всех тестов
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
