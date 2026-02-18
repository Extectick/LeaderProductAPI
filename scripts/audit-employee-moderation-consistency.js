#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const [userRole, employeeRole] = await Promise.all([
    prisma.role.findUnique({ where: { name: 'user' }, select: { id: true, name: true } }),
    prisma.role.findUnique({ where: { name: 'employee' }, select: { id: true, name: true } }),
  ]);

  if (!userRole || !employeeRole) {
    throw new Error('Roles user/employee must exist before running audit.');
  }

  const users = await prisma.user.findMany({
    where: { employeeProfile: { isNot: null } },
    select: {
      id: true,
      roleId: true,
      currentProfileType: true,
      employeeProfile: { select: { status: true } },
      role: { select: { name: true } },
    },
  });

  const activeEmployeeWithUserRole = [];
  const blockedEmployeeWithEmployeeRole = [];
  const blockedEmployeeWithEmployeeCurrentProfile = [];

  for (const user of users) {
    const status = user.employeeProfile?.status || null;
    if (status === 'ACTIVE' && user.roleId === userRole.id) {
      activeEmployeeWithUserRole.push(user.id);
    }
    if (status === 'BLOCKED' && user.roleId === employeeRole.id) {
      blockedEmployeeWithEmployeeRole.push(user.id);
    }
    if (status === 'BLOCKED' && user.currentProfileType === 'EMPLOYEE') {
      blockedEmployeeWithEmployeeCurrentProfile.push(user.id);
    }
  }

  const report = {
    scannedUsersWithEmployeeProfile: users.length,
    mismatches: {
      activeEmployeeWithUserRole: activeEmployeeWithUserRole.length,
      blockedEmployeeWithEmployeeRole: blockedEmployeeWithEmployeeRole.length,
      blockedEmployeeWithEmployeeCurrentProfile: blockedEmployeeWithEmployeeCurrentProfile.length,
    },
    samples: {
      activeEmployeeWithUserRole: activeEmployeeWithUserRole.slice(0, 30),
      blockedEmployeeWithEmployeeRole: blockedEmployeeWithEmployeeRole.slice(0, 30),
      blockedEmployeeWithEmployeeCurrentProfile: blockedEmployeeWithEmployeeCurrentProfile.slice(0, 30),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error('[audit-employee-moderation-consistency] failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
