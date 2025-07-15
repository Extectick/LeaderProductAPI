
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, authorizeRoles, AuthRequest } from '../middleware/auth';
import { auditLog, authorizeDepartmentManager } from '../middleware/audit';

const router = express.Router();
const prisma = new PrismaClient();

// Обычный пользователь может назначать или изменять только свой отдел
router.put('/me/department', authenticateToken, auditLog('Update own department'), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json({ message: 'departmentId is required' });
    }

    // Проверяем, существует ли отдел
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }


    // Обновляем отдел пользователя
    // Теперь отдел связан с EmployeeProfile, обновим там
    await prisma.employeeProfile.updateMany({
      where: { userId: Number(userId) },
      data: { departmentId: Number(departmentId) },
    });

    res.json({ message: 'Department updated for current user' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update department', error });
  }
});

// Администратор может назначить отдел любому пользователю
router.put('/:userId/department', authenticateToken, authorizeRoles(['admin']), auditLog('Admin update user department'), async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json({ message: 'departmentId is required' });
    }

    // Проверяем, существует ли отдел
    const department = await prisma.department.findUnique({ where: { id: Number(departmentId) } });
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }


    // Обновляем отдел пользователя
    // Теперь отдел связан с EmployeeProfile, обновим там
    await prisma.employeeProfile.updateMany({
      where: { userId: Number(userId) },
      data: { departmentId: Number(departmentId) },
    });

    res.json({ message: `Department updated for user ${userId}` });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update department', error });
  }
});

// Администратор может назначить пользователя начальником отдела (через DepartmentRole)
router.post('/:userId/department/:departmentId/manager', authenticateToken, authorizeRoles(['admin']), auditLog('Admin assign department manager'), async (req: AuthRequest, res) => {
  try {
    const { userId, departmentId } = req.params;

    // Проверяем, существует ли отдел
    const department = await prisma.department.findUnique({ where: { id: Number(departmentId) } });
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    // Проверяем, существует ли пользователь
    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Проверяем, существует ли роль начальника отдела
    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    if (!managerRole) {
      return res.status(404).json({ message: 'Role "department_manager" not found' });
    }

    // Создаем или обновляем запись DepartmentRole
    await prisma.departmentRole.upsert({
      where: {
        userId_roleId_departmentId: {
          userId: Number(userId),
          roleId: managerRole.id,
          departmentId: Number(departmentId),
        },
      },
      update: {},
      create: {
        userId: Number(userId),
        roleId: managerRole.id,
        departmentId: Number(departmentId),
      },
    });

    res.json({ message: `User ${userId} assigned as manager of department ${departmentId}` });
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign department manager', error });
  }
});



router.get('/profile', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // Получаем базовую информацию о пользователе
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        phone: true,
        avatarUrl: true,
        profileStatus: true,
        role: {
          select: {
            id: true,
            name: true,
          },
        },
        departmentRoles: {
          select: {
            department: {
              select: {
                id: true,
                name: true,
              },
            },
            role: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        clientProfile: {
          select: {
            id: true,
            phone: true,
            status: true,
            address: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        supplierProfile: {
          select: {
            id: true,
            phone: true,
            status: true,
            address: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        employeeProfile: {
          select: {
            id: true,
            phone: true,
            status: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
            departmentRoles: {
              select: {
                id: true,
                role: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    res.json({ profile: user });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка получения профиля', error });
  }
});

export default router;
