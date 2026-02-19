import express from 'express';
import { AppealStatus, Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import {
  ErrorCodes,
  errorResponse,
  successResponse,
  type ErrorResponse,
  type SuccessResponse,
} from '../utils/apiResponse';
import {
  listServicesForUser,
  resolveServiceAccessForUser,
  type ServiceAccessView,
} from '../services/serviceAccess';

type HomeResolvedMetricState = 'ready' | 'locked' | 'error';
type HomeMetricId =
  | 'open_appeals'
  | 'my_tasks'
  | 'daily_scans'
  | 'unread_messages'
  | 'urgent_deadlines';

type HomeMetricDto = {
  state: HomeResolvedMetricState;
  value: number | null;
  message?: string;
};

type HomeSeriesPoint = {
  ts: string;
  scans: number;
};

type HomeActivityItem = {
  id: string;
  appealId: number;
  number: number;
  title: string;
  subtitle: string;
  messagePreview: string;
  lastSenderName: string | null;
  unreadCount: number;
  assigneeCount: number;
  departmentName: string | null;
  deadline: Date | null;
  status: AppealStatus;
  priority: string;
  updatedAt: Date;
  route: string;
};

type HomeDashboardPayload = {
  dashboard: {
    metrics: Record<HomeMetricId, HomeMetricDto>;
    scansSeries: HomeSeriesPoint[];
    scansSeriesState: HomeResolvedMetricState;
    scansSeriesMessage?: string;
    activity: HomeActivityItem[];
    activityState: HomeResolvedMetricState;
    activityMessage?: string;
    lastUpdatedAt: string;
  };
  services: ServiceAccessView[];
};

type HomeDashboardResponse = SuccessResponse<HomeDashboardPayload> | ErrorResponse;

type DashboardPermissionContext = {
  departmentId: number | null;
  isAdmin: boolean;
  permissionNames: Set<string>;
};

const router = express.Router();

const ADMIN_ROLE_NAMES = new Set(['admin', 'administrator']);
const ACTIVE_APPEAL_STATUSES: AppealStatus[] = [
  AppealStatus.OPEN,
  AppealStatus.IN_PROGRESS,
  AppealStatus.RESOLVED,
];
const TASK_APPEAL_STATUSES: AppealStatus[] = [AppealStatus.IN_PROGRESS, AppealStatus.RESOLVED];
const HOME_ACTIVITY_LIMIT = 6;
const URGENT_DEADLINE_HOURS = 48;
const MS_IN_HOUR = 60 * 60 * 1000;
const MS_IN_DAY = 24 * MS_IN_HOUR;

function normalizeTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'UTC';
  const tz = raw.trim();
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function lockedMetric(message: string): HomeMetricDto {
  return { state: 'locked', value: null, message };
}

function errorMetric(message: string): HomeMetricDto {
  return { state: 'error', value: null, message };
}

function readyMetric(value: number): HomeMetricDto {
  return { state: 'ready', value };
}

function parseIntSafe(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function collectRoleChainIds(roleId: number | null | undefined): Promise<Set<number>> {
  const ids = new Set<number>();
  let current = roleId ?? null;

  while (current) {
    if (ids.has(current)) break;
    ids.add(current);
    const role = await prisma.role.findUnique({
      where: { id: current },
      select: { parentRoleId: true },
    });
    current = role?.parentRoleId ?? null;
  }

  return ids;
}

async function resolvePermissionContext(userId: number): Promise<DashboardPermissionContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roleId: true,
      role: { select: { name: true } },
      employeeProfile: { select: { departmentId: true } },
      departmentRoles: { select: { roleId: true } },
    },
  });
  if (!user) throw new Error('User not found');

  const seedRoleIds = new Set<number>();
  if (user.roleId) seedRoleIds.add(user.roleId);
  for (const departmentRole of user.departmentRoles) {
    if (departmentRole.roleId) seedRoleIds.add(departmentRole.roleId);
  }

  const roleIds = new Set<number>();
  for (const roleId of seedRoleIds) {
    const chain = await collectRoleChainIds(roleId);
    chain.forEach((id) => roleIds.add(id));
  }

  const roleIdList = Array.from(roleIds);
  const roleRows = roleIdList.length
    ? await prisma.role.findMany({
        where: { id: { in: roleIdList } },
        select: { name: true },
      })
    : [];
  const roleNames = new Set<string>(roleRows.map((role) => role.name).filter(Boolean));
  if (user.role?.name) roleNames.add(user.role.name);
  const isAdmin = Array.from(roleNames).some((name) => ADMIN_ROLE_NAMES.has(name));

  const permissionNames = new Set<string>();
  if (!isAdmin && roleIdList.length) {
    const rolePermissions = await prisma.rolePermissions.findMany({
      where: { roleId: { in: roleIdList } },
      select: { permission: { select: { name: true } } },
    });
    rolePermissions.forEach((row) => permissionNames.add(row.permission.name));
  }

  return {
    departmentId: user.employeeProfile?.departmentId ?? null,
    isAdmin,
    permissionNames,
  };
}

