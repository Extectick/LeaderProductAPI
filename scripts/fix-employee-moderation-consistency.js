#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const [userRole, employeeRole] = await Promise.all([
    prisma.role.findUnique({ where: { name: 'user' }, select: { id: true, name: true } }),
    prisma.role.findUnique({ where: { name: 'employee' }, select: { id: true, name: true } }),
  ]);

  if (!userRole || !employeeRole) {
    throw new Error('Roles user/employee must exist before running fix.');
  }

  const users = await prisma.user.findMany({
    where: { employeeProfile: { isNot: null } },
    select: {
      id: true,
      roleId: true,
      currentProfileType: true,
      employeeProfile: { select: { status: true } },
    },
  });

  const toSetEmployeeRole = [];
  const toSetUserRole = [];
  const toResetCurrentProfileType = [];

  for (const user of users) {
    const status = user.employeeProfile?.status || null;
    if (status === 'ACTIVE' && user.roleId === userRole.id) {
      toSetEmployeeRole.push(user.id);
    }
    if (status === 'BLOCKED' && user.roleId === employeeRole.id) {
      toSetUserRole.push(user.id);
    }
    if (status === 'BLOCKED' && user.currentProfileType === 'EMPLOYEE') {
      toResetCurrentProfileType.push(user.id);
    }
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scannedUsersWithEmployeeProfile: users.length,
    planned: {
      setEmployeeRole: toSetEmployeeRole.length,
      setUserRole: toSetUserRole.length,
      resetCurrentProfileType: toResetCurrentProfileType.length,
    },
    samples: {
      setEmployeeRole: toSetEmployeeRole.slice(0, 30),
      setUserRole: toSetUserRole.slice(0, 30),
      resetCurrentProfileType: toResetCurrentProfileType.slice(0, 30),
    },
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    console.log('\nRun with --apply to execute fixes.');
    return;
  }

  let affectedUsers = 0;
  await prisma.$transaction(async (tx) => {
    if (toSetEmployeeRole.length) {
      const r = await tx.user.updateMany({
        where: { id: { in: toSetEmployeeRole } },
        data: { roleId: employeeRole.id },
      });
      affectedUsers += r.count;
    }
    if (toSetUserRole.length) {
      const r = await tx.user.updateMany({
        where: { id: { in: toSetUserRole } },
        data: { roleId: userRole.id },
      });
      affectedUsers += r.count;
    }
    if (toResetCurrentProfileType.length) {
      const r = await tx.user.updateMany({
        where: { id: { in: toResetCurrentProfileType } },
        data: { currentProfileType: null },
      });
      affectedUsers += r.count;
    }
  });

  console.log(
    JSON.stringify(
      {
        ...report,
        applied: true,
        totalUpdateOperations: affectedUsers,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('[fix-employee-moderation-consistency] failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
