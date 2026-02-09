import express from 'express';
import prisma from '../prisma/client';
import { authenticateToken, authorizePermissions, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { errorResponse, successResponse, ErrorCodes } from '../utils/apiResponse';
import { resolveObjectUrl } from '../storage/minio';

const router = express.Router();

const userMiniSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  role: { select: { name: true } },
  departmentRoles: {
    select: {
      departmentId: true,
      role: { select: { name: true } },
    },
  },
  employeeProfile: {
    select: {
      avatarUrl: true,
      department: { select: { id: true, name: true } },
    },
  },
  clientProfile: { select: { avatarUrl: true } },
  supplierProfile: { select: { avatarUrl: true } },
} as const;

function isAdminRole(user: any) {
  return user?.role?.name === 'admin';
}

function isDepartmentManager(user: any, departmentId?: number | null) {
  if (!user || !departmentId) return false;
  return (user.departmentRoles || []).some(
    (dr: any) => dr.departmentId === departmentId && dr.role?.name === 'department_manager'
  );
}

async function mapUserMini(user: any) {
  if (!user) return null;
  const avatarKey =
    user.employeeProfile?.avatarUrl ??
    user.clientProfile?.avatarUrl ??
    user.supplierProfile?.avatarUrl ??
    user.avatarUrl ??
    null;
  const avatarUrl = await resolveObjectUrl(avatarKey ?? null);
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl,
    department: user.employeeProfile?.department ?? null,
    isAdmin: isAdminRole(user),
    isDepartmentManager: (user.departmentRoles || []).some(
      (dr: any) => dr.role?.name === 'department_manager'
    ),
  };
}

/**
 * @openapi
 * /departments/{departmentId}/members:
 *   get:
 *     tags: [Departments]
 *     summary: Список сотрудников отдела (для назначения)
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["assign_appeal"]
 */
router.get(
  '/:departmentId/members',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['assign_appeal'], { mode: 'any' }),
  async (req: AuthRequest<{ departmentId: string }>, res: express.Response) => {
    try {
      const departmentId = Number(req.params.departmentId);
      if (Number.isNaN(departmentId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный ID отдела', ErrorCodes.VALIDATION_ERROR));
      }

      const currentUser = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!currentUser) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const canView = isAdminRole(currentUser) || isDepartmentManager(currentUser, departmentId);
      if (!canView) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к списку сотрудников отдела', ErrorCodes.FORBIDDEN));
      }

      const users = await prisma.user.findMany({
        where: { employeeProfile: { departmentId } },
        select: userMiniSelect,
        orderBy: { id: 'asc' },
      });

      const mapped = await Promise.all(users.map((u) => mapUserMini(u)));

      return res.json(successResponse(mapped, 'Список сотрудников отдела'));
    } catch (error) {
      console.error('Ошибка получения сотрудников отдела:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения сотрудников отдела', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
