import express from 'express';
import { PrismaClient, ProfileType, ProfileStatus } from '@prisma/client';
import { 
  authenticateToken, 
  authorizeRoles, 
  AuthRequest 
} from '../middleware/auth';
import { 
  UserProfileRequest, 
  UserProfileResponse,
  UpdateUserDepartmentRequest,
  UpdateUserDepartmentResponse,
  AssignDepartmentManagerRequest,
  AssignDepartmentManagerResponse,
  CreateClientProfileRequest,
  CreateSupplierProfileRequest,
  CreateEmployeeProfileRequest,
  CreateProfileResponse,
  DepartmentResponse
} from '../types/routes';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { auditLog, authorizeDepartmentManager } from '../middleware/audit';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import { getProfile } from '../services/userService';

const router = express.Router();
const prisma = new PrismaClient();

// Обычный пользователь может назначать или изменять только свой отдел
router.put('/me/department', authenticateToken, checkUserStatus, auditLog('Пользователь обновил свой отдел'), 
async (req: AuthRequest<{}, UpdateUserDepartmentResponse, UpdateUserDepartmentRequest>, res: express.Response<UpdateUserDepartmentResponse>) => {
  try {
    const userId = req.user!.userId;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json(
        errorResponse('ID отдела обязателен', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const departmentIdNum = Number(departmentId);
    if (isNaN(departmentIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
    if (!department) {
      return res.status(404).json(
        errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND)
      );
    }

    await prisma.employeeProfile.updateMany({
      where: { userId: Number(userId) },
      data: { departmentId: departmentIdNum },
    });

    res.json(
      successResponse({ message: 'Отдел пользователя обновлен' })
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR, 
          process.env.NODE_ENV === 'development' ? error : undefined)
      );
    } else {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
});

// Администратор может назначить отдел любому пользователю
router.put('/:userId/department', authenticateToken, checkUserStatus, authorizeRoles(['admin']), auditLog('Админ обновил отдел пользователя'), 
async (req: AuthRequest<{userId: string}, UpdateUserDepartmentResponse, UpdateUserDepartmentRequest>, res: express.Response<UpdateUserDepartmentResponse>) => {
  try {
    const { userId } = req.params;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json(
        errorResponse('ID отдела обязателен', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const departmentIdNum = Number(departmentId);
    if (isNaN(departmentIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const userIdNum = Number(userId);
    if (isNaN(userIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userIdNum } });
    if (!user) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
    if (!department) {
      return res.status(404).json(
        errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND)
      );
    }

    await prisma.employeeProfile.updateMany({
      where: { userId: userIdNum },
      data: { departmentId: departmentIdNum },
    });

    res.json(
      successResponse({ message: `Отдел пользователя ${userId} обновлен` })
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR, 
          process.env.NODE_ENV === 'development' ? error : undefined)
      );
    } else {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
});



router.get('/profile', authenticateToken, checkUserStatus, async (req: UserProfileRequest, res: express.Response<UserProfileResponse>) => {
  try {
    const userId = req.user!.userId;

    const profile = await getProfile(userId)
    if (!profile) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    res.json(successResponse({
      profile: profile
    }));
  } catch (error) {
    res.status(500).json(
      errorResponse('Ошибка получения профиля', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

// Создание клиентского профиля
router.post('/profiles/client', authenticateToken, checkUserStatus, 
async (req: AuthRequest<{}, CreateProfileResponse, CreateClientProfileRequest>, res: express.Response<UserProfileResponse>) => {
  try {
    const userId = req.user!.userId;
    const { user: userData, phone, address } = req.body;

    if (!userData?.firstName) {
      return res.status(400).json(
        errorResponse('Обязательное поле: user.firstName', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (address && (!address.street || !address.city || !address.country)) {
      return res.status(400).json(
        errorResponse('Если указан адрес, обязательные поля: address.street, address.city, address.country', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const existingProfile = await prisma.clientProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      console.log(`Conflict: Client profile already exists for user ${userId}`);
      return res.status(409).json(
        errorResponse('Клиентский профиль уже существует', ErrorCodes.CONFLICT)
      );
    }

    let addressId: number | undefined;
    
    if (address) {
      const createdAddress = await prisma.address.create({
        data: {
          street: address.street,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          country: address.country
        }
      });
      addressId = createdAddress.id;
    }

    const profile = await prisma.clientProfile.create({
      data: {
        userId,
        phone,
        ...(addressId && { addressId })
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { 
        firstName: userData.firstName,
        lastName: userData.lastName,
        middleName: userData.middleName,
        currentProfileType: 'CLIENT'
      }
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        clientProfile: true
      }
    });

    if (!user) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    const resProfile = await getProfile(userId)

    res.json(successResponse({
      profile: resProfile,
      message: 'Профиль клиента успешно создан'
    }));
  } catch (error) {
    console.error('Error creating client profile:', error);
    res.status(500).json(
      errorResponse('Ошибка создания клиентского профиля', ErrorCodes.INTERNAL_ERROR, 
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

// Создание профиля поставщика
router.post('/profiles/supplier', authenticateToken, checkUserStatus, 
async (req: AuthRequest<{}, CreateProfileResponse, CreateSupplierProfileRequest>, res: express.Response<UserProfileResponse>) => {
  try {
    const userId = req.user!.userId;
    const { user: userData, phone, address } = req.body;

    if (!userData?.firstName) {
      return res.status(400).json(
        errorResponse('Обязательное поле: user.firstName', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (address && (!address.street || !address.city || !address.country)) {
      return res.status(400).json(
        errorResponse('Если указан адрес, обязательные поля: address.street, address.city, address.country', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const existingProfile = await prisma.supplierProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      console.log(`Conflict: Supplier profile already exists for user ${userId}`);
      return res.status(409).json(
        errorResponse('Профиль поставщика уже существует', ErrorCodes.CONFLICT)
      );
    }

    let addressId: number | undefined;
    
    if (address) {
      const createdAddress = await prisma.address.create({
        data: {
          street: address.street,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          country: address.country
        }
      });
      addressId = createdAddress.id;
    }

    const profile = await prisma.supplierProfile.create({
      data: {
        userId,
        phone,
        ...(addressId && { addressId })
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { 
        firstName: userData.firstName,
        lastName: userData.lastName,
        middleName: userData.middleName,
        currentProfileType: 'SUPPLIER'
      }
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        supplierProfile: true
      }
    });

    if (!user) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }
    const resProfile = await getProfile(userId)

    res.json(successResponse({
      profile: resProfile,
      message: 'Профиль поставщика успешно создан'
    }));
  } catch (error) {
    console.error('Error creating supplier profile:', error);
    res.status(500).json(
      errorResponse('Ошибка создания профиля поставщика', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

// Создание профиля сотрудника
router.post('/profiles/employee', authenticateToken, checkUserStatus, 
async (req: AuthRequest<{}, CreateProfileResponse, CreateEmployeeProfileRequest>, res: express.Response<UserProfileResponse>) => {
  try {
    const userId = req.user!.userId;
    const { user: userData, phone, departmentId } = req.body;

    if (!userData?.firstName || !userData?.lastName || !departmentId) {
      return res.status(400).json(
        errorResponse('Обязательные поля: user.firstName, user.lastName и departmentId', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const existingProfile = await prisma.employeeProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      console.log(`Conflict: Employee profile already exists for user ${userId}`);
      return res.status(409).json(
        errorResponse('Профиль сотрудника уже существует', ErrorCodes.CONFLICT)
      );
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) {
      return res.status(404).json(
        errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND)
      );
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
      data: { 
        firstName: userData.firstName,
        lastName: userData.lastName,
        middleName: userData.middleName,
        currentProfileType: 'EMPLOYEE' 
      }
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        employeeProfile: {
          include: {
            department: true,
            departmentRoles: {
              include: {
                role: true
              }
            }
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    const departmentRoles = (user.employeeProfile?.departmentRoles || []).map(dr => ({
      department: {
        id: dr.departmentId,
        name: user.employeeProfile?.department?.name || ''
      },
      role: dr.role
    }));

    const resProfile = await getProfile(userId)

    res.json(successResponse({
      profile: resProfile,
      message: 'Профиль сотрудника успешно создан'
    }));
  } catch (error) {
    console.error('Error creating employee profile:', error);
    res.status(500).json(
      errorResponse('Ошибка создания профиля сотрудника', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

// Обычный пользователь может назначать или изменять только свой отдел
router.put('/me/department', authenticateToken, checkUserStatus, auditLog('Пользователь обновил свой отдел'), 
async (req: AuthRequest<{}, UpdateUserDepartmentResponse, { departmentId: number }>, res: express.Response<UpdateUserDepartmentResponse>) => {
  try {
    const userId = req.user!.userId;
    const { departmentId } = req.body;

    if (!departmentId) {
      return res.status(400).json(
        errorResponse('ID отдела обязателен', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const departmentIdNum = Number(departmentId);
    if (isNaN(departmentIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
    if (!department) {
      return res.status(404).json(
        errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND)
      );
    }

    await prisma.employeeProfile.updateMany({
      where: { userId },
      data: { departmentId: departmentIdNum },
    });

    res.json(successResponse({ message: 'Отдел пользователя обновлен' }));
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR, 
          process.env.NODE_ENV === 'development' ? error : undefined)
      );
    } else {
      res.status(500).json(
        errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
});

// Администратор может назначить отдел любому пользователю
router.put('/:userId/department', authenticateToken, checkUserStatus, authorizeRoles(['admin']), auditLog('Админ обновил отдел пользователя'), 
async (req: AuthRequest<{userId: string}, UpdateUserDepartmentResponse, { departmentId: number }>, res: express.Response<UpdateUserDepartmentResponse>) => {
  try {
    const { userId } = req.params;
    const { departmentId } = req.body;

    const departmentIdNum = Number(departmentId);
    const userIdNum = Number(userId);
    
    if (isNaN(departmentIdNum) || isNaN(userIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректные параметры запроса', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const [user, department] = await Promise.all([
      prisma.user.findUnique({ where: { id: userIdNum } }),
      prisma.department.findUnique({ where: { id: departmentIdNum } })
    ]);

    if (!user || !department) {
      return res.status(404).json(
        errorResponse(user ? 'Отдел не найден' : 'Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    await prisma.employeeProfile.updateMany({
      where: { userId: userIdNum },
      data: { departmentId: departmentIdNum },
    });

    res.json(successResponse({ message: `Отдел пользователя ${userId} обновлен` }));
  } catch (error: unknown) {
    res.status(500).json(
      errorResponse('Ошибка назначения отдела', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});


router.get('/departments', authenticateToken, checkUserStatus, 
async (req: AuthRequest, res: express.Response<DepartmentResponse>) => {
  try {
    const departments = await prisma.department.findMany({
      select: {
        id: true,
        name: true
      },
      orderBy: {
        name: 'asc'
      }
    });

    res.json(successResponse(departments));
  } catch (error) {
    res.status(500).json(
      errorResponse('Ошибка получения списка отделов', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

// Администратор может назначить пользователя начальником отдела
router.post('/:userId/department/:departmentId/manager', authenticateToken, checkUserStatus, authorizeRoles(['admin']), auditLog('Админ назначил менеджера отдела'), 
async (req: AuthRequest<AssignDepartmentManagerRequest, AssignDepartmentManagerResponse>, res: express.Response<AssignDepartmentManagerResponse>) => {
  try {
    const { userId, departmentId } = req.params;

    const departmentIdNum = Number(departmentId);
    if (isNaN(departmentIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const userIdNum = Number(userId);
    if (isNaN(userIdNum)) {
      return res.status(400).json(
        errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userIdNum } });
    if (!user) {
      return res.status(404).json(
        errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
      );
    }

    const department = await prisma.department.findUnique({ where: { id: departmentIdNum } });
    if (!department) {
      return res.status(404).json(
        errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND)
      );
    }

    const managerRole = await prisma.role.findUnique({ where: { name: 'department_manager' } });
    if (!managerRole) {
      return res.status(404).json(
        errorResponse('Роль "менеджер отдела" не найдена', ErrorCodes.NOT_FOUND)
      );
    }

    await prisma.departmentRole.upsert({
      where: {
        userId_roleId_departmentId: {
          userId: userIdNum,
          roleId: managerRole.id,
          departmentId: departmentIdNum,
        },
      },
      update: {},
      create: {
        userId: userIdNum,
        roleId: managerRole.id,
        departmentId: departmentIdNum,
      },
    });

    res.json(
      successResponse({ message: `Пользователь ${userId} назначен менеджером отдела ${departmentId}` })
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).json(
        errorResponse('Ошибка назначения менеджера отдела', ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined)
      );
    } else {
      res.status(500).json(
        errorResponse('Ошибка назначения менеджера отдела', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
});

export default router;