function hasPermission(context: DashboardPermissionContext, permissionName: string): boolean {
  return context.isAdmin || context.permissionNames.has(permissionName);
}

type ServiceAccessDecision = Awaited<ReturnType<typeof resolveServiceAccessForUser>>;

function resolveAccessDenyReason(
  serviceAccess: ServiceAccessDecision,
  permissionGranted: boolean
): string | null {
  if (!serviceAccess) return 'Сервис не найден';
  if (!serviceAccess.isEmployee) return 'Сервисы доступны только сотрудникам';
  if (!serviceAccess.visible || !serviceAccess.enabled) return 'Доступ к сервису запрещён';
  if (!permissionGranted) return 'Недостаточно прав доступа';
  return null;
}

async function fetchOpenAppealsCount(userId: number, departmentId: number | null): Promise<number> {
  if (departmentId) {
    return prisma.appeal.count({
      where: { toDepartmentId: departmentId, status: AppealStatus.OPEN },
    });
  }
  return prisma.appeal.count({
    where: { createdById: userId, status: AppealStatus.OPEN },
  });
}

async function fetchMyTasksCount(userId: number): Promise<number> {
  return prisma.appeal.count({
    where: {
      assignees: { some: { userId } },
      status: { in: TASK_APPEAL_STATUSES },
    },
  });
}

async function fetchUnreadMessagesCount(userId: number): Promise<number> {
  return prisma.appealMessage.count({
    where: {
      deleted: false,
      senderId: { not: userId },
      reads: { none: { userId } },
      appeal: { createdById: userId },
    },
  });
}

async function fetchUrgentDeadlinesCount(userId: number): Promise<number> {
  const threshold = new Date(Date.now() + URGENT_DEADLINE_HOURS * MS_IN_HOUR);
  return prisma.appeal.count({
    where: {
      assignees: { some: { userId } },
      status: { in: ACTIVE_APPEAL_STATUSES },
      deadline: { lte: threshold },
    },
  });
}

