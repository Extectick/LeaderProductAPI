import express from 'express';
import { PrismaClient } from '@prisma/client';
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
import { auditLog } from '../middleware/audit';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import { getProfile } from '../services/userService';

const router = express.Router();
const prisma = new PrismaClient();

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
 *               $ref: '#/components/schemas/ApiSuccess'
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
 *               $ref: '#/components/schemas/ApiSuccess'
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
 *                 type: object
 *                 properties:
 *                   street: { type: string }
 *                   city: { type: string }
 *                   state: { type: string }
 *                   postalCode: { type: string }
 *                   country: { type: string }
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
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
 *                 type: object
 *                 properties:
 *                   street: { type: string }
 *                   city: { type: string }
 *                   state: { type: string }
 *                   postalCode: { type: string }
 *                   country: { type: string }
 *     responses:
 *       200:
 *         description: Профиль создан
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccess'
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
 *               $ref: '#/components/schemas/ApiSuccess'
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
 *                         type: object
 *                         properties:
 *                           id: { type: integer }
 *                           name: { type: string }
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
 *               $ref: '#/components/schemas/ApiSuccess'
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
        const isAdmin = requester?.role?.name === 'admin';
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

export default router;
