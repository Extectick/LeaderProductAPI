import express from 'express';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { ErrorCodes, errorResponse, successResponse } from '../utils/apiResponse';
import {
  explainServiceAccessForUser,
  listServiceAccessMatrix,
  listServicesForAdmin,
  listServicesForUser,
} from '../services/serviceAccess';
import {
  DEFAULT_SERVICE_PERMISSION_ACTIONS,
  SERVICE_PERMISSION_ACTION_LABELS,
} from '../rbac/permissionCatalog';

const router = express.Router();

const SNAKE_CASE_RE = /^[a-z0-9_]+$/;
const SERVICE_KINDS = new Set(['LOCAL', 'CLOUD']);
const SERVICE_ADMIN_INCLUDE = {
  roleAccess: { select: { id: true, roleId: true, visible: true, enabled: true } },
  departmentAccess: { select: { id: true, departmentId: true, visible: true, enabled: true } },
  departmentRoleAccess: {
    select: { id: true, departmentId: true, roleId: true, visible: true, enabled: true },
  },
  userAccess: { select: { id: true, userId: true, visible: true, enabled: true } },
} as const;

function validateVisibilityEnabledPair(
  visible: boolean | null | undefined,
  enabled: boolean | null | undefined,
  labels: { visible: string; enabled: string }
): string | null {
  const hasVisible = typeof visible === 'boolean';
  const hasEnabled = typeof enabled === 'boolean';
  if (!hasVisible && !hasEnabled) {
    return `Нужно указать хотя бы один явный флаг ${labels.visible} или ${labels.enabled}`;
  }
  if (visible === false && enabled === true) {
    return `${labels.enabled} не может быть true, если ${labels.visible} = false`;
  }
  return null;
}

