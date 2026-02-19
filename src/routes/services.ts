import express from 'express';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { ErrorCodes, errorResponse, successResponse } from '../utils/apiResponse';
import { listServicesForAdmin, listServicesForUser } from '../services/serviceAccess';
import {
  DEFAULT_SERVICE_PERMISSION_ACTIONS,
  SERVICE_PERMISSION_ACTION_LABELS,
} from '../rbac/permissionCatalog';

const router = express.Router();

const SNAKE_CASE_RE = /^[a-z0-9_]+$/;
const SERVICE_KINDS = new Set(['LOCAL', 'CLOUD']);

function normalizeServiceKind(value: unknown): { ok: true; kind: 'LOCAL' | 'CLOUD' } | { ok: false; message: string } {
  const normalized = String(value || 'CLOUD').trim().toUpperCase();
  if (!SERVICE_KINDS.has(normalized)) {
    return { ok: false, message: 'kind должен быть LOCAL или CLOUD' };
  }
  return { ok: true, kind: normalized as 'LOCAL' | 'CLOUD' };
}

function normalizeActionList(value: unknown): { ok: true; actions: string[] } | { ok: false; message: string } {
  const source = Array.isArray(value) ? value : DEFAULT_SERVICE_PERMISSION_ACTIONS;
  const unique = Array.from(
    new Set(
      source
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (!unique.length) {
    return { ok: false, message: 'Список действий для прав не может быть пустым' };
  }
  if (!unique.every((action) => SNAKE_CASE_RE.test(action))) {
    return {
      ok: false,
      message: 'Каждое действие должно быть в формате lowercase snake_case',
    };
  }

  return { ok: true, actions: unique };
}

function makeServicePermissionDisplay(action: string, serviceName: string): string {
  const actionLabel = SERVICE_PERMISSION_ACTION_LABELS[action] || action;
  return `${actionLabel} (${serviceName})`;
}

function makeServicePermissionDescription(action: string, serviceName: string): string {
  const actionLabel = (SERVICE_PERMISSION_ACTION_LABELS[action] || action).toLowerCase();
  return `Разрешает ${actionLabel} в сервисе "${serviceName}".`;
}

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

router.post(
  '/admin',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<
      {},
      {},
      {
        key?: string;
        name?: string;
        route?: string | null;
        icon?: string | null;
        description?: string | null;
        gradientStart?: string | null;
        gradientEnd?: string | null;
        kind?: 'LOCAL' | 'CLOUD';
        isActive?: boolean;
        defaultVisible?: boolean;
        defaultEnabled?: boolean;
        generatePermissionTemplate?: boolean;
        permissionActions?: string[];
      }
    >,
    res: express.Response
  ) => {
    try {
      const key = String(req.body.key || '').trim().toLowerCase();
      const name = String(req.body.name || '').trim();
      if (!key || !SNAKE_CASE_RE.test(key)) {
        return res.status(400).json(
          errorResponse('Ключ сервиса обязателен и должен быть в формате lowercase snake_case', ErrorCodes.VALIDATION_ERROR)
        );
      }
      if (!name) {
        return res
          .status(400)
          .json(errorResponse('Название сервиса обязательно', ErrorCodes.VALIDATION_ERROR));
      }
      const normalizedKind = normalizeServiceKind(req.body.kind);
      if (!normalizedKind.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedKind.message, ErrorCodes.VALIDATION_ERROR));
      }

      const generatePermissionTemplate = req.body.generatePermissionTemplate !== false;
      const normalizedActionsResult = normalizeActionList(req.body.permissionActions);
      let actions: string[] = [];
      if (generatePermissionTemplate) {
        if (!normalizedActionsResult.ok) {
          return res
            .status(400)
            .json(errorResponse(normalizedActionsResult.message, ErrorCodes.VALIDATION_ERROR));
        }
        actions = normalizedActionsResult.actions;
      }

      const existingService = await prisma.service.findUnique({ where: { key }, select: { id: true } });
      if (existingService) {
        return res
          .status(400)
          .json(errorResponse('Сервис с таким key уже существует', ErrorCodes.VALIDATION_ERROR));
      }

      const permissionNames = actions.map((action) => `${action}_${key}`);
      if (permissionNames.length) {
        const existingPermissions = await prisma.permission.findMany({
          where: { name: { in: permissionNames } },
          select: { name: true },
        });
        if (existingPermissions.length) {
          return res.status(400).json(
            errorResponse(
              `Найдены коллизии прав: ${existingPermissions.map((p) => p.name).join(', ')}`,
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }
      }

      const groupKey = `service_${key}`;
      if (generatePermissionTemplate) {
        const existingGroup = await prisma.permissionGroup.findUnique({
          where: { key: groupKey },
          select: { id: true },
        });
        if (existingGroup) {
          return res.status(400).json(
            errorResponse(
              `Группа прав ${groupKey} уже существует`,
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const service = await tx.service.create({
          data: {
            key,
            name,
            kind: normalizedKind.kind,
            route: req.body.route ?? null,
            icon: req.body.icon ?? null,
            description: req.body.description ?? null,
            gradientStart: req.body.gradientStart ?? null,
            gradientEnd: req.body.gradientEnd ?? null,
            isActive: req.body.isActive ?? true,
            defaultVisible: req.body.defaultVisible ?? true,
            defaultEnabled: req.body.defaultEnabled ?? true,
          },
          include: {
            roleAccess: { select: { id: true, roleId: true, visible: true, enabled: true } },
            departmentAccess: { select: { id: true, departmentId: true, visible: true, enabled: true } },
          },
        });

        let permissionGroup: {
          id: number;
          key: string;
          displayName: string;
          description: string;
          isSystem: boolean;
          sortOrder: number;
          serviceId: number | null;
        } | null = null;
        const createdPermissions: Array<{ id: number; name: string; displayName: string; description: string }> = [];

        if (generatePermissionTemplate) {
          permissionGroup = await tx.permissionGroup.create({
            data: {
              key: groupKey,
              displayName: `Сервис: ${name}`,
              description: `Права доступа к сервису "${name}".`,
              sortOrder: 500,
              isSystem: true,
              serviceId: service.id,
            },
            select: {
              id: true,
              key: true,
              displayName: true,
              description: true,
              isSystem: true,
              sortOrder: true,
              serviceId: true,
            },
          });

          for (const action of actions) {
            const permissionName = `${action}_${key}`;
            const createdPermission = await tx.permission.create({
              data: {
                name: permissionName,
                displayName: makeServicePermissionDisplay(action, name),
                description: makeServicePermissionDescription(action, name),
                groupId: permissionGroup.id,
              },
              select: { id: true, name: true, displayName: true, description: true },
            });
            createdPermissions.push(createdPermission);
          }

          if (createdPermissions.length) {
            const adminRole = await tx.role.findUnique({ where: { name: 'admin' }, select: { id: true } });
            if (adminRole) {
              await tx.rolePermissions.createMany({
                data: createdPermissions.map((perm) => ({
                  roleId: adminRole.id,
                  permissionId: perm.id,
                })),
                skipDuplicates: true,
              });
            }
          }
        }

        return { service, permissionGroup, createdPermissions };
      });

      return res.json(
        successResponse({
          service: created.service,
          permissionGroup: created.permissionGroup,
          createdPermissions: created.createdPermissions,
        })
      );
    } catch (error) {
      console.error('service create error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка создания сервиса', ErrorCodes.INTERNAL_ERROR));
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
      kind?: 'LOCAL' | 'CLOUD';
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

      const data = { ...req.body } as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(req.body, 'kind')) {
        const normalizedKind = normalizeServiceKind(req.body.kind);
        if (!normalizedKind.ok) {
          return res
            .status(400)
            .json(errorResponse(normalizedKind.message, ErrorCodes.VALIDATION_ERROR));
        }
        data.kind = normalizedKind.kind;
      }
      const updated = await prisma.service.update({
        where: { id: serviceId },
        data: data as any,
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
