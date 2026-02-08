import express from 'express';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { ErrorCodes, errorResponse, successResponse } from '../utils/apiResponse';
import { listServicesForAdmin, listServicesForUser } from '../services/serviceAccess';

const router = express.Router();

/**
 * @openapi
 * /services:
 *   get:
 *     tags: [Services]
 *     summary: Список сервисов для текущего пользователя
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список сервисов с флагами доступа
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest, res: express.Response) => {
    try {
      const { services, isEmployee } = await listServicesForUser(req.user!.userId);
      if (!isEmployee) {
        return res
          .status(403)
          .json(errorResponse('Сервисы доступны только сотрудникам', ErrorCodes.FORBIDDEN));
      }
      res.set('Cache-Control', 'no-store');
      return res.json(successResponse({ services }));
    } catch (error) {
      console.error('services list error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения сервисов', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /services/admin:
 *   get:
 *     tags: [Services]
 *     summary: Админский список сервисов и правил
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "manage_services" ]
 */
router.get(
  '/admin',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (_req: AuthRequest, res: express.Response) => {
    try {
      const services = await listServicesForAdmin();
      res.set('Cache-Control', 'no-store');
      return res.json(successResponse({ services }));
    } catch (error) {
      console.error('services admin list error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения сервисов', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * Обновить базовые параметры сервиса (дефолты/активность/метаданные)
 */
router.patch(
  '/:serviceId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ serviceId: string }, {}, {
      name?: string;
      route?: string | null;
      icon?: string | null;
      description?: string | null;
      gradientStart?: string | null;
      gradientEnd?: string | null;
      isActive?: boolean;
      defaultVisible?: boolean;
      defaultEnabled?: boolean;
    }>,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }

      const data = { ...req.body };
      const updated = await prisma.service.update({
        where: { id: serviceId },
        data,
      });
      const full = await prisma.service.findUnique({
        where: { id: updated.id },
        include: {
          roleAccess: { select: { id: true, roleId: true, visible: true, enabled: true } },
          departmentAccess: { select: { id: true, departmentId: true, visible: true, enabled: true } },
        },
      });

      return res.json(successResponse({ service: full ?? updated }));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      console.error('service update error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления сервиса', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * Upsert правило по роли для сервиса
 */
router.put(
  '/:serviceId/role-access',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ serviceId: string }, {}, { roleId?: number; visible?: boolean | null; enabled?: boolean | null }>,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const { roleId, visible, enabled } = req.body;
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }
      if (!roleId) {
        return res
          .status(400)
          .json(errorResponse('roleId обязателен', ErrorCodes.VALIDATION_ERROR));
      }
      if (visible === undefined && enabled === undefined) {
        return res
          .status(400)
          .json(errorResponse('Нужно указать visible и/или enabled', ErrorCodes.VALIDATION_ERROR));
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      const role = await prisma.role.findUnique({ where: { id: Number(roleId) } });
      if (!role) {
        return res
          .status(404)
          .json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }

      const rule = await prisma.serviceRoleAccess.upsert({
        where: { serviceId_roleId: { serviceId, roleId: Number(roleId) } },
        update: { visible: visible ?? undefined, enabled: enabled ?? undefined },
        create: {
          serviceId,
          roleId: Number(roleId),
          visible: visible ?? null,
          enabled: enabled ?? null,
        },
      });

      return res.json(successResponse({ rule }));
    } catch (error) {
      console.error('service role-access error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения правила', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.delete(
  '/:serviceId/role-access/:roleId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (req: AuthRequest<{ serviceId: string; roleId: string }>, res: express.Response) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const roleId = Number(req.params.roleId);
      if (Number.isNaN(serviceId) || Number.isNaN(roleId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректные параметры', ErrorCodes.VALIDATION_ERROR));
      }

      await prisma.serviceRoleAccess.delete({
        where: { serviceId_roleId: { serviceId, roleId } },
      });
      return res.json(successResponse({ message: 'deleted' }));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res
          .status(404)
          .json(errorResponse('Правило не найдено', ErrorCodes.NOT_FOUND));
      }
      console.error('service role-access delete error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления правила', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * Upsert правило по отделу для сервиса
 */
router.put(
  '/:serviceId/department-access',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ serviceId: string }, {}, { departmentId?: number; visible?: boolean | null; enabled?: boolean | null }>,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const { departmentId, visible, enabled } = req.body;
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }
      if (!departmentId) {
        return res
          .status(400)
          .json(errorResponse('departmentId обязателен', ErrorCodes.VALIDATION_ERROR));
      }
      if (visible === undefined && enabled === undefined) {
        return res
          .status(400)
          .json(errorResponse('Нужно указать visible и/или enabled', ErrorCodes.VALIDATION_ERROR));
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      const dept = await prisma.department.findUnique({ where: { id: Number(departmentId) } });
      if (!dept) {
        return res
          .status(404)
          .json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }

      const rule = await prisma.serviceDepartmentAccess.upsert({
        where: { serviceId_departmentId: { serviceId, departmentId: Number(departmentId) } },
        update: { visible: visible ?? undefined, enabled: enabled ?? undefined },
        create: {
          serviceId,
          departmentId: Number(departmentId),
          visible: visible ?? null,
          enabled: enabled ?? null,
        },
      });

      return res.json(successResponse({ rule }));
    } catch (error) {
      console.error('service department-access error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения правила', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.delete(
  '/:serviceId/department-access/:departmentId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (req: AuthRequest<{ serviceId: string; departmentId: string }>, res: express.Response) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const departmentId = Number(req.params.departmentId);
      if (Number.isNaN(serviceId) || Number.isNaN(departmentId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректные параметры', ErrorCodes.VALIDATION_ERROR));
      }

      await prisma.serviceDepartmentAccess.delete({
        where: { serviceId_departmentId: { serviceId, departmentId } },
      });
      return res.json(successResponse({ message: 'deleted' }));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res
          .status(404)
          .json(errorResponse('Правило не найдено', ErrorCodes.NOT_FOUND));
      }
      console.error('service department-access delete error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления правила', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
