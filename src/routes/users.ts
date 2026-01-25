import express from 'express';
import { ProfileStatus } from '@prisma/client';
import prisma from '../prisma/client';
import {
  authenticateToken,
  authorizeRoles,
  authorizePermissions,
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
import { auditLog } from '../middleware/audit';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import { getProfile } from '../services/userService';

const router = express.Router();
const USER_LIST_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: { select: { id: true, name: true } },
  employeeProfile: { select: { departmentId: true } },
};

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: Пользователи, профили и отделы
 */

/**
 * @openapi
 * /users/me/department:
 *   put:
 *     tags: [Users]
 *     summary: Пользователь обновляет свой отдел
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               departmentId:
 *                 type: number
 *             required: [departmentId]
 *     responses:
 *       200:
 *         description: Отдел обновлён
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные данные }
 *       401: { description: Не авторизован }
 *       404: { description: Отдел не найден }
 */
router.put(
  '/me/department',
  authenticateToken,
  checkUserStatus,
  auditLog('Пользователь обновил свой отдел'),
  async (
    req: AuthRequest<{}, UpdateUserDepartmentResponse, UpdateUserDepartmentRequest>,
    res: express.Response<UpdateUserDepartmentResponse>
  ) => {
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

      res.json(successResponse({ message: 'Отдел пользователя обновлен' }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        res.status(500).json(
          errorResponse(
            'Ошибка обновления отдела',
            ErrorCodes.INTERNAL_ERROR,
            process.env.NODE_ENV === 'development' ? error : undefined
          )
        );
      } else {
        res.status(500).json(
          errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR)
        );
      }
    }
  }
);

/**
 * @openapi
 * /users/{userId}/department:
 *   put:
 *     tags: [Users]
 *     summary: Администратор назначает отдел пользователю
 *     security:
 *       - bearerAuth: []
 *     x-roles: [admin]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               departmentId:
 *                 type: number
 *             required: [departmentId]
 *     responses:
 *       200:
 *         description: Отдел назначен
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные параметры }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав }
 *       404: { description: Пользователь или отдел не найдены }
 */
router.put(
  '/:userId/department',
  authenticateToken,
  checkUserStatus,
  authorizeRoles(['admin']),
  auditLog('Админ обновил отдел пользователя'),
  async (
    req: AuthRequest<{ userId: string }, UpdateUserDepartmentResponse, UpdateUserDepartmentRequest>,
    res: express.Response<UpdateUserDepartmentResponse>
  ) => {
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

      res.json(successResponse({ message: `Отдел пользователя ${userId} обновлен` }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        res.status(500).json(
          errorResponse(
            'Ошибка обновления отдела',
            ErrorCodes.INTERNAL_ERROR,
            process.env.NODE_ENV === 'development' ? error : undefined
          )
        );
      } else {
        res.status(500).json(
          errorResponse('Ошибка обновления отдела', ErrorCodes.INTERNAL_ERROR)
        );
      }
    }
  }
);

/**
 * @openapi
 * /users/profile:
 *   get:
 *     tags: [Users]
 *     summary: Получить профиль текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       401: { description: Не авторизован }
 *       404: { description: Пользователь не найден }
 */