async function fetchActivityItems(userId: number, departmentId: number | null): Promise<HomeActivityItem[]> {
  const where: Prisma.AppealWhereInput = departmentId
    ? { toDepartmentId: departmentId }
    : { createdById: userId };

  const appeals = await prisma.appeal.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: HOME_ACTIVITY_LIMIT,
    select: {
      id: true,
      number: true,
      title: true,
      priority: true,
      status: true,
      deadline: true,
      createdAt: true,
      toDepartment: { select: { name: true } },
      assignees: { select: { userId: true } },
      messages: {
        where: { deleted: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: {
          createdAt: true,
          text: true,
          sender: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          attachments: {
            select: { id: true },
            take: 1,
          },
        },
      },
      _count: {
        select: {
          messages: {
            where: {
              deleted: false,
              senderId: { not: userId },
              reads: { none: { userId } },
            },
          },
        },
      },
    },
  });

  return appeals.map((appeal) => {
    const lastMessage = appeal.messages[0] ?? null;
    const messageText = String(lastMessage?.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const senderName = lastMessage?.sender
      ? [lastMessage.sender.firstName, lastMessage.sender.lastName].filter(Boolean).join(' ').trim() ||
        lastMessage.sender.email ||
        null
      : null;
    const messagePreview = messageText
      ? messageText
      : lastMessage?.attachments?.length
      ? 'Добавлено вложение'
      : 'Без комментариев';
    const title = appeal.title?.trim() || `Обращение #${appeal.number}`;

    return {
      id: `appeal-${appeal.id}`,
      appealId: appeal.id,
      number: appeal.number,
      title,
      subtitle: messageText ? messageText : `Приоритет: ${appeal.priority.toLowerCase()}`,
      messagePreview,
      lastSenderName: senderName,
      unreadCount: Math.max(0, appeal._count.messages),
      assigneeCount: appeal.assignees.length,
      departmentName: appeal.toDepartment?.name || null,
      deadline: appeal.deadline,
      status: appeal.status,
      priority: appeal.priority,
      updatedAt: lastMessage?.createdAt || appeal.createdAt,
      route: `/services/appeals/${appeal.id}`,
    };
  });
}

async function fetchDailyScansCount(userId: number): Promise<number> {
  const to = new Date();
  const from = new Date(to.getTime() - MS_IN_DAY);
  return prisma.qRAnalytic.count({
    where: {
      createdAt: { gte: from, lte: to },
      qrList: { createdById: userId },
    },
  });
}

async function fetchScansSeries(userId: number, tz: string): Promise<HomeSeriesPoint[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * MS_IN_DAY);

  const rows = await prisma.$queryRaw<Array<{ ts: Date | string; scans: bigint | number | string }>>(
    Prisma.sql`
      SELECT date_trunc('day', timezone(${tz}, a."createdAt")) AS ts,
             COUNT(*)::bigint AS scans
      FROM "QRAnalytic" a
      JOIN "QRList" q ON q."id" = a."qrListId"
      WHERE q."createdById" = ${userId}
        AND a."createdAt" BETWEEN ${from} AND ${to}
      GROUP BY 1
      ORDER BY 1
    `
  );

  return rows
    .map((row) => {
      const tsDate = row.ts instanceof Date ? row.ts : new Date(String(row.ts));
      if (Number.isNaN(tsDate.getTime())) return null;
      return {
        ts: tsDate.toISOString(),
        scans: parseIntSafe(row.scans),
      };
    })
    .filter((point): point is HomeSeriesPoint => point !== null)
    .slice(-7);
}

/**
 * @openapi
 * /home/dashboard:
 *   get:
 *     tags: [Home]
 *     summary: Bundle данных главной страницы
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bundle успешно получен
 */