function normalizeRuleItems(
  value: unknown,
  idKey: 'roleId' | 'departmentId' | 'userId' | 'serviceId'
):
  | {
      ok: true;
      items: Array<{
        id: number;
        visible: boolean | null;
        enabled: boolean | null;
      }>;
    }
  | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${idKey} rules должны быть массивом` };
  }

  const items: Array<{ id: number; visible: boolean | null; enabled: boolean | null }> = [];
  const seen = new Set<number>();

  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== 'object') {
      return { ok: false, message: 'Каждое правило должно быть объектом' };
    }
    const item = rawItem as Record<string, unknown>;
    const id = Number(item[idKey]);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, message: `${idKey} должен быть положительным числом` };
    }
    if (seen.has(id)) {
      return { ok: false, message: `Повторяющийся ${idKey}: ${id}` };
    }
    const visible = item.visible === undefined ? null : (item.visible as boolean | null);
    const enabled = item.enabled === undefined ? null : (item.enabled as boolean | null);
    if (visible !== null && typeof visible !== 'boolean') {
      return { ok: false, message: `visible должен быть boolean или null` };
    }
    if (enabled !== null && typeof enabled !== 'boolean') {
      return { ok: false, message: `enabled должен быть boolean или null` };
    }
    const pairValidation = validateVisibilityEnabledPair(visible, enabled, {
      visible: 'visible',
      enabled: 'enabled',
    });
    if (pairValidation) {
      return { ok: false, message: pairValidation };
    }
    seen.add(id);
    items.push({ id, visible, enabled });
  }

  return { ok: true, items };
}

function normalizeDepartmentRoleRuleItems(
  value: unknown
):
  | {
      ok: true;
      items: Array<{
        departmentId: number;
        roleId: number;
        visible: boolean | null;
        enabled: boolean | null;
      }>;
    }
  | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'departmentRoleAccess rules должны быть массивом' };
  }

  const items: Array<{
    departmentId: number;
    roleId: number;
    visible: boolean | null;
    enabled: boolean | null;
  }> = [];
  const seen = new Set<string>();

  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== 'object') {
      return { ok: false, message: 'Каждое правило должно быть объектом' };
    }
    const item = rawItem as Record<string, unknown>;
    const departmentId = Number(item.departmentId);
    const roleId = Number(item.roleId);
    if (!Number.isInteger(departmentId) || departmentId <= 0) {
      return { ok: false, message: 'departmentId должен быть положительным числом' };
    }
    if (!Number.isInteger(roleId) || roleId <= 0) {
      return { ok: false, message: 'roleId должен быть положительным числом' };
    }
    const key = `${departmentId}:${roleId}`;
    if (seen.has(key)) {
      return { ok: false, message: `Повторяющееся правило departmentId=${departmentId}, roleId=${roleId}` };
    }
    const visible = item.visible === undefined ? null : (item.visible as boolean | null);
    const enabled = item.enabled === undefined ? null : (item.enabled as boolean | null);
    if (visible !== null && typeof visible !== 'boolean') {
      return { ok: false, message: 'visible должен быть boolean или null' };
    }
    if (enabled !== null && typeof enabled !== 'boolean') {
      return { ok: false, message: 'enabled должен быть boolean или null' };
    }
    const pairValidation = validateVisibilityEnabledPair(visible, enabled, {
      visible: 'visible',
      enabled: 'enabled',
    });
    if (pairValidation) {
      return { ok: false, message: pairValidation };
    }
    seen.add(key);
    items.push({ departmentId, roleId, visible, enabled });
  }

  return { ok: true, items };
}

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

router.get(
  '/departments/:departmentId/access-catalog',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ departmentId: string }, {}, {}, { roleId?: string }>,
    res: express.Response
  ) => {
    try {
      const departmentId = Number(req.params.departmentId);
      const roleId = req.query.roleId ? Number(req.query.roleId) : null;
      if (Number.isNaN(departmentId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }
      if (req.query.roleId && Number.isNaN(roleId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID роли', ErrorCodes.VALIDATION_ERROR));
      }

      const department = await prisma.department.findUnique({
        where: { id: departmentId },
        select: { id: true, name: true },
      });
      if (!department) {
        return res
          .status(404)
          .json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }

      let role: { id: number; name: string; displayName: string | null } | null = null;
      if (roleId) {
        role = await prisma.role.findUnique({
          where: { id: roleId },
          select: { id: true, name: true, displayName: true },
        });
        if (!role) {
          return res
            .status(404)
            .json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
        }
      }

      const services = await prisma.service.findMany({
        orderBy: { id: 'asc' },
        include: {
          departmentAccess: {
            where: { departmentId },
            select: { id: true, departmentId: true, visible: true, enabled: true },
          },
          departmentRoleAccess: roleId
            ? {
                where: { departmentId, roleId },
                select: { id: true, departmentId: true, roleId: true, visible: true, enabled: true },
              }
            : false,
        },
      });

      return res.json(
        successResponse({
          department,
          role,
          services: services.map((service) => ({
            id: service.id,
            key: service.key,
            name: service.name,
            kind: service.kind,
            route: service.route,
            icon: service.icon,
            description: service.description,
            gradientStart: service.gradientStart,
            gradientEnd: service.gradientEnd,
            isActive: service.isActive,
            defaultVisible: service.defaultVisible,
            defaultEnabled: service.defaultEnabled,
            departmentRule: service.departmentAccess[0] ?? null,
            departmentRoleRule: roleId ? service.departmentRoleAccess[0] ?? null : null,
          })),
        })
      );
    } catch (error) {
      console.error('department access catalog error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения настроек доступа отдела', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/departments/:departmentId/access-catalog',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<
      { departmentId: string },
      {},
      {
        roleId?: number | null;
        rules?: Array<{ serviceId: number; visible?: boolean | null; enabled?: boolean | null }>;
      }
    >,
    res: express.Response
  ) => {
    try {
      const departmentId = Number(req.params.departmentId);
      const roleId = req.body.roleId == null ? null : Number(req.body.roleId);
      if (Number.isNaN(departmentId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }
      if (req.body.roleId != null && Number.isNaN(roleId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID роли', ErrorCodes.VALIDATION_ERROR));
      }

      const department = await prisma.department.findUnique({
        where: { id: departmentId },
        select: { id: true, name: true },
      });
      if (!department) {
        return res
          .status(404)
          .json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }

      let role: { id: number; name: string; displayName: string | null } | null = null;
      if (roleId) {
        role = await prisma.role.findUnique({
          where: { id: roleId },
          select: { id: true, name: true, displayName: true },
        });
        if (!role) {
          return res
            .status(404)
            .json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
        }
      }

      const normalizedRules = normalizeRuleItems(req.body.rules, 'serviceId');
      if (!normalizedRules.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedRules.message, ErrorCodes.VALIDATION_ERROR));
      }

      const serviceIds = normalizedRules.items.map((item) => item.id);
      if (serviceIds.length) {
        const servicesCount = await prisma.service.count({ where: { id: { in: serviceIds } } });
        if (servicesCount !== serviceIds.length) {
          return res
            .status(404)
            .json(errorResponse('Один или несколько сервисов не найдены', ErrorCodes.NOT_FOUND));
        }
      }

      const services = await prisma.$transaction(async (tx) => {
        if (roleId) {
          await tx.serviceDepartmentRoleAccess.deleteMany({ where: { departmentId, roleId } });
          if (normalizedRules.items.length) {
            await tx.serviceDepartmentRoleAccess.createMany({
              data: normalizedRules.items.map((item) => ({
                serviceId: item.id,
                departmentId,
                roleId,
                visible: item.visible,
                enabled: item.enabled,
              })),
            });
          }
        } else {
          await tx.serviceDepartmentAccess.deleteMany({ where: { departmentId } });
          if (normalizedRules.items.length) {
            await tx.serviceDepartmentAccess.createMany({
              data: normalizedRules.items.map((item) => ({
                serviceId: item.id,
                departmentId,
                visible: item.visible,
                enabled: item.enabled,
              })),
            });
          }
        }

        return tx.service.findMany({
          orderBy: { id: 'asc' },
          include: {
            departmentAccess: {
              where: { departmentId },
              select: { id: true, departmentId: true, visible: true, enabled: true },
            },
            departmentRoleAccess: roleId
              ? {
                  where: { departmentId, roleId },
                  select: { id: true, departmentId: true, roleId: true, visible: true, enabled: true },
                }
              : false,
          },
        });
      });

      return res.json(
        successResponse({
          department,
          role,
          services: services.map((service) => ({
            id: service.id,
            key: service.key,
            name: service.name,
            kind: service.kind,
            route: service.route,
            icon: service.icon,
            description: service.description,
            gradientStart: service.gradientStart,
            gradientEnd: service.gradientEnd,
            isActive: service.isActive,
            defaultVisible: service.defaultVisible,
            defaultEnabled: service.defaultEnabled,
            departmentRule: service.departmentAccess[0] ?? null,
            departmentRoleRule: roleId ? service.departmentRoleAccess[0] ?? null : null,
          })),
        })
      );
    } catch (error) {
      console.error('department access catalog save error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения настроек доступа отдела', ErrorCodes.INTERNAL_ERROR));
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
      const baseFlagsValidation = validateVisibilityEnabledPair(
        req.body.defaultVisible ?? true,
        req.body.defaultEnabled ?? true,
        { visible: 'defaultVisible', enabled: 'defaultEnabled' }
      );
      if (baseFlagsValidation) {
        return res
          .status(400)
          .json(errorResponse(baseFlagsValidation, ErrorCodes.VALIDATION_ERROR));
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
          include: SERVICE_ADMIN_INCLUDE,
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
      const nextVisible =
        Object.prototype.hasOwnProperty.call(req.body, 'defaultVisible')
          ? req.body.defaultVisible
          : undefined;
      const nextEnabled =
        Object.prototype.hasOwnProperty.call(req.body, 'defaultEnabled')
          ? req.body.defaultEnabled
          : undefined;
      if (nextVisible !== undefined || nextEnabled !== undefined) {
        const current = await prisma.service.findUnique({
          where: { id: serviceId },
          select: { defaultVisible: true, defaultEnabled: true },
        });
        if (!current) {
          return res
            .status(404)
            .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
        }
        const baseFlagsValidation = validateVisibilityEnabledPair(
          nextVisible === undefined ? current.defaultVisible : nextVisible,
          nextEnabled === undefined ? current.defaultEnabled : nextEnabled,
          { visible: 'defaultVisible', enabled: 'defaultEnabled' }
        );
        if (baseFlagsValidation) {
          return res
            .status(400)
            .json(errorResponse(baseFlagsValidation, ErrorCodes.VALIDATION_ERROR));
        }
      }
      const updated = await prisma.service.update({
        where: { id: serviceId },
        data: data as any,
      });
      const full = await prisma.service.findUnique({
        where: { id: updated.id },
        include: SERVICE_ADMIN_INCLUDE,
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
 * Полная замена правил доступа сервиса одним запросом.
 */
router.put(
  '/:serviceId/access-rules',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<
      { serviceId: string },
      {},
      {
        roleAccess?: Array<{ roleId: number; visible?: boolean | null; enabled?: boolean | null }>;
        departmentAccess?: Array<{ departmentId: number; visible?: boolean | null; enabled?: boolean | null }>;
        departmentRoleAccess?: Array<{
          departmentId: number;
          roleId: number;
          visible?: boolean | null;
          enabled?: boolean | null;
        }>;
        userAccess?: Array<{ userId: number; visible?: boolean | null; enabled?: boolean | null }>;
      }
    >,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }

      const normalizedRoleRules = normalizeRuleItems(req.body.roleAccess, 'roleId');
      if (!normalizedRoleRules.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedRoleRules.message, ErrorCodes.VALIDATION_ERROR));
      }
      const normalizedDepartmentRules = normalizeRuleItems(req.body.departmentAccess, 'departmentId');
      if (!normalizedDepartmentRules.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedDepartmentRules.message, ErrorCodes.VALIDATION_ERROR));
      }
      const normalizedDepartmentRoleRules = normalizeDepartmentRoleRuleItems(req.body.departmentRoleAccess);
      if (!normalizedDepartmentRoleRules.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedDepartmentRoleRules.message, ErrorCodes.VALIDATION_ERROR));
      }
      const normalizedUserRules = normalizeRuleItems(req.body.userAccess, 'userId');
      if (!normalizedUserRules.ok) {
        return res
          .status(400)
          .json(errorResponse(normalizedUserRules.message, ErrorCodes.VALIDATION_ERROR));
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId }, select: { id: true } });
      if (!service) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }

      const roleIds = normalizedRoleRules.items.map((item) => item.id);
      const departmentIds = normalizedDepartmentRules.items.map((item) => item.id);
      const departmentRoleIds = normalizedDepartmentRoleRules.items.map((item) => item.roleId);
      const departmentRoleDepartmentIds = normalizedDepartmentRoleRules.items.map((item) => item.departmentId);
      const userIds = normalizedUserRules.items.map((item) => item.id);

      if (roleIds.length) {
        const rolesCount = await prisma.role.count({ where: { id: { in: roleIds } } });
        if (rolesCount !== roleIds.length) {
          return res
            .status(404)
            .json(errorResponse('Одна или несколько ролей не найдены', ErrorCodes.NOT_FOUND));
        }
      }
      if (departmentIds.length) {
        const departmentsCount = await prisma.department.count({ where: { id: { in: departmentIds } } });
        if (departmentsCount !== departmentIds.length) {
          return res
            .status(404)
            .json(errorResponse('Один или несколько отделов не найдены', ErrorCodes.NOT_FOUND));
        }
      }
      if (departmentRoleIds.length) {
        const rolesCount = await prisma.role.count({ where: { id: { in: Array.from(new Set(departmentRoleIds)) } } });
        if (rolesCount !== Array.from(new Set(departmentRoleIds)).length) {
          return res
            .status(404)
            .json(errorResponse('Одна или несколько ролей не найдены', ErrorCodes.NOT_FOUND));
        }
      }
      if (departmentRoleDepartmentIds.length) {
        const departmentsCount = await prisma.department.count({
          where: { id: { in: Array.from(new Set(departmentRoleDepartmentIds)) } },
        });
        if (departmentsCount !== Array.from(new Set(departmentRoleDepartmentIds)).length) {
          return res
            .status(404)
            .json(errorResponse('Один или несколько отделов не найдены', ErrorCodes.NOT_FOUND));
        }
      }

      if (userIds.length) {
        const usersCount = await prisma.user.count({ where: { id: { in: userIds } } });
        if (usersCount !== userIds.length) {
          return res
            .status(404)
            .json(errorResponse('Один или несколько пользователей не найдены', ErrorCodes.NOT_FOUND));
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.serviceRoleAccess.deleteMany({ where: { serviceId } });
        await tx.serviceDepartmentAccess.deleteMany({ where: { serviceId } });
        await tx.serviceDepartmentRoleAccess.deleteMany({ where: { serviceId } });
        await tx.serviceUserAccess.deleteMany({ where: { serviceId } });

        if (normalizedRoleRules.items.length) {
          await tx.serviceRoleAccess.createMany({
            data: normalizedRoleRules.items.map((item) => ({
              serviceId,
              roleId: item.id,
              visible: item.visible,
              enabled: item.enabled,
            })),
          });
        }

        if (normalizedDepartmentRules.items.length) {
          await tx.serviceDepartmentAccess.createMany({
            data: normalizedDepartmentRules.items.map((item) => ({
              serviceId,
              departmentId: item.id,
              visible: item.visible,
              enabled: item.enabled,
            })),
          });
        }

        if (normalizedDepartmentRoleRules.items.length) {
          await tx.serviceDepartmentRoleAccess.createMany({
            data: normalizedDepartmentRoleRules.items.map((item) => ({
              serviceId,
              departmentId: item.departmentId,
              roleId: item.roleId,
              visible: item.visible,
              enabled: item.enabled,
            })),
          });
        }

        if (normalizedUserRules.items.length) {
          await tx.serviceUserAccess.createMany({
            data: normalizedUserRules.items.map((item) => ({
              serviceId,
              userId: item.id,
              visible: item.visible,
              enabled: item.enabled,
            })),
          });
        }

        return tx.service.findUnique({
          where: { id: serviceId },
          include: SERVICE_ADMIN_INCLUDE,
        });
      });

      return res.json(successResponse({ service: updated }));
    } catch (error) {
      console.error('service access-rules replace error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения правил доступа', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * Диагностика эффективного доступа конкретного пользователя к сервису.
 */
router.get(
  '/:serviceId/access-matrix',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<
      { serviceId: string },
      {},
      {},
      { page?: string; limit?: string; search?: string; roleId?: string; departmentId?: string }
    >,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }

      const result = await listServiceAccessMatrix({
        serviceId,
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        search: req.query.search ?? null,
        roleId: req.query.roleId ? Number(req.query.roleId) : null,
        departmentId: req.query.departmentId ? Number(req.query.departmentId) : null,
      });

      return res.json(
        successResponse(
          { items: result.items },
          'Success',
          { page: result.page, count: result.items.length, total: result.total }
        )
      );
    } catch (error: any) {
      if (error?.message === 'Service not found') {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      console.error('service access-matrix error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения матрицы доступа', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/:serviceId/access-preview',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ serviceId: string }, {}, {}, { userId?: string }>,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const userId = Number(req.query.userId);
      if (Number.isNaN(serviceId) || Number.isNaN(userId)) {
        return res
          .status(400)
          .json(errorResponse('serviceId и userId должны быть числами', ErrorCodes.VALIDATION_ERROR));
      }

      const explanation = await explainServiceAccessForUser(userId, { serviceId });
      if (!explanation) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }

      return res.json(successResponse({ explanation }));
    } catch (error: any) {
      if (error?.message === 'User not found') {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      console.error('service access-preview error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка диагностики доступа к сервису', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * Upsert правило по роли для сервиса
 */
router.put(
  '/:serviceId/user-access',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<{ serviceId: string }, {}, { userId?: number; visible?: boolean | null; enabled?: boolean | null }>,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const { userId, visible, enabled } = req.body;
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }
      if (!userId) {
        return res
          .status(400)
          .json(errorResponse('userId обязателен', ErrorCodes.VALIDATION_ERROR));
      }
      const rulePairValidation = validateVisibilityEnabledPair(visible, enabled, {
        visible: 'visible',
        enabled: 'enabled',
      });
      if (rulePairValidation) {
        return res
          .status(400)
          .json(errorResponse(rulePairValidation, ErrorCodes.VALIDATION_ERROR));
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) {
        return res
          .status(404)
          .json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
      if (!user) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const rule = await prisma.serviceUserAccess.upsert({
        where: { serviceId_userId: { serviceId, userId: Number(userId) } },
        update: { visible: visible ?? undefined, enabled: enabled ?? undefined },
        create: {
          serviceId,
          userId: Number(userId),
          visible: visible ?? null,
          enabled: enabled ?? null,
        },
      });

      return res.json(successResponse({ rule }));
    } catch (error) {
      console.error('service user-access error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения правила пользователя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.delete(
  '/:serviceId/user-access/:userId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (req: AuthRequest<{ serviceId: string; userId: string }>, res: express.Response) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const userId = Number(req.params.userId);
      if (Number.isNaN(serviceId) || Number.isNaN(userId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректные параметры', ErrorCodes.VALIDATION_ERROR));
      }

      await prisma.serviceUserAccess.delete({
        where: { serviceId_userId: { serviceId, userId } },
      });
      return res.json(successResponse({ message: 'deleted' }));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res
          .status(404)
          .json(errorResponse('Правило не найдено', ErrorCodes.NOT_FOUND));
      }
      console.error('service user-access delete error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления правила пользователя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/:serviceId/department-role-access',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (
    req: AuthRequest<
      { serviceId: string },
      {},
      { departmentId?: number; roleId?: number; visible?: boolean | null; enabled?: boolean | null }
    >,
    res: express.Response
  ) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const { departmentId, roleId, visible, enabled } = req.body;
      if (Number.isNaN(serviceId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID сервиса', ErrorCodes.VALIDATION_ERROR));
      }
      if (!departmentId || !roleId) {
        return res
          .status(400)
          .json(errorResponse('departmentId и roleId обязательны', ErrorCodes.VALIDATION_ERROR));
      }
      const rulePairValidation = validateVisibilityEnabledPair(visible, enabled, {
        visible: 'visible',
        enabled: 'enabled',
      });
      if (rulePairValidation) {
        return res
          .status(400)
          .json(errorResponse(rulePairValidation, ErrorCodes.VALIDATION_ERROR));
      }

      const [service, department, role] = await Promise.all([
        prisma.service.findUnique({ where: { id: serviceId }, select: { id: true } }),
        prisma.department.findUnique({ where: { id: Number(departmentId) }, select: { id: true } }),
        prisma.role.findUnique({ where: { id: Number(roleId) }, select: { id: true } }),
      ]);
      if (!service) {
        return res.status(404).json(errorResponse('Сервис не найден', ErrorCodes.NOT_FOUND));
      }
      if (!department) {
        return res.status(404).json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }
      if (!role) {
        return res.status(404).json(errorResponse('Роль не найдена', ErrorCodes.NOT_FOUND));
      }

      const rule = await prisma.serviceDepartmentRoleAccess.upsert({
        where: {
          serviceId_departmentId_roleId: {
            serviceId,
            departmentId: Number(departmentId),
            roleId: Number(roleId),
          },
        },
        update: { visible: visible ?? undefined, enabled: enabled ?? undefined },
        create: {
          serviceId,
          departmentId: Number(departmentId),
          roleId: Number(roleId),
          visible: visible ?? null,
          enabled: enabled ?? null,
        },
      });

      return res.json(successResponse({ rule }));
    } catch (error) {
      console.error('service department-role-access error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка сохранения правила отдела и роли', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.delete(
  '/:serviceId/department-role-access/:departmentId/:roleId',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_services'], { mode: 'any' }),
  async (req: AuthRequest<{ serviceId: string; departmentId: string; roleId: string }>, res: express.Response) => {
    try {
      const serviceId = Number(req.params.serviceId);
      const departmentId = Number(req.params.departmentId);
      const roleId = Number(req.params.roleId);
      if (Number.isNaN(serviceId) || Number.isNaN(departmentId) || Number.isNaN(roleId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректные параметры', ErrorCodes.VALIDATION_ERROR));
      }

      await prisma.serviceDepartmentRoleAccess.delete({
        where: { serviceId_departmentId_roleId: { serviceId, departmentId, roleId } },
      });
      return res.json(successResponse({ message: 'deleted' }));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res.status(404).json(errorResponse('Правило не найдено', ErrorCodes.NOT_FOUND));
      }
      console.error('service department-role-access delete error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления правила отдела и роли', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

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
      const rulePairValidation = validateVisibilityEnabledPair(visible, enabled, {
        visible: 'visible',
        enabled: 'enabled',
      });
      if (rulePairValidation) {
        return res
          .status(400)
          .json(errorResponse(rulePairValidation, ErrorCodes.VALIDATION_ERROR));
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
      const rulePairValidation = validateVisibilityEnabledPair(visible, enabled, {
        visible: 'visible',
        enabled: 'enabled',
      });
      if (rulePairValidation) {
        return res
          .status(400)
          .json(errorResponse(rulePairValidation, ErrorCodes.VALIDATION_ERROR));
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