router.get(
  '/profile',
  authenticateToken,
  checkUserStatus,
  async (req: UserProfileRequest, res: express.Response<UserProfileResponse>) => {
    try {
      const userId = req.user!.userId;

      const profile = await getProfile(userId);
      if (!profile) {
        return res.status(404).json(
          errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
        );
      }

      res.set('Cache-Control', 'no-store');
      res.json(successResponse({ profile }));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка получения профиля',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/profiles/client:
 *   post:
 *     tags: [Users]
 *     summary: Создать клиентский профиль для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName]
 *               phone: { type: string }
 *               address:
 *                 $ref: '#/components/schemas/Address'
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль клиента успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       409: { description: Профиль уже существует }
 */
router.post(
  '/profiles/client',
  authenticateToken,
  checkUserStatus,
  async (
    req: AuthRequest<{}, CreateProfileResponse, CreateClientProfileRequest>,
    res: express.Response<UserProfileResponse>
  ) => {
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
          errorResponse(
            'Если указан адрес, обязательные поля: address.street, address.city, address.country',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const existingProfile = await prisma.clientProfile.findUnique({ where: { userId } });
      if (existingProfile) {
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

      await prisma.clientProfile.create({
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

      const resProfile = await getProfile(userId);

      res.json(successResponse({
        profile: resProfile,
        message: 'Профиль клиента успешно создан'
      }));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка создания клиентского профиля',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/profiles/supplier:
 *   post:
 *     tags: [Users]
 *     summary: Создать профиль поставщика для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName]
 *               phone: { type: string }
 *               address:
 *                 $ref: '#/components/schemas/Address'
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль поставщика успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       409: { description: Профиль уже существует }
 */
router.post(
  '/profiles/supplier',
  authenticateToken,
  checkUserStatus,
  async (
    req: AuthRequest<{}, CreateProfileResponse, CreateSupplierProfileRequest>,
    res: express.Response<UserProfileResponse>
  ) => {
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
          errorResponse(
            'Если указан адрес, обязательные поля: address.street, address.city, address.country',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const existingProfile = await prisma.supplierProfile.findUnique({ where: { userId } });
      if (existingProfile) {
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

      await prisma.supplierProfile.create({
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

      const resProfile = await getProfile(userId);

      res.json(successResponse({
        profile: resProfile,
        message: 'Профиль поставщика успешно создан'
      }));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка создания профиля поставщика',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/profiles/employee:
 *   post:
 *     tags: [Users]
 *     summary: Создать профиль сотрудника для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user:
 *                 type: object
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   middleName: { type: string }
 *                 required: [firstName, lastName]
 *               phone: { type: string }
 *               departmentId: { type: number }
 *             required: [user, departmentId]
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile: { $ref: '#/components/schemas/UserProfile' }
 *                         message: { type: 'string', example: 'Профиль сотрудника успешно создан' }
 *       400: { description: Ошибка валидации }
 *       401: { description: Не авторизован }
 *       404: { description: Отдел не найден }
 *       409: { description: Профиль уже существует }
 */
router.post(
  '/profiles/employee',
  authenticateToken,
  checkUserStatus,
  async (
    req: AuthRequest<{}, CreateProfileResponse, CreateEmployeeProfileRequest>,
    res: express.Response<UserProfileResponse>
  ) => {
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

      await prisma.employeeProfile.create({
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

      const resProfile = await getProfile(userId);

      res.json(successResponse({
        profile: resProfile,
        message: 'Профиль сотрудника успешно создан'
      }));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка создания профиля сотрудника',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/departments:
 *   get:
 *     tags: [Users]
 *     summary: Список отделов
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Успешно
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/DepartmentMini'
 *       401: { description: Не авторизован }
 */
router.get(
  '/departments',
  authenticateToken,
  checkUserStatus,
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
        errorResponse(
          'Ошибка получения списка отделов',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Создать отдел (для админов/управления отделами)
 */
router.post(
  '/departments',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_departments'], { mode: 'any' }),
  async (req: AuthRequest<{}, DepartmentResponse, { name?: string }>, res: express.Response<DepartmentResponse>) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) {
        return res.status(400).json(errorResponse('Название отдела обязательно', ErrorCodes.VALIDATION_ERROR));
      }

      const dep = await prisma.department.upsert({
        where: { name },
        update: {},
        create: { name },
      });

      res.json(successResponse([{ id: dep.id, name: dep.name }]));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка создания отдела',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Обновить отдел (переименовать)
 */
router.patch(
  '/departments/:departmentId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_departments'], { mode: 'any' }),
  async (
    req: AuthRequest<{ departmentId: string }, DepartmentResponse, { name?: string }>,
    res: express.Response<DepartmentResponse>
  ) => {
    try {
      const departmentId = Number(req.params.departmentId);
      if (Number.isNaN(departmentId)) {
        return res.status(400).json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }
      const name = (req.body.name || '').trim();
      if (!name) {
        return res.status(400).json(errorResponse('Название отдела обязательно', ErrorCodes.VALIDATION_ERROR));
      }

      const dep = await prisma.department.update({
        where: { id: departmentId },
        data: { name },
      });

      res.json(successResponse([{ id: dep.id, name: dep.name }]));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }
      res.status(500).json(
        errorResponse(
          'Ошибка обновления отдела',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Удалить отдел
 */
router.delete(
  '/departments/:departmentId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_departments'], { mode: 'any' }),
  async (req: AuthRequest<{ departmentId: string }>, res: express.Response<DepartmentResponse>) => {
    try {
      const departmentId = Number(req.params.departmentId);
      if (Number.isNaN(departmentId)) {
        return res.status(400).json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }

      // Снимаем ссылки, чтобы не нарушать FK (сотрудники, роли, обращения)
      await prisma.employeeProfile.updateMany({ where: { departmentId }, data: { departmentId: null } });
      await prisma.departmentRole.deleteMany({ where: { departmentId } });
      // обращения, где отдел указан
      // Обнуляем ссылку на отдел в обращениях, чтобы не ломать FK
      await prisma.appeal.updateMany({
        where: { toDepartmentId: departmentId },
        data: { toDepartmentId: null as any },
      });
      await prisma.department.delete({ where: { id: departmentId } });
      res.json(successResponse([{ id: departmentId, name: 'deleted' }]));
    } catch (error) {
      const code = (error as any)?.code;
      const msg = (error as any)?.message?.toString() || '';
      if (code === 'P2003' || msg.includes('Appeal_toDepartmentId_fkey') || msg.includes('violates RESTRICT')) {
        return res.status(409).json(
          errorResponse('Нельзя удалить отдел: есть связанные записи (сотрудники/роли/обращения)', ErrorCodes.CONFLICT)
        );
      }
      if (code === 'P2025') {
        return res.status(404).json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }
      console.error('Ошибка удаления отдела', error);
      res.status(500).json(
        errorResponse(
          'Ошибка удаления отдела',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/{userId}/department/{departmentId}/manager:
 *   post:
 *     tags: [Users]
 *     summary: Назначить пользователя менеджером отдела
 *     security:
 *       - bearerAuth: []
 *     x-roles: [admin]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: departmentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Назначение выполнено
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/MessageOnly' }
 *       400: { description: Неверные параметры }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав }
 *       404: { description: Пользователь/Отдел/Роль не найдены }
 */
router.post(
  '/:userId/department/:departmentId/manager',
  authenticateToken,
  checkUserStatus,
  authorizeRoles(['admin']),
  auditLog('Админ назначил менеджера отдела'),
  async (
    req: AuthRequest<AssignDepartmentManagerRequest, AssignDepartmentManagerResponse>,
    res: express.Response<AssignDepartmentManagerResponse>
  ) => {
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
          errorResponse(
            'Ошибка назначения менеджера отдела',
            ErrorCodes.INTERNAL_ERROR,
            process.env.NODE_ENV === 'development' ? error : undefined
          )
        );
      } else {
        res.status(500).json(
          errorResponse('Ошибка назначения менеджера отдела', ErrorCodes.INTERNAL_ERROR)
        );
      }
    }
  }
);

/**
 * Права (перечень)
 */
router.get(
  '/permissions',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_permissions'], { mode: 'any' }),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const permissions = await prisma.permission.findMany({ orderBy: { name: 'asc' } });
      res.json(successResponse(permissions));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка получения списка прав',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Роли: список
 */
router.get(
  '/roles',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_roles'], { mode: 'any' }),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const roles = await prisma.role.findMany({
        orderBy: { name: 'asc' },
        include: {
          parentRole: { select: { id: true, name: true } },
          permissions: { include: { permission: true } },
        },
      });
      const data = roles.map((r) => ({
        id: r.id,
        name: r.name,
        parentRole: r.parentRole ? { id: r.parentRole.id, name: r.parentRole.name } : null,
        permissions: r.permissions.map((p) => p.permission.name),
      }));
      res.json(successResponse(data));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка получения списка ролей',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Список пользователей с поиском
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_roles', 'manage_users'], { mode: 'any' }),
  async (req: AuthRequest<{}, {}, {}, { search?: string }>, res: express.Response) => {
    try {
      const search = (req.query.search || '').trim();
      const users = await prisma.user.findMany({
        where: search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' } },
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
              ],
            }
          : {},
        select: USER_LIST_SELECT,
        orderBy: { id: 'asc' },
        take: 50,
      });
      res.json(successResponse(users));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка получения пользователей',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/profile:
 *   patch:
 *     tags: [Users]
 *     summary: Обновить профиль текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string, nullable: true }
 *               lastName: { type: string, nullable: true }
 *               middleName: { type: string, nullable: true }
 *               email: { type: string }
 *               phone: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Профиль обновлён
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       400: { description: Неверные данные }
 *       401: { description: Не авторизован }
 *       409: { description: Email уже используется }
 */
router.patch(
  '/profile',
  authenticateToken,
  checkUserStatus,
  auditLog('Пользователь обновил профиль'),
  async (
    req: AuthRequest<{}, UserProfileResponse, { firstName?: string | null; lastName?: string | null; middleName?: string | null; email?: string; phone?: string | null }>,
    res: express.Response<UserProfileResponse>
  ) => {
    try {
      const userId = req.user!.userId;
      const data: Record<string, any> = {};
      let employeePhone: string | null | undefined = undefined;
      const normalize = (val: unknown) => (val === null ? null : String(val).trim());

      if (req.body.firstName !== undefined) {
        const value = normalize(req.body.firstName);
        data.firstName = value || null;
      }
      if (req.body.lastName !== undefined) {
        const value = normalize(req.body.lastName);
        data.lastName = value || null;
      }
      if (req.body.middleName !== undefined) {
        const value = normalize(req.body.middleName);
        data.middleName = value || null;
      }
      if (req.body.email !== undefined) {
        const value = normalize(req.body.email);
        if (!value) {
          return res.status(400).json(
            errorResponse('Email обязателен', ErrorCodes.VALIDATION_ERROR)
          );
        }
        data.email = value;
      }
      if (req.body.phone !== undefined) {
        const value = normalize(req.body.phone);
        data.phone = value || null;
        employeePhone = value || null;
      }

      if (Object.keys(data).length) {
        await prisma.user.update({ where: { id: Number(userId) }, data });
      }

      if (employeePhone !== undefined) {
        await prisma.employeeProfile.updateMany({
          where: { userId: Number(userId) },
          data: { phone: employeePhone },
        });
      }

      const profile = await getProfile(Number(userId));
      return res.json(successResponse({ profile }, 'Профиль обновлён'));
    } catch (error: any) {
      if (error?.code === 'P2002') {
        return res.status(409).json(
          errorResponse('Email уже используется', ErrorCodes.CONFLICT)
        );
      }
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления профиля',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Админ: обновить данные пользователя (ФИО, email, phone, статус, department)
 */
router.patch(
  '/:userId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_users'], { mode: 'any' }),
  async (
    req: AuthRequest<{ userId: string }, {}, { firstName?: string; lastName?: string; middleName?: string; email?: string; phone?: string; profileStatus?: ProfileStatus; departmentId?: number | null }>,
    res: express.Response
  ) => {
    try {
      const userId = Number(req.params.userId);
      if (Number.isNaN(userId)) {
        return res.status(400).json(errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR));
      }
      const data: any = {};
      if (req.body.firstName !== undefined) data.firstName = req.body.firstName;
      if (req.body.lastName !== undefined) data.lastName = req.body.lastName;
      if (req.body.middleName !== undefined) data.middleName = req.body.middleName;
      if (req.body.email !== undefined) data.email = req.body.email;
      if (req.body.phone !== undefined) data.phone = req.body.phone;
      if (req.body.profileStatus !== undefined) data.profileStatus = req.body.profileStatus;

      if (Object.keys(data).length) {
        await prisma.user.update({ where: { id: userId }, data });
      }

      if (req.body.departmentId !== undefined) {
        const depId = req.body.departmentId;
        if (depId === null) {
          await prisma.employeeProfile.updateMany({ where: { userId }, data: { departmentId: null } });
        } else {
          const department = await prisma.department.findUnique({ where: { id: Number(depId) } });
          if (!department) {
            return res.status(404).json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
          }
          await prisma.employeeProfile.updateMany({ where: { userId }, data: { departmentId: Number(depId) } });
        }
      }

      const profile = await getProfile(userId);
      return res.json(successResponse({ profile }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления пользователя',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Админ: смена пароля пользователя
 */
router.patch(
  '/:userId/password',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_users'], { mode: 'any' }),
  async (req: AuthRequest<{ userId: string }, {}, { password?: string }>, res: express.Response) => {
    try {
      const userId = Number(req.params.userId);
      if (Number.isNaN(userId)) {
        return res.status(400).json(errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR));
      }
      const { password } = req.body;
      if (!password || password.length < 6) {
        return res.status(400).json(errorResponse('Пароль должен быть не менее 6 символов', ErrorCodes.VALIDATION_ERROR));
      }
      const bcrypt = require('bcrypt');
      const passwordHash = await bcrypt.hash(password, 10);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
      return res.json(successResponse({ message: 'Пароль обновлен' }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления пароля',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Создать роль
 */
router.post(
  '/roles',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_roles'], { mode: 'any' }),
  async (req: AuthRequest<{}, {}, { name?: string; parentRoleId?: number; permissions?: string[] }>, res: express.Response) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) {
        return res.status(400).json(errorResponse('Название роли обязательно', ErrorCodes.VALIDATION_ERROR));
      }

      const role = await prisma.role.create({
        data: {
          name,
          parentRoleId: req.body.parentRoleId ?? null,
        },
      });

      const perms = Array.isArray(req.body.permissions) ? req.body.permissions : [];
      if (perms.length) {
        for (const permName of perms) {
          const perm = await prisma.permission.findUnique({ where: { name: permName } });
          if (perm) {
            await prisma.rolePermissions.create({ data: { roleId: role.id, permissionId: perm.id } });
          }
        }
      }

      res.json(successResponse({ id: role.id, name: role.name }));
    } catch (error) {
      res.status(500).json(
        errorResponse(
          'Ошибка создания роли',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Обновить роль (имя/parent)
 */
router.patch(
  '/roles/:roleId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_roles'], { mode: 'any' }),
  async (req: AuthRequest<{ roleId: string }, {}, { name?: string; parentRoleId?: number }>, res: express.Response) => {
    try {
      const roleId = Number(req.params.roleId);
      if (Number.isNaN(roleId)) {
        return res.status(400).json(errorResponse('Некорректный ID роли', ErrorCodes.VALIDATION_ERROR));
      }
      const data: any = {};
      if (req.body.name) data.name = req.body.name.trim();
      if (req.body.parentRoleId !== undefined) data.parentRoleId = req.body.parentRoleId ?? null;
      if (!Object.keys(data).length) {
        return res.status(400).json(errorResponse('Нет данных для обновления', ErrorCodes.VALIDATION_ERROR));
      }

      const role = await prisma.role.update({ where: { id: roleId }, data });
      res.json(successResponse({ id: role.id, name: role.name }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }
      res.status(500).json(
        errorResponse(
          'Ошибка обновления роли',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Задать права роли
 */
router.patch(
  '/roles/:roleId/permissions',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_permissions'], { mode: 'any' }),
  async (req: AuthRequest<{ roleId: string }, {}, { permissions?: string[] }>, res: express.Response) => {
    try {
      const roleId = Number(req.params.roleId);
      if (Number.isNaN(roleId)) {
        return res.status(400).json(errorResponse('Некорректный ID роли', ErrorCodes.VALIDATION_ERROR));
      }
      const permNames = Array.isArray(req.body.permissions) ? req.body.permissions : [];

      await prisma.rolePermissions.deleteMany({ where: { roleId } });
      if (permNames.length) {
        const perms = await prisma.permission.findMany({ where: { name: { in: permNames } } });
        for (const perm of perms) {
          await prisma.rolePermissions.create({ data: { roleId, permissionId: perm.id } });
        }
      }

      res.json(successResponse({ message: 'Права роли обновлены' }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }
      res.status(500).json(
        errorResponse(
          'Ошибка обновления прав роли',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Удалить роль
 */
router.delete(
  '/roles/:roleId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_roles'], { mode: 'any' }),
  async (req: AuthRequest<{ roleId: string }>, res: express.Response) => {
    try {
      const roleId = Number(req.params.roleId);
      if (Number.isNaN(roleId)) {
        return res.status(400).json(errorResponse('Некорректный ID роли', ErrorCodes.VALIDATION_ERROR));
      }

      // Снимаем внешние связи перед удалением роли
      const baseUserRole = await prisma.role.findUnique({ where: { name: 'user' } });
      await prisma.user.updateMany({
        where: { roleId },
        data: baseUserRole?.id ? { roleId: baseUserRole.id } : { roleId: null as any },
      });
      await prisma.role.updateMany({
        where: { parentRoleId: roleId },
        data: { parentRoleId: null },
      });
      await prisma.departmentRole.deleteMany({ where: { roleId } });
      await prisma.rolePermissions.deleteMany({ where: { roleId } });

      await prisma.role.delete({ where: { id: roleId } });
      res.json(successResponse({ message: 'Роль удалена' }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }
      res.status(500).json(
        errorResponse(
          'Ошибка удаления роли',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Назначить основную роль пользователю
 */
router.post(
  '/:userId/role',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['assign_roles'], { mode: 'any' }),
  async (req: AuthRequest<{ userId: string }, {}, { roleId?: number; roleName?: string }>, res: express.Response) => {
    try {
      const userId = Number(req.params.userId);
      if (Number.isNaN(userId)) {
        return res.status(400).json(errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR));
      }

      let role = null;
      if (req.body.roleId) {
        role = await prisma.role.findUnique({ where: { id: Number(req.body.roleId) } });
      } else if (req.body.roleName) {
        role = await prisma.role.findUnique({ where: { name: req.body.roleName } });
      }
      if (!role) {
        return res.status(404).json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }

      await prisma.user.update({
        where: { id: userId },
        data: { roleId: role.id },
      });

      res.json(successResponse({ message: 'Роль пользователя обновлена' }));
    } catch (error) {
      const isNotFound = (error as any)?.code === 'P2025';
      if (isNotFound) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      res.status(500).json(
        errorResponse(
          'Ошибка назначения роли пользователю',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /users/{userId}/profile:
 *   get:
 *     tags: [Users]
 *     summary: Получить профиль пользователя по ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         profile:
 *                           $ref: '#/components/schemas/UserProfile'
 *       400: { description: Неверный ID }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав на просмотр }
 *       404: { description: Пользователь не найден }
 */
router.get(
  '/:userId/profile',
  authenticateToken,
  checkUserStatus,
  async (
    req: AuthRequest<{ userId: string }, UserProfileResponse>,
    res: express.Response<UserProfileResponse>
  ) => {
    try {
      const requestedId = Number(req.params.userId);
      if (Number.isNaN(requestedId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR));
      }

      const requesterId = req.user!.userId;
      const isSelf = requestedId === requesterId;

      if (!isSelf) {
        // Только админ может смотреть чужие профили
        const requester = await prisma.user.findUnique({
          where: { id: requesterId },
          include: { role: true },
        });
        const isAdmin = requester?.role?.name === 'admin' || requester?.role?.name === 'administrator';
        if (!isAdmin) {
          return res
            .status(403)
            .json(errorResponse('Недостаточно прав для просмотра профиля', ErrorCodes.FORBIDDEN));
        }
      }

      const profile = await getProfile(requestedId);
      if (!profile) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      return res.json(successResponse({ profile }));
    } catch (error) {
      return res.status(500).json(
        errorResponse(
          'Ошибка получения профиля пользователя',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

/**
 * Список пользователей по отделу
 */
router.get(
  '/departments/:departmentId/users',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_departments'], { mode: 'any' }),
  async (req: AuthRequest<{ departmentId: string }>, res: express.Response) => {
    try {
      const departmentId = Number(req.params.departmentId);
      if (Number.isNaN(departmentId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }

      const users = await prisma.user.findMany({
        where: { employeeProfile: { departmentId } },
        select: USER_LIST_SELECT,
        orderBy: { id: 'asc' },
      });

      return res.json(successResponse(users));
    } catch (error) {
      console.error('Ошибка получения пользователей отдела', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения пользователей отдела',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? error : undefined
        )
      );
    }
  }
);

export default router;