router.get(
  '/dashboard',
  authenticateToken,
  checkUserStatus,
  async (
    req: AuthRequest<{}, HomeDashboardResponse, {}, { tz?: string }>,
    res: express.Response<HomeDashboardResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const tz = normalizeTimeZone(req.query?.tz);
      const [permissionContext, servicesResult, appealsAccess, qrAccess] = await Promise.all([
        resolvePermissionContext(userId),
        listServicesForUser(userId),
        resolveServiceAccessForUser(userId, 'appeals'),
        resolveServiceAccessForUser(userId, 'qrcodes'),
      ]);

      const appealsDenyReason = resolveAccessDenyReason(
        appealsAccess,
        hasPermission(permissionContext, 'view_appeal')
      );
      const qrDenyReason = resolveAccessDenyReason(
        qrAccess,
        hasPermission(permissionContext, 'view_qr_analytics')
      );

      const metrics: Record<HomeMetricId, HomeMetricDto> = {
        open_appeals: appealsDenyReason
          ? lockedMetric(appealsDenyReason)
          : errorMetric('Не удалось получить данные'),
        my_tasks: appealsDenyReason
          ? lockedMetric(appealsDenyReason)
          : errorMetric('Не удалось получить данные'),
        daily_scans: qrDenyReason
          ? lockedMetric(qrDenyReason)
          : errorMetric('Не удалось получить данные'),
        unread_messages: appealsDenyReason
          ? lockedMetric(appealsDenyReason)
          : errorMetric('Не удалось получить данные'),
        urgent_deadlines: appealsDenyReason
          ? lockedMetric(appealsDenyReason)
          : errorMetric('Не удалось получить данные'),
      };

      let activity: HomeActivityItem[] = [];
      let activityState: HomeResolvedMetricState = appealsDenyReason ? 'locked' : 'error';
      let activityMessage: string | undefined =
        appealsDenyReason || 'Не удалось получить данные';
      let scansSeries: HomeSeriesPoint[] = [];
      let scansSeriesState: HomeResolvedMetricState = qrDenyReason ? 'locked' : 'error';
      let scansSeriesMessage: string | undefined =
        qrDenyReason || 'Не удалось получить данные';

      if (!appealsDenyReason) {
        try {
          const [openAppeals, myTasks, unreadMessages, urgentDeadlines, activityItems] = await Promise.all([
            fetchOpenAppealsCount(userId, permissionContext.departmentId),
            fetchMyTasksCount(userId),
            fetchUnreadMessagesCount(userId),
            fetchUrgentDeadlinesCount(userId),
            fetchActivityItems(userId, permissionContext.departmentId),
          ]);
          metrics.open_appeals = readyMetric(openAppeals);
          metrics.my_tasks = readyMetric(myTasks);
          metrics.unread_messages = readyMetric(unreadMessages);
          metrics.urgent_deadlines = readyMetric(urgentDeadlines);
          activity = activityItems;
          activityState = 'ready';
          activityMessage = undefined;
        } catch (error) {
          console.error('[home/dashboard] appeals bundle error:', error);
          metrics.open_appeals = errorMetric('Не удалось получить данные обращений');
          metrics.my_tasks = errorMetric('Не удалось получить данные обращений');
          metrics.unread_messages = errorMetric('Не удалось получить данные обращений');
          metrics.urgent_deadlines = errorMetric('Не удалось получить данные обращений');
          activity = [];
          activityState = 'error';
          activityMessage = 'Не удалось получить ленту активности';
        }
      }

      if (!qrDenyReason) {
        try {
          const [dailyScans, series] = await Promise.all([
            fetchDailyScansCount(userId),
            fetchScansSeries(userId, tz),
          ]);
          metrics.daily_scans = readyMetric(dailyScans);
          scansSeries = series;
          scansSeriesState = 'ready';
          scansSeriesMessage = undefined;
        } catch (error) {
          console.error('[home/dashboard] qr bundle error:', error);
          metrics.daily_scans = errorMetric('Не удалось получить данные сканов');
          scansSeries = [];
          scansSeriesState = 'error';
          scansSeriesMessage = 'Не удалось получить динамику сканов';
        }
      }

      const services = servicesResult.services;
      const payload: HomeDashboardPayload = {
        dashboard: {
          metrics,
          scansSeries,
          scansSeriesState,
          ...(scansSeriesMessage ? { scansSeriesMessage } : {}),
          activity,
          activityState,
          ...(activityMessage ? { activityMessage } : {}),
          lastUpdatedAt: new Date().toISOString(),
        },
        services,
      };

      res.set('Cache-Control', 'no-store');
      return res.json(successResponse(payload, 'Данные главной страницы'));
    } catch (error) {
      console.error('[home/dashboard] error:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения данных главной страницы', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
