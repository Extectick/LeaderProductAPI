import express from 'express';
import { PrismaClient, ProfileType, ProfileStatus } from '@prisma/client';
import { authenticateToken, authorizeRoles, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { auditLog, authorizeDepartmentManager } from '../middleware/audit';

interface UserProfile {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  profileStatus: ProfileStatus;
  currentProfileType: ProfileType | null;
  role: {
    id: number;
    name: string;
  };
  departmentRoles: {
    department: {
      id: number;
      name: string;
    };
    role: {
      id: number;
      name: string;
    };
  }[];
  clientProfile?: {
    id: number;
    phone: string | null;
    status: ProfileStatus;
    address: {
      street: string;
      city: string;
      state: string | null;
      postalCode: string | null;
      country: string;
    } | null;
    createdAt: Date;
    updatedAt: Date;
  };
  supplierProfile?: {
    id: number;
    phone: string | null;
    status: ProfileStatus;
    address: {
      street: string;
      city: string;
      state: string | null;
      postalCode: string | null;
      country: string;
    } | null;
    createdAt: Date;
    updatedAt: Date;
  };
  employeeProfile?: {
    id: number;
    phone: string | null;
    status: ProfileStatus;
    department: {
      id: number;
      name: string;
    } | null;
    departmentRoles: {
      id: number;
      role: {
        id: number;
        name: string;
      };
    }[];
    createdAt: Date;
    updatedAt: Date;
  };
}

const router = express.Router();
const prisma = new PrismaClient();

// Обычный пользователь может назначать или изменять только свой отдел
router.put('/me/department', authenticateToken, checkUserStatus, auditLog('Пользователь обновил свой отдел'), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json({ message: 'ID отдела обязателен' });
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) {
      return res.status(404).json({ message: 'Отдел не найден' });
    }

    await prisma.employeeProfile.updateMany({
      where: { userId: Number(userId) },
      data: { departmentId: Number(departmentId) },
    });

    res.json({ message: 'Отдел пользователя обновлен' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления отдела', error });
  }
});

// Администратор может назначить отдел любому пользователю
router.put('/:userId/department', authenticateToken, checkUserStatus, authorizeRoles(['admin']), auditLog('Админ обновил отдел пользователя'), async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json({ message: 'ID отдела обязателен' });
    }

    const department = await prisma.department.findUnique({ where: { id: Number(departmentId) } });
    if (!department) {
      return res.status(404).json({ message: 'Отдел не найден' });
    }

    await prisma.employeeProfile.updateMany({
      where: { userId: Number(userId) },
      data: { departmentId: Number(departmentId) },
    });

    res.json({ message: `Отдел пользователя ${userId} обновлен` });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления отдела', error });
  }
});

// Администратор может назначить пользователя начальником отдела
router.post('/:userId/department/:departmentId/manager', authenticateToken, checkUserStatus, authorizeRoles(['admin']), auditLog('Админ назначил менеджера отдела'), async (req: AuthRequest, res) => {
  try {
    const { userId, departmentId } = req.params;

    const department = await prisma.department.findUnique({ where: { id: Number(departmentId) } });
    if (!department) {
      return res.status(404).json({ message: 'Отдел не найден' });
    }

    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }

    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    if (!managerRole) {
      return res.status(404).json({ message: 'Роль "менеджер отдела" не найдена' });
    }

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

    res.json({ message: `Пользователь ${userId} назначен менеджером отдела ${departmentId}` });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка назначения менеджера отдела', error });
  }
});

router.get('/profile', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        middleName: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        phone: true,
        avatarUrl: true,
        profileStatus: true,
        currentProfileType: true,
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

// Создание клиентского профиля
router.post('/profiles/client', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { firstName, lastName, middleName, phone, address } = req.body;

    const existingProfile = await prisma.clientProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      return res.status(400).json({ message: 'Клиентский профиль уже существует' });
    }

    const profile = await prisma.clientProfile.create({
      data: {
        userId,
        phone,
        ...(address && { 
          address: {
            create: {
              street: address.street,
              city: address.city,
              state: address.state,
              postalCode: address.postalCode,
              country: address.country
            }
          }
        })
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { 
        ...(firstName || lastName || middleName ? { firstName, lastName, middleName } : {}),
        currentProfileType: 'CLIENT'
      }
    });

    res.status(201).json(profile);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка создания клиентского профиля', error });
  }
});

// Создание профиля поставщика
router.post('/profiles/supplier', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { firstName, lastName, middleName, phone, address } = req.body;

    const existingProfile = await prisma.supplierProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      return res.status(400).json({ message: 'Профиль поставщика уже существует' });
    }

    const profile = await prisma.supplierProfile.create({
      data: {
        userId,
        phone,
        ...(address && { 
          address: {
            create: {
              street: address.street,
              city: address.city,
              state: address.state,
              postalCode: address.postalCode,
              country: address.country
            }
          }
        })
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { 
        ...(firstName || lastName || middleName ? { firstName, lastName, middleName } : {}),
        currentProfileType: 'SUPPLIER'
      }
    });

    res.status(201).json(profile);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка создания профиля поставщика', error });
  }
});

// Создание профиля сотрудника
router.post('/profiles/employee', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { firstName, lastName, middleName, phone, departmentId } = req.body;

    if (!firstName || !lastName || !departmentId) {
      return res.status(400).json({ message: 'Обязательные поля: имя, фамилия и ID отдела' });
    }

    const existingProfile = await prisma.employeeProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      return res.status(400).json({ message: 'Профиль сотрудника уже существует' });
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) {
      return res.status(404).json({ message: 'Отдел не найден' });
    }

    const profile = await prisma.employeeProfile.create({
      data: {
        userId,
        phone,
        departmentId,
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { firstName, lastName, middleName, currentProfileType: 'EMPLOYEE' }
    });

    res.status(201).json(profile);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка создания профиля сотрудника', error });
  }
});

export default router;
