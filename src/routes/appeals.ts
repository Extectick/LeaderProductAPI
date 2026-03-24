// src/routes/appeals.ts
import express from 'express';

import multer from 'multer';
import { Parser } from 'json2csv';
import {
  Prisma,
  AppealStatus,
  AppealPriority,
  AttachmentType,
  AppealMessageType,
  AppealLaborPaymentStatus,
} from '@prisma/client';
import prisma from '../prisma/client';
import { z } from 'zod';

import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { checkUserStatus } from '../middleware/checkUserStatus';
import {
  successResponse,
  errorResponse,
  ErrorCodes,
} from '../utils/apiResponse';

import {
  AppealCreateResponse,
  AppealListResponse,
  AppealCountersResponse,
  AppealDetailResponse,
  AppealAssignResponse,
  AppealStatusUpdateResponse,
  AppealDeadlineUpdateResponse,
  AppealAddMessageResponse,
  AppealMessagesResponse,
  AppealReadBulkResponse,
  AppealWatchersUpdateResponse,
  AppealDeleteMessageResponse,
  AppealEditMessageResponse,
  AppealClaimResponse,
  AppealDepartmentChangeResponse,
  AppealsAnalyticsMetaResponse,
  AppealsAnalyticsAppealsResponse,
  AppealsAnalyticsUsersResponse,
  AppealsAnalyticsUserAppealsResponse,
  AppealLaborUpsertResponse,
  AppealsSlaDashboardResponse,
  AppealsKpiDashboardResponse,
  AppealsPaymentQueueResponse,
  AppealsPaymentQueueMarkPaidResponse,
  AppealLaborAuditLogResponse,
  AppealsFunnelResponse,
  AppealsHeatmapResponse,
  AppealsForecastResponse,
  AppealsAnalyticsUpdateHourlyRateResponse,
} from '../types/appealTypes';

import { Server as SocketIOServer } from 'socket.io';

// Схемы валидации
import {
  CreateAppealBodySchema,
  CreateAppealBody,
  ListQuerySchema,
  MessagesQuerySchema,
  IdParamSchema,
  MessageIdParamSchema,
  AssignBodySchema,
  StatusBodySchema,
  DeadlineBodySchema,
  ChangeDepartmentBodySchema,
  AddMessageBodySchema,
  ReadBulkBodySchema,
  WatchersBodySchema,
  EditMessageBodySchema,
  ExportQuerySchema,
  AnalyticsAppealsQuerySchema,
  AnalyticsUsersQuerySchema,
  AnalyticsKpiDashboardQuerySchema,
  AppealLaborUpsertBodySchema,
  AnalyticsCommonQuerySchema,
  LaborAuditQuerySchema,
  PaymentQueueMarkPaidBodySchema,
  ForecastQuerySchema,
  AnalyticsExportQuerySchema,
  UserHourlyRateBodySchema,
} from '../validation/appeals.schema';

// === импорт облачного хранилища (MinIO / S3-совместимое) ===
import { resolveObjectUrl, uploadMulterFile } from '../storage/minio';
import { cacheGet, cacheSet, cacheDel, cacheDelPrefix } from '../utils/cache';
import { randomUUID } from 'node:crypto';
import { dispatchNotification } from '../services/notificationService';
import {
  scheduleUnreadReminder,
  scheduleClosureReminder,
  cancelAppealJobs,
} from '../services/scheduledJobsService';
import {
  tplNewAppeal,
  tplStatusChanged,
  tplDeadlineChanged,
  tplNewMessage,
  tplAssigneeAssigned,
  tplAssigneeRemoved,
  tplTransferRemovedAssignee,
  tplTransferAuthor,
  tplTransferToDepartment,
} from '../services/notificationTemplates';

// минимальный интерфейс БД, который есть и у PrismaClient, и у TransactionClient
type HasAppealAttachment = {
  appealAttachment: Prisma.AppealAttachmentDelegate<any>;
};

const userMiniSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  currentProfileType: true,
  role: { select: { id: true, name: true } },
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

type UserMiniRaw = Prisma.UserGetPayload<{ select: typeof userMiniSelect }>;

type MessageWithRelations = Prisma.AppealMessageGetPayload<{
  include: {
    attachments: true;
    reads: { select: { userId: true; readAt: true } };
    sender: { select: typeof userMiniSelect };
  };
}>;

const STATUS_LABELS: Record<AppealStatus, string> = {
  OPEN: 'Открыто',
  IN_PROGRESS: 'В работе',
  RESOLVED: 'Ожидание подтверждения',
  COMPLETED: 'Завершено',
  DECLINED: 'Отклонено',
};
const ACTIVE_APPEAL_STATUSES: AppealStatus[] = [
  AppealStatus.OPEN,
  AppealStatus.IN_PROGRESS,
  AppealStatus.RESOLVED,
];

type AnalyticsPaymentState = 'PAID' | 'UNPAID' | 'UNSET' | 'NOT_REQUIRED';
type AnalyticsExportColumnKey =
  | 'number'
  | 'title'
  | 'createdBy'
  | 'status'
  | 'department'
  | 'departmentRoute'
  | 'deadline'
  | 'slaOpen'
  | 'slaWork'
  | 'slaToTake'
  | 'slaToResolve'
  | 'assignees'
  | 'hoursAccrued'
  | 'hoursPaid'
  | 'hoursRemaining'
  | 'hourlyRate'
  | 'amountAccrued'
  | 'amountPaid'
  | 'amountRemaining';

const ANALYTICS_EXPORT_COLUMN_ORDER: AnalyticsExportColumnKey[] = [
  'number',
  'title',
  'createdBy',
  'status',
  'department',
  'departmentRoute',
  'deadline',
  'slaOpen',
  'slaWork',
  'slaToTake',
  'slaToResolve',
  'assignees',
  'hoursAccrued',
  'hoursPaid',
  'hoursRemaining',
  'hourlyRate',
  'amountAccrued',
  'amountPaid',
  'amountRemaining',
];

const ANALYTICS_EXPORT_COLUMN_HEADERS: Record<AnalyticsExportColumnKey, string> = {
  number: '№',
  title: 'Обращение',
  createdBy: 'Создал',
  status: 'Статус',
  department: 'Отдел',
  departmentRoute: 'Маршрут отдела',
  deadline: 'Дедлайн',
  slaOpen: 'Открыто',
  slaWork: 'В работе',
  slaToTake: 'До взятия',
  slaToResolve: 'До решения',
  assignees: 'Исполнители',
  hoursAccrued: 'Часы начислено',
  hoursPaid: 'Часы оплачено',
  hoursRemaining: 'Часы остаток',
  hourlyRate: 'Ставка ₽/ч',
  amountAccrued: 'Сумма начислено',
  amountPaid: 'Сумма оплачено',
  amountRemaining: 'Сумма к доплате',
};

type ExportCellValue = string | number | null;
type ExportColumnFormat = 'text' | 'number' | 'currency';

const APPEALS_EXPORT_COLUMN_FORMATS: Record<AnalyticsExportColumnKey, ExportColumnFormat> = {
  number: 'text',
  title: 'text',
  createdBy: 'text',
  status: 'text',
  department: 'text',
  departmentRoute: 'text',
  deadline: 'text',
  slaOpen: 'number',
  slaWork: 'number',
  slaToTake: 'number',
  slaToResolve: 'number',
  assignees: 'text',
  hoursAccrued: 'number',
  hoursPaid: 'number',
  hoursRemaining: 'number',
  hourlyRate: 'text',
  amountAccrued: 'currency',
  amountPaid: 'currency',
  amountRemaining: 'currency',
};

const USERS_EXPORT_COLUMN_FORMATS: Record<string, ExportColumnFormat> = {
  userId: 'text',
  user: 'text',
  department: 'text',
  appealNumber: 'text',
  hours: 'number',
  paymentStatus: 'text',
};

function getUserDisplayName(user: UserMiniRaw | null) {
  if (!user) return 'Пользователь';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || 'Пользователь';
}

function isAdminRole(user: UserMiniRaw | null) {
  const roleName = String(user?.role?.name || '').toLowerCase();
  return roleName === 'admin' || roleName === 'administrator';
}

function isDepartmentManager(user: UserMiniRaw | null, departmentId?: number | null) {
  if (!user) return false;
  const hasDepartmentRole = (user.departmentRoles || []).some((dr) => {
    if (dr.role?.name !== 'department_manager') return false;
    if (!departmentId) return true;
    return dr.departmentId === departmentId;
  });
  if (hasDepartmentRole) return true;

  // Fallback: в некоторых профилях manager задается как глобальная роль пользователя.
  if (user.role?.name !== 'department_manager') return false;
  if (!departmentId) return true;
  return user.employeeProfile?.department?.id === departmentId;
}

async function mapUserMini(user: UserMiniRaw | null) {
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
    isDepartmentManager: isDepartmentManager(user),
  };
}

function toRoleFlags(user: UserMiniRaw | null) {
  return {
    isAdmin: isAdminRole(user),
    isDepartmentManager: isDepartmentManager(user),
  };
}

async function getManagedDepartmentIds(user: UserMiniRaw | null) {
  if (!user) return [];
  if (isAdminRole(user)) {
    const all = await prisma.department.findMany({ select: { id: true } });
    return all.map((d) => d.id);
  }
  const managed = new Set<number>();
  for (const dr of user.departmentRoles || []) {
    if (dr.role?.name === 'department_manager') managed.add(dr.departmentId);
  }
  if (user.role?.name === 'department_manager' && user.employeeProfile?.department?.id) {
    managed.add(user.employeeProfile.department.id);
  }
  return Array.from(managed);
}

type SlaMetrics = {
  openDurationMs: number;
  workDurationMs: number;
  timeToFirstInProgressMs: number | null;
  timeToFirstResolvedMs: number | null;
};

function calculateAppealSla(
  appealCreatedAt: Date,
  currentStatus: AppealStatus,
  history: Array<{ oldStatus: AppealStatus; newStatus: AppealStatus; changedAt: Date }>,
  now: Date
): SlaMetrics {
  const sorted = [...history].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
  const points: Array<{ status: AppealStatus; start: Date; end: Date }> = [];

  let cursorStatus: AppealStatus = AppealStatus.OPEN;
  let cursorStart = appealCreatedAt;
  for (const h of sorted) {
    points.push({ status: cursorStatus, start: cursorStart, end: h.changedAt });
    cursorStatus = h.newStatus;
    cursorStart = h.changedAt;
  }
  points.push({ status: cursorStatus ?? currentStatus, start: cursorStart, end: now });

  const sumByStatus = (status: AppealStatus) =>
    points
      .filter((p) => p.status === status)
      .reduce((acc, p) => acc + Math.max(0, p.end.getTime() - p.start.getTime()), 0);

  const firstInProgress = sorted.find((h) => h.newStatus === AppealStatus.IN_PROGRESS);
  const firstResolved = sorted.find((h) => h.newStatus === AppealStatus.RESOLVED);

  return {
    openDurationMs: sumByStatus(AppealStatus.OPEN),
    workDurationMs: sumByStatus(AppealStatus.IN_PROGRESS),
    timeToFirstInProgressMs: firstInProgress
      ? Math.max(0, firstInProgress.changedAt.getTime() - appealCreatedAt.getTime())
      : null,
    timeToFirstResolvedMs: firstResolved
      ? Math.max(0, firstResolved.changedAt.getTime() - appealCreatedAt.getTime())
      : null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Number(Number.isFinite(value) ? value.toFixed(2) : '0');
}

function normalizeHourValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, round2(value));
}

function resolveEffectiveHourlyRate(params: {
  departmentPaymentRequired: boolean;
  departmentHourlyRate: number;
  assigneeHourlyRate?: number | null;
}): number {
  if (!params.departmentPaymentRequired) return 0;
  const candidate =
    params.assigneeHourlyRate == null
      ? params.departmentHourlyRate
      : Number(params.assigneeHourlyRate);
  if (!Number.isFinite(candidate) || candidate <= 0) return 0;
  return round2(candidate);
}

function deriveLaborPaymentStatus(params: {
  payable: boolean;
  accruedHours: number;
  paidHours: number;
}): AppealLaborPaymentStatus {
  const accrued = normalizeHourValue(params.accruedHours);
  const paid = normalizeHourValue(params.paidHours);
  if (!params.payable) return AppealLaborPaymentStatus.NOT_REQUIRED;
  if (accrued <= 0 || paid <= 0) return AppealLaborPaymentStatus.UNPAID;
  if (paid < accrued) return AppealLaborPaymentStatus.PARTIAL;
  return AppealLaborPaymentStatus.PAID;
}

function resolveLegacyPaidHours(params: {
  accruedHours: number;
  paymentStatus?: AppealLaborPaymentStatus;
  previousPaidHours?: number | null;
}): number {
  const accrued = normalizeHourValue(params.accruedHours);
  if (params.paymentStatus === AppealLaborPaymentStatus.PAID) return accrued;
  if (params.paymentStatus === AppealLaborPaymentStatus.UNPAID) return 0;
  if (params.paymentStatus === AppealLaborPaymentStatus.NOT_REQUIRED) return 0;
  if (params.paymentStatus === AppealLaborPaymentStatus.PARTIAL) {
    const prev = normalizeHourValue(Number(params.previousPaidHours || 0));
    return Math.min(prev, accrued);
  }
  const fallback = normalizeHourValue(Number(params.previousPaidHours || 0));
  return Math.min(fallback, accrued);
}

function mapLaborEntryDto(entry: any, params: {
  departmentPaymentRequired: boolean;
  departmentHourlyRate: number;
  appealLaborNotRequired?: boolean;
}) {
  const accruedHours = normalizeHourValue(Number(entry.hours || 0));
  const rawPaidHours = normalizeHourValue(Number(entry.paidHours ?? 0));
  const assigneeHourlyRate = entry.assignee?.employeeProfile?.appealLaborHourlyRate == null
    ? null
    : Number(entry.assignee.employeeProfile.appealLaborHourlyRate);
  const snapshotRateRaw = Number(entry.effectiveHourlyRateRub);
  const hasSnapshotRate = Number.isFinite(snapshotRateRaw);
  const effectiveHourlyRateRub = params.appealLaborNotRequired
    ? 0
    : hasSnapshotRate
      ? Math.max(0, round2(snapshotRateRaw))
      : resolveEffectiveHourlyRate({
          departmentPaymentRequired: params.departmentPaymentRequired,
          departmentHourlyRate: params.departmentHourlyRate,
          assigneeHourlyRate,
        });
  const payable = !params.appealLaborNotRequired && effectiveHourlyRateRub > 0;
  const paidHours = payable ? Math.min(rawPaidHours, accruedHours) : 0;
  const remainingHours = Math.max(0, round2(accruedHours - paidHours));
  const paymentStatus = params.appealLaborNotRequired
    ? AppealLaborPaymentStatus.NOT_REQUIRED
    : deriveLaborPaymentStatus({
        payable,
        accruedHours,
        paidHours,
      });
  return {
    assigneeUserId: entry.assigneeUserId,
    accruedHours,
    paidHours,
    remainingHours,
    payable,
    hourlyRateRub: assigneeHourlyRate == null ? null : round2(assigneeHourlyRate),
    effectiveHourlyRateRub,
    amountAccruedRub: round2(accruedHours * effectiveHourlyRateRub),
    amountPaidRub: round2(paidHours * effectiveHourlyRateRub),
    amountRemainingRub: round2(remainingHours * effectiveHourlyRateRub),
    hours: accruedHours,
    paymentStatus,
    paidAt: paymentStatus === AppealLaborPaymentStatus.PAID ? entry.paidAt : null,
    paidBy:
      paymentStatus === AppealLaborPaymentStatus.PAID && entry.paidBy
        ? {
            id: entry.paidBy.id,
            email: entry.paidBy.email,
            firstName: entry.paidBy.firstName,
            lastName: entry.paidBy.lastName,
          }
        : null,
    assignee: {
      id: entry.assignee.id,
      email: entry.assignee.email,
      firstName: entry.assignee.firstName,
      lastName: entry.assignee.lastName,
    },
    updatedAt: entry.updatedAt,
  };
}

function resolveFinancialFunnelStatus(params: {
  paymentRequired: boolean;
  laborNotRequired: boolean;
  statuses: AppealLaborPaymentStatus[];
}) {
  if (
    params.laborNotRequired ||
    !params.paymentRequired ||
    (params.statuses.length > 0 && params.statuses.every((s) => s === AppealLaborPaymentStatus.NOT_REQUIRED))
  ) {
    return 'NOT_PAYABLE' as const;
  }
  if (!params.statuses.length) return 'TO_PAY' as const;
  const paidCount = params.statuses.filter((s) => s === AppealLaborPaymentStatus.PAID).length;
  const partialCount = params.statuses.filter((s) => s === AppealLaborPaymentStatus.PARTIAL).length;
  const unpaidCount = params.statuses.filter((s) => s === AppealLaborPaymentStatus.UNPAID).length;
  if (partialCount > 0) return 'PARTIAL' as const;
  if (paidCount > 0 && unpaidCount === 0) return 'PAID' as const;
  if (paidCount > 0 && unpaidCount > 0) return 'PARTIAL' as const;
  return 'TO_PAY' as const;
}

function resolveStatusMatchesFromSearch(search: string): AppealStatus[] {
  const normalized = String(search || '').trim().toLowerCase();
  if (!normalized) return [];
  return (Object.entries(STATUS_LABELS) as Array<[AppealStatus, string]>)
    .filter(([code, label]) => code.toLowerCase().includes(normalized) || label.toLowerCase().includes(normalized))
    .map(([code]) => code);
}

function buildAnalyticsAppealsWhere(params: {
  roleFlags: { isAdmin: boolean; isDepartmentManager: boolean };
  managedDepartmentIds: number[];
  departmentId?: number;
  fromDate?: string;
  toDate?: string;
  assigneeUserId?: number;
  status?: AppealStatus;
  paymentState?: AnalyticsPaymentState;
  search?: string;
}): Prisma.AppealWhereInput {
  const {
    roleFlags,
    managedDepartmentIds,
    departmentId,
    fromDate,
    toDate,
    assigneeUserId,
    status,
    paymentState,
    search,
  } = params;
  const where: Prisma.AppealWhereInput = {
    toDepartmentId: roleFlags.isAdmin
      ? (departmentId ? departmentId : undefined)
      : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
  };

  if (status) where.status = status;
  if (paymentState === 'UNPAID') {
    where.laborEntries = {
      some: {
        hours: { gt: 0 },
        paymentStatus: { in: [AppealLaborPaymentStatus.UNPAID, AppealLaborPaymentStatus.PARTIAL] },
      },
    };
  } else if (paymentState === 'PAID') {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [
      ...existingAnd,
      {
        laborEntries: {
          some: {
            hours: { gt: 0 },
            paymentStatus: AppealLaborPaymentStatus.PAID,
          },
        },
      },
      {
        NOT: {
          laborEntries: {
            some: {
              hours: { gt: 0 },
              paymentStatus: { in: [AppealLaborPaymentStatus.UNPAID, AppealLaborPaymentStatus.PARTIAL] },
            },
          },
        },
      },
    ];
  } else if (paymentState === 'NOT_REQUIRED') {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [
      ...existingAnd,
      {
        OR: [
          { laborNotRequired: true },
          {
            AND: [
              { laborEntries: { some: { paymentStatus: AppealLaborPaymentStatus.NOT_REQUIRED } } },
              {
                NOT: {
                  laborEntries: {
                    some: {
                      paymentStatus: {
                        in: [
                          AppealLaborPaymentStatus.PAID,
                          AppealLaborPaymentStatus.UNPAID,
                          AppealLaborPaymentStatus.PARTIAL,
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    ];
  } else if (paymentState === 'UNSET') {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [
      ...existingAnd,
      { laborNotRequired: false },
      {
        NOT: {
          laborEntries: {
            some: {
              paymentStatus: {
                in: [
                  AppealLaborPaymentStatus.PAID,
                  AppealLaborPaymentStatus.UNPAID,
                  AppealLaborPaymentStatus.PARTIAL,
                  AppealLaborPaymentStatus.NOT_REQUIRED,
                ],
              },
            },
          },
        },
      },
    ];
  }
  if (assigneeUserId) {
    where.assignees = { some: { userId: assigneeUserId } };
  }
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = new Date(fromDate);
    if (toDate) where.createdAt.lte = new Date(toDate);
  }
  if (search) {
    const searchNumber = Number(search);
    const statusMatches = resolveStatusMatchesFromSearch(search);
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { fromDepartment: { name: { contains: search, mode: 'insensitive' } } },
      { toDepartment: { name: { contains: search, mode: 'insensitive' } } },
      {
        createdBy: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
      },
      {
        assignees: {
          some: {
            user: {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            },
          },
        },
      },
      ...((Number.isInteger(searchNumber) && searchNumber > 0) ? [{ number: searchNumber }] : []),
      ...(statusMatches.length ? [{ status: { in: statusMatches } }] : []),
    ];
  }
  return where;
}

function computeAnalyticsAllowedStatuses(params: {
  currentStatus: AppealStatus;
  isAdmin: boolean;
  isManager: boolean;
  isCreator: boolean;
  isAssignee: boolean;
}): AppealStatus[] {
  const { currentStatus, isAdmin, isManager, isCreator, isAssignee } = params;
  const set = new Set<AppealStatus>();
  if (isAdmin || isManager) {
    set.add(AppealStatus.OPEN);
    set.add(AppealStatus.IN_PROGRESS);
    set.add(AppealStatus.RESOLVED);
    set.add(AppealStatus.COMPLETED);
    set.add(AppealStatus.DECLINED);
  }
  if (isCreator) {
    set.add(AppealStatus.COMPLETED);
    if (currentStatus === AppealStatus.RESOLVED) {
      set.add(AppealStatus.IN_PROGRESS);
    }
  }
  if (isAssignee) {
    set.add(AppealStatus.RESOLVED);
  }
  return Array.from(set);
}

function formatHoursByMsForExport(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '-';
  return `${(ms / 3600000).toFixed(2)} ч`;
}

function formatHoursValueForExport(value: number | null | undefined, withUnit = true): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  const normalized = Number(value.toFixed(2));
  return withUnit ? `${normalized} ч` : `${normalized}`;
}

function formatRubForExport(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  const normalized = Number(value.toFixed(2));
  return `${normalized.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function roundExportNumberValue(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Number(value.toFixed(2));
}

function formatHoursByMsForExcelExport(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return null;
  return roundExportNumberValue(ms / 3600000);
}

function formatHoursValueForExcelExport(value: number | null | undefined): number | null {
  return roundExportNumberValue(value);
}

function formatRubForExcelExport(value: number | null | undefined): number | null {
  return roundExportNumberValue(value);
}

function appealStatusLabelForExport(status: AppealStatus): string {
  if (status === AppealStatus.OPEN) return 'Открыто';
  if (status === AppealStatus.IN_PROGRESS) return 'В работе';
  if (status === AppealStatus.RESOLVED) return 'Ожидание подтверждения';
  if (status === AppealStatus.COMPLETED) return 'Завершено';
  return 'Отклонено';
}

function exportPersonName(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  id?: number | null;
}) {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (user.email) return user.email;
  return `Пользователь #${user.id || '-'}`;
}

function formatAnalyticsDeadlineForExport(params: {
  status: AppealStatus;
  deadline: Date | null;
  completedAt: Date | null;
  now: Date;
}) {
  const { status, deadline, completedAt, now } = params;
  if (!deadline || !Number.isFinite(deadline.getTime())) return '—';
  const deadlineText = deadline.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (status === AppealStatus.DECLINED) return deadlineText;
  if (status === AppealStatus.COMPLETED) {
    if (completedAt && Number.isFinite(completedAt.getTime())) {
      return completedAt.getTime() > deadline.getTime()
        ? `${deadlineText} (Просрочено)`
        : `${deadlineText} (Завершено в срок)`;
    }
    return `${deadlineText} (В срок)`;
  }
  if (status === AppealStatus.OPEN || status === AppealStatus.IN_PROGRESS || status === AppealStatus.RESOLVED) {
    const diffMs = deadline.getTime() - now.getTime();
    if (diffMs < 0) return `${deadlineText} (Просрочено)`;
    if (diffMs < 24 * 60 * 60 * 1000) return `${deadlineText} (Меньше суток)`;
    return `${deadlineText} (В срок)`;
  }
  return `${deadlineText} (В срок)`;
}

function buildLaborColumnsForExport(params: {
  assignees: Array<{ id: number; firstName?: string | null; lastName?: string | null; email?: string | null; effectiveHourlyRateRub: number }>;
  laborNotRequired?: boolean;
  laborEntries: Array<{
    assigneeUserId: number;
    accruedHours: number;
    paidHours: number;
    remainingHours: number;
    payable: boolean;
    effectiveHourlyRateRub: number;
    amountAccruedRub: number;
    amountPaidRub: number;
    amountRemainingRub: number;
  }>;
}) {
  const assignees = params.assignees || [];
  if (!assignees.length) {
    return {
      assignees: params.laborNotRequired ? 'Не требуется' : 'Исполнители не назначены',
      hoursAccrued: '—',
      hoursPaid: '—',
      hoursRemaining: '—',
      hourlyRate: params.laborNotRequired ? 'Не требуется' : '—',
      amountAccrued: '—',
      amountPaid: '—',
      amountRemaining: '—',
    };
  }

  const lines = {
    assignees: [] as string[],
    hoursAccrued: [] as string[],
    hoursPaid: [] as string[],
    hoursRemaining: [] as string[],
    hourlyRate: [] as string[],
    amountAccrued: [] as string[],
    amountPaid: [] as string[],
    amountRemaining: [] as string[],
  };

  for (const assignee of assignees) {
    const labor = (params.laborEntries || []).find((entry) => entry.assigneeUserId === assignee.id);
    const accruedHours = labor?.accruedHours ?? 0;
    const paidHours = labor?.paidHours ?? 0;
    const remainingHours = labor?.remainingHours ?? Math.max(0, accruedHours - paidHours);
    const isNotRequired = Boolean(params.laborNotRequired || (labor && !labor.payable));
    lines.assignees.push(exportPersonName(assignee));
    lines.hoursAccrued.push(isNotRequired ? '—' : formatHoursValueForExport(accruedHours));
    lines.hoursPaid.push(isNotRequired ? '—' : formatHoursValueForExport(paidHours));
    lines.hoursRemaining.push(isNotRequired ? '—' : formatHoursValueForExport(remainingHours));
    if (!labor) {
      lines.hourlyRate.push(params.laborNotRequired ? 'Не требуется' : 'Не установлено');
    } else if (labor.payable && !params.laborNotRequired) {
      lines.hourlyRate.push(`${formatRubForExport(labor.effectiveHourlyRateRub)}/ч`);
    } else {
      lines.hourlyRate.push('Не требуется');
    }
    lines.amountAccrued.push(isNotRequired ? '—' : formatRubForExport(labor?.amountAccruedRub ?? 0));
    lines.amountPaid.push(isNotRequired ? '—' : formatRubForExport(labor?.amountPaidRub ?? 0));
    lines.amountRemaining.push(isNotRequired ? '—' : formatRubForExport(labor?.amountRemainingRub ?? 0));
  }

  return {
    assignees: lines.assignees.join('\n'),
    hoursAccrued: lines.hoursAccrued.join('\n'),
    hoursPaid: lines.hoursPaid.join('\n'),
    hoursRemaining: lines.hoursRemaining.join('\n'),
    hourlyRate: lines.hourlyRate.join('\n'),
    amountAccrued: lines.amountAccrued.join('\n'),
    amountPaid: lines.amountPaid.join('\n'),
    amountRemaining: lines.amountRemaining.join('\n'),
  };
}

function buildLaborColumnsForExcelFriendlyExport(params: {
  assignees: Array<{ id: number; firstName?: string | null; lastName?: string | null; email?: string | null; effectiveHourlyRateRub: number }>;
  laborNotRequired?: boolean;
  laborEntries: Array<{
    assigneeUserId: number;
    accruedHours: number;
    paidHours: number;
    remainingHours: number;
    payable: boolean;
    effectiveHourlyRateRub: number;
    amountAccruedRub: number;
    amountPaidRub: number;
    amountRemainingRub: number;
  }>;
}) {
  const sumNumeric = (values: Array<number | null | undefined>) =>
    roundExportNumberValue(values.reduce<number>((acc, value) => acc + (typeof value === 'number' && !Number.isNaN(value) ? value : 0), 0));

  const assignees = params.assignees || [];
  if (!assignees.length) {
    return {
      assignees: params.laborNotRequired ? 'РќРµ С‚СЂРµР±СѓРµС‚СЃСЏ' : 'РСЃРїРѕР»РЅРёС‚РµР»Рё РЅРµ РЅР°Р·РЅР°С‡РµРЅС‹',
      hoursAccrued: null,
      hoursPaid: null,
      hoursRemaining: null,
      hourlyRate: params.laborNotRequired ? 'РќРµ С‚СЂРµР±СѓРµС‚СЃСЏ' : 'вЂ”',
      amountAccrued: null,
      amountPaid: null,
      amountRemaining: null,
    };
  }

  const hourlyRates: string[] = [];
  const hoursAccrued: Array<number | null> = [];
  const hoursPaid: Array<number | null> = [];
  const hoursRemaining: Array<number | null> = [];
  const amountAccrued: Array<number | null> = [];
  const amountPaid: Array<number | null> = [];
  const amountRemaining: Array<number | null> = [];

  for (const assignee of assignees) {
    const labor = (params.laborEntries || []).find((entry) => entry.assigneeUserId === assignee.id);
    const accruedHours = labor?.accruedHours ?? 0;
    const paidHours = labor?.paidHours ?? 0;
    const remainingHours = labor?.remainingHours ?? Math.max(0, accruedHours - paidHours);
    const isNotRequired = Boolean(params.laborNotRequired || (labor && !labor.payable));

    if (!labor) {
      hourlyRates.push(params.laborNotRequired ? 'РќРµ С‚СЂРµР±СѓРµС‚СЃСЏ' : 'РќРµ СѓСЃС‚Р°РЅРѕРІР»РµРЅРѕ');
    } else if (labor.payable && !params.laborNotRequired) {
      hourlyRates.push(String(formatRubForExcelExport(labor.effectiveHourlyRateRub) ?? ''));
    } else {
      hourlyRates.push('РќРµ С‚СЂРµР±СѓРµС‚СЃСЏ');
    }

    hoursAccrued.push(isNotRequired ? null : formatHoursValueForExcelExport(accruedHours));
    hoursPaid.push(isNotRequired ? null : formatHoursValueForExcelExport(paidHours));
    hoursRemaining.push(isNotRequired ? null : formatHoursValueForExcelExport(remainingHours));
    amountAccrued.push(isNotRequired ? null : formatRubForExcelExport(labor?.amountAccruedRub ?? 0));
    amountPaid.push(isNotRequired ? null : formatRubForExcelExport(labor?.amountPaidRub ?? 0));
    amountRemaining.push(isNotRequired ? null : formatRubForExcelExport(labor?.amountRemainingRub ?? 0));
  }

  return {
    assignees: assignees.map((assignee) => exportPersonName(assignee)).join('\n'),
    hoursAccrued: sumNumeric(hoursAccrued),
    hoursPaid: sumNumeric(hoursPaid),
    hoursRemaining: sumNumeric(hoursRemaining),
    hourlyRate: hourlyRates.join('\n'),
    amountAccrued: sumNumeric(amountAccrued),
    amountPaid: sumNumeric(amountPaid),
    amountRemaining: sumNumeric(amountRemaining),
  };
}

async function buildXlsxBuffer(
  sheetName: string,
  rows: Record<string, ExportCellValue>[],
  footerRow?: Record<string, ExportCellValue>,
  columnFormats?: Record<string, ExportColumnFormat>
) {
  const orderedKeys = Object.keys(rows[0] || footerRow || {});
  const probeRows = footerRow ? [...rows, footerRow] : rows;
  const { Workbook } = loadExcelJs();
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = orderedKeys.map((key) => {
    const headerLen = String(key).length;
    const maxCellLen = probeRows.reduce((maxLen, row) => {
      const raw = row?.[key];
      const value = raw == null ? '' : String(raw);
      const lineMax = value
        .split(/\r?\n/)
        .reduce((lineLen, line) => Math.max(lineLen, line.length), 0);
      return Math.max(maxLen, lineMax);
    }, 0);
    const width = Math.min(80, Math.max(12, Math.max(headerLen, maxCellLen) + 2));
    return { header: key, key, width };
  });

  if (orderedKeys.length > 0) {
    for (const row of rows) {
      const rowData: Record<string, ExportCellValue> = {};
      for (const key of orderedKeys) rowData[key] = row?.[key] == null ? '' : row[key];
      sheet.addRow(rowData);
    }
    if (footerRow) {
      const footerData: Record<string, ExportCellValue> = {};
      for (const key of orderedKeys) footerData[key] = footerRow?.[key] == null ? '' : footerRow[key];
      sheet.addRow(footerData);
    }
  }

  const dataStartRow = 2;
  for (let rowNum = dataStartRow; rowNum <= sheet.rowCount; rowNum += 1) {
    const row = sheet.getRow(rowNum);
    let maxLines = 1;
    for (let col = 1; col <= orderedKeys.length; col += 1) {
      const cell = row.getCell(col);
      const columnKey = orderedKeys[col - 1];
      const value = cell.value == null ? '' : String(cell.value);
      const lines = value ? value.split(/\r?\n/).length : 1;
      maxLines = Math.max(maxLines, lines);
      const format = columnFormats?.[columnKey] ?? 'text';
      cell.alignment = {
        wrapText: true,
        vertical: 'top',
        horizontal: format === 'text' ? 'left' : 'right',
      };
      if (format === 'number') cell.numFmt = '0.00';
      if (format === 'currency') cell.numFmt = '#,##0.00 [$₽-ru-RU]';
    }
    row.height = Math.max(18, maxLines * 18 + 2);
  }

  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  for (let col = 1; col <= orderedKeys.length; col += 1) {
    headerRow.getCell(col).alignment = { wrapText: true, vertical: 'middle' };
  }

  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
}

function loadExcelJs(): { Workbook: new () => any } {
  try {
    return require('exceljs') as { Workbook: new () => any };
  } catch (error) {
    throw new Error('exceljs is not installed. Install dependencies to use XLSX export endpoints.');
  }
}

const router = express.Router();

// Храним файлы в памяти, чтобы получить file.buffer и отправить в MinIO
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB на файл (измените под себя)
    files: 20,                  // макс. файлов за раз
  },
  // fileFilter: ...
});

/** Определение типа вложения по mime */
function detectAttachmentType(mime: string): AttachmentType {
  if (mime?.startsWith('image/')) return 'IMAGE';
  if (mime?.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

/** Унифицированное сообщение Zod-ошибки */
function zodErrorMessage(e: z.ZodError) {
  const i = e.issues?.[0];
  if (!i) return 'Ошибка валидации';
  const where = i.path?.length ? ` [${i.path.join('.')}]` : '';
  return `${i.message}${where}`;
}

/** Вспомогательно: загрузка всех файлов сообщения в MinIO и создание записей в БД */
async function saveMulterFilesToAppealMessage(
  db: HasAppealAttachment,
  files: Express.Multer.File[] | undefined,
  messageId: number
) {
  const list = files ?? [];
  for (const file of list) {
    const stored = await uploadMulterFile(file, /*asAttachment*/ false);
    await db.appealAttachment.create({
      data: {
        messageId,
        fileUrl: stored.key,
        fileName: stored.fileName,
        fileType: detectAttachmentType(file.mimetype),
      },
    });
  }
}

async function mapAttachments(attachments: any[] | undefined) {
  const list = attachments ?? [];
  if (!list.length) return [];
  return Promise.all(
    list.map(async (att: any) => ({
      ...att,
      fileUrl: await resolveObjectUrl(att.fileUrl ?? null),
    }))
  );
}

/** Приведение сообщения к фронтовому виду с флагом прочтения */
async function mapMessageWithReads(
  message: MessageWithRelations,
  currentUserId: number
) {
  const readBy = (message.reads ?? []).map((r) => ({
    userId: r.userId,
    readAt: r.readAt,
  }));
  // Считаем собственные сообщения прочитанными для себя, чтобы они не попадали в unread
  const isOwn = message.senderId === currentUserId;
  return {
    id: message.id,
    appealId: message.appealId,
    senderId: message.senderId,
    text: message.text,
    type: message.type ?? AppealMessageType.USER,
    systemEvent: message.systemEvent ?? null,
    editedAt: message.editedAt,
    deleted: message.deleted,
    createdAt: message.createdAt,
    attachments: await mapAttachments(message.attachments),
    sender: await mapUserMini(message.sender),
    readBy,
    isRead: isOwn || readBy.some((r) => r.userId === currentUserId),
  };
}

async function mapMessageForRealtime(message: MessageWithRelations) {
  return {
    id: message.id,
    appealId: message.appealId,
    senderId: message.senderId,
    text: message.text,
    type: message.type ?? AppealMessageType.USER,
    systemEvent: message.systemEvent ?? null,
    editedAt: message.editedAt,
    deleted: message.deleted,
    createdAt: message.createdAt,
    attachments: await mapAttachments(message.attachments),
    sender: await mapUserMini(message.sender),
    readBy: (message.reads ?? []).map((r) => ({ userId: r.userId, readAt: r.readAt })),
  };
}

function encodeMessageCursor(createdAt: Date, id: number) {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeMessageCursor(raw?: string | null) {
  if (!raw) return null;
  const [iso, idStr] = raw.split('|');
  if (!iso || !idStr) return null;
  const dt = new Date(iso);
  const id = Number(idStr);
  if (!Number.isFinite(id) || Number.isNaN(dt.getTime())) return null;
  return { createdAt: dt, id };
}

async function loadUserMini(userId: number) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: userMiniSelect,
  });
}

function buildMessageCursorWhere(opts: {
  appealId: number;
  parsedCursor?: { createdAt: Date; id: number } | null;
  direction: 'before' | 'after';
}): Prisma.AppealMessageWhereInput {
  const where: Prisma.AppealMessageWhereInput = {
    appealId: opts.appealId,
    deleted: false,
  };
  if (!opts.parsedCursor) return where;

  if (opts.direction === 'before') {
    where.OR = [
      { createdAt: { lt: opts.parsedCursor.createdAt } },
      { createdAt: opts.parsedCursor.createdAt, id: { lt: opts.parsedCursor.id } },
    ];
  } else {
    where.OR = [
      { createdAt: { gt: opts.parsedCursor.createdAt } },
      { createdAt: opts.parsedCursor.createdAt, id: { gt: opts.parsedCursor.id } },
    ];
  }
  return where;
}

async function emitAppealUpdated(opts: {
  io: SocketIOServer;
  appealId: number;
  userIds?: number[];
  toDepartmentId?: number | null;
  assigneeIds?: number[];
  lastMessage?: any | null;
}) {
  const appeal = await prisma.appeal.findUnique({
    where: { id: opts.appealId },
    include: {
      assignees: { select: { userId: true } },
      watchers: { select: { userId: true } },
      messages: {
        where: { deleted: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        include: {
          sender: { select: userMiniSelect },
          attachments: true,
          reads: { select: { userId: true, readAt: true } },
        },
      },
    },
  });
  if (!appeal) return;

  const assigneeIds = opts.assigneeIds ?? appeal.assignees.map((a) => a.userId);
  const lastMessage =
    opts.lastMessage ??
    (appeal.messages[0]
      ? await mapMessageForRealtime(appeal.messages[0] as MessageWithRelations)
      : null);
  const payload = {
    appealId: appeal.id,
    status: appeal.status,
    priority: appeal.priority,
    deadline: appeal.deadline,
    toDepartmentId: appeal.toDepartmentId,
    updatedAt: appeal.updatedAt,
    assigneeIds,
    lastMessage,
  };

  const toDepartmentId = opts.toDepartmentId ?? appeal.toDepartmentId;
  const userIds = Array.from(
    new Set([
      ...(opts.userIds || []),
      appeal.createdById,
      ...appeal.assignees.map((a) => a.userId),
      ...appeal.watchers.map((w) => w.userId),
    ])
  );

  opts.io.to(`appeal:${appeal.id}`).emit('appealUpdated', payload);
  if (toDepartmentId) {
    opts.io.to(`department:${toDepartmentId}`).emit('appealUpdated', payload);
  }
  userIds.forEach((uid) => opts.io.to(`user:${uid}`).emit('appealUpdated', payload));
}

async function createSystemMessage(opts: {
  appealId: number;
  actorId: number;
  text: string;
  systemEvent: Record<string, any>;
  io: SocketIOServer;
  toDepartmentId?: number | null;
  recipients?: number[];
}) {
  const message = await prisma.appealMessage.create({
    data: {
      appealId: opts.appealId,
      senderId: opts.actorId,
      text: opts.text,
      type: AppealMessageType.SYSTEM,
      systemEvent: opts.systemEvent,
    },
  });

  const fullMessage = await prisma.appealMessage.findUnique({
    where: { id: message.id },
    include: {
      sender: { select: userMiniSelect },
      attachments: true,
      reads: { select: { userId: true, readAt: true } },
    },
  });
  if (!fullMessage) return null;

  const mapped = await mapMessageWithReads(fullMessage as MessageWithRelations, opts.actorId);
  opts.io.to(`appeal:${opts.appealId}`).emit('messageAdded', mapped);
  if (opts.toDepartmentId) {
    opts.io.to(`department:${opts.toDepartmentId}`).emit('messageAdded', mapped);
  }
  const recipients = Array.from(new Set(opts.recipients || []));
  recipients.forEach((uid) => opts.io.to(`user:${uid}`).emit('messageAdded', mapped));
  return mapped;
}

function emitAppealNotify(opts: {
  io: SocketIOServer;
  userIds: number[];
  kind: 'ASSIGNED' | 'UNASSIGNED' | 'TRANSFER_REMOVED' | 'TRANSFER_AUTHOR' | 'TRANSFER_TO_DEPT';
  appealId: number;
  appealNumber: number;
  title: string;
  message: string;
  icon?: string;
  actorId?: number;
  actorName?: string;
  dedupeScope?: string;
}) {
  const uniqueUserIds = Array.from(
    new Set(
      (opts.userIds || []).filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  const dedupeScope = opts.dedupeScope || String(opts.actorId || '0');
  uniqueUserIds.forEach((uid) => {
    opts.io.to(`user:${uid}`).emit('appealNotify', {
      kind: opts.kind,
      appealId: opts.appealId,
      appealNumber: opts.appealNumber,
      title: opts.title,
      message: opts.message,
      icon: opts.icon,
      dedupeKey: `${opts.kind}:${opts.appealId}:${uid}:${dedupeScope}`,
      actorId: opts.actorId,
      actorName: opts.actorName,
    });
  });
}

async function rescheduleUnreadReminderIfNeeded(appealId: number): Promise<void> {
  await cancelAppealJobs(appealId);

  const appeal = await prisma.appeal.findUnique({
    where: { id: appealId },
    select: { status: true },
  });
  if (!appeal) return;
  if (appeal.status !== AppealStatus.OPEN && appeal.status !== AppealStatus.IN_PROGRESS) return;

  const latestUserMessage = await prisma.appealMessage.findFirst({
    where: {
      appealId,
      deleted: false,
      type: AppealMessageType.USER,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      reads: {
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!latestUserMessage) return;
  if (latestUserMessage.reads.length > 0) return;

  await scheduleUnreadReminder(appealId);
}


// POST /appeals — создание обращения + первое сообщение + загрузка вложений в облако
/**
 * @openapi
 * /appeals:
 *   post:
 *     tags: [Appeals]
 *     summary: Создать новое обращение
 *     description: Создаёт обращение и первое сообщение; поддерживает загрузку вложений.
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["create_appeal"]
 */
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['create_appeal']),
  upload.array('attachments'), // важно: именно массив "attachments"
  async (
    req: AuthRequest<{}, AppealCreateResponse, CreateAppealBody>,
    res: express.Response
  ) => {
    try {
      // 1) Валидация multipart-body (все поля приходят как строки)
      const parsed = CreateAppealBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json(
            errorResponse(
              zodErrorMessage(parsed.error),
              ErrorCodes.VALIDATION_ERROR
            )
          );
      }
      const { toDepartmentId, title, text, priority, deadline } = parsed.data;
      const normalizedText = text.trim();
      const normalizedTitle = title?.trim() || normalizedText;

      // 2) Проверяем существование отдела-получателя
      const targetDept = await prisma.department.findUnique({
        where: { id: toDepartmentId },
      });
      if (!targetDept) {
        return res
          .status(404)
          .json(
            errorResponse('Отдел-получатель не найден', ErrorCodes.NOT_FOUND)
          );
      }

      const userId = req.user!.userId;

      // 3) Профиль сотрудника (для fromDepartmentId)
      const employee = await prisma.employeeProfile.findUnique({
        where: { userId },
      });

      // 4) Следующий номер обращения
      const lastAppeal = await prisma.appeal.findFirst({
        orderBy: { number: 'desc' },
      });
      const nextNumber = lastAppeal ? lastAppeal.number + 1 : 1;

      // 5) Транзакция: создаём Appeal, первое сообщение и вложения
      const createdAppeal = await prisma.$transaction(async (tx) => {
        const appeal = await tx.appeal.create({
          data: {
            number: nextNumber,
            fromDepartmentId: employee?.departmentId ?? null,
            toDepartmentId,
            createdById: userId,
            status: AppealStatus.OPEN,
            priority: (priority as AppealPriority) ?? AppealPriority.MEDIUM,
            deadline: deadline ? new Date(deadline) : null,
            title: normalizedTitle,
          },
        });

        const message = await tx.appealMessage.create({
          data: {
            appealId: appeal.id,
            senderId: userId,
            text: normalizedText, // первый текст сообщения из формы
          },
        });

        // --- загрузка вложений в MinIO ---
        await saveMulterFilesToAppealMessage(
          tx as unknown as HasAppealAttachment,
          (req.files as Express.Multer.File[]) ?? [],
          message.id
        );
        // --- конец загрузки вложений ---

        return appeal;
      });

      // Инвалидация кэша списков/деталей, чтобы новое обращение появилось сразу
      await cacheDelPrefix('appeals:list:');
      await cacheDelPrefix('appeal:');

      // 6) WebSocket-уведомление отдела-получателя
      const io = req.app.get('io') as SocketIOServer;
      io.to(`department:${createdAppeal.toDepartmentId}`).emit('appealCreated', {
        id: createdAppeal.id,
        number: createdAppeal.number,
        status: createdAppeal.status,
        priority: createdAppeal.priority,
        title: createdAppeal.title,
      });

      // 6.1) Telegram-уведомление + планировщик
      void (async () => {
        try {
          const [deptRoleMembers, employeeDeptMembers] = await Promise.all([
            prisma.departmentRole.findMany({
              where: { departmentId: createdAppeal.toDepartmentId },
              select: { userId: true },
            }),
            prisma.employeeProfile.findMany({
              where: { departmentId: createdAppeal.toDepartmentId },
              select: { userId: true },
            }),
          ]);
          const deptUserIds = Array.from(
            new Set([
              ...deptRoleMembers.map((m) => m.userId),
              ...employeeDeptMembers.map((m) => m.userId),
            ])
          );

          const fromDept = createdAppeal.fromDepartmentId
            ? await prisma.department.findUnique({
                where: { id: createdAppeal.fromDepartmentId },
                select: { name: true },
              })
            : null;

          const creator = await prisma.user.findUnique({
            where: { id: createdAppeal.createdById },
            select: { firstName: true, lastName: true, email: true },
          });
          const creatorName = [creator?.firstName, creator?.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || creator?.email || 'Пользователь';

          await dispatchNotification({
            type: 'NEW_APPEAL',
            appealId: createdAppeal.id,
            appealNumber: createdAppeal.number,
            title: `Новое обращение #${createdAppeal.number}`,
            body: createdAppeal.title || 'Новое обращение',
            telegramText: tplNewAppeal({
              appealId:     createdAppeal.id,
              number:       createdAppeal.number,
              title:        createdAppeal.title,
              fromDeptName: fromDept?.name ?? null,
              creatorName,
              channel: 'telegram',
            }),
            maxText: tplNewAppeal({
              appealId: createdAppeal.id,
              number: createdAppeal.number,
              title: createdAppeal.title,
              fromDeptName: fromDept?.name ?? null,
              creatorName,
              channel: 'max',
            }),
            channels: ['telegram', 'max'],
            recipientUserIds: deptUserIds,
            excludeSenderUserId: createdAppeal.createdById,
          });

          await scheduleUnreadReminder(createdAppeal.id);
        } catch (err: any) {
          console.error('[notifications] new appeal error:', err?.message);
        }
      })();

      // 7) Ответ
      return res.status(201).json(
        successResponse(
          {
            id: createdAppeal.id,
            number: createdAppeal.number,
            status: createdAppeal.status,
            priority: createdAppeal.priority,
            createdAt: createdAppeal.createdAt,
          },
          'Обращение создано'
        )
      );
    } catch (error) {
      console.error('Ошибка создания обращения:', error);
      return res
        .status(500)
        .json(
          errorResponse('Ошибка создания обращения', ErrorCodes.INTERNAL_ERROR)
        );
    }
  }
);


/**
 * @openapi
 * /appeals:
 *   get:
 *     tags: [Appeals]
 *     summary: Список обращений
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (req: AuthRequest<{}, AppealListResponse>, res: express.Response) => {
    try {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { scope, limit, offset, status, priority } = parsed.data;

      const userId = req.user!.userId;

      let where: any = {};
      switch (scope) {
        case 'my':
          where.createdById = userId;
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
          if (!employee?.departmentId) {
            return res
              .status(400)
              .json(errorResponse('У пользователя не указан отдел', ErrorCodes.VALIDATION_ERROR));
          }
          where.toDepartmentId = employee.departmentId;
          break;
        }
        case 'assigned':
          where.assignees = { some: { userId } };
          break;
      }

      if (status) where.status = status;
      if (priority) where.priority = priority;

      const cacheKey = `appeals:list:${userId}:${scope}:${status || ''}:${priority || ''}:${limit}:${offset}`;
      const cached = await cacheGet<{ data: any[]; meta: { total: number; limit: number; offset: number } }>(cacheKey);
      if (cached) {
        return res.json(successResponse(cached, 'Список обращений'));
      }

      const [total, appeals] = await prisma.$transaction([
        prisma.appeal.count({ where }),
        prisma.appeal.findMany({
          where,
          include: {
            fromDepartment: true,
            toDepartment: true,
            assignees: {
              include: {
                user: { select: userMiniSelect },
              },
            },
            messages: {
              where: { deleted: false },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: {
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
                sender: {
                  select: userMiniSelect,
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
          orderBy: { updatedAt: 'desc' },
          skip: offset,
          take: limit,
        }),
      ]);

      const responseData = {
        data: await Promise.all(
          appeals.map(async (a: any) => {
            const { messages, _count, ...rest } = a;
            const lastMessage = messages?.[0]
              ? await mapMessageWithReads(messages[0] as MessageWithRelations, userId)
              : null;
            const assignees = await Promise.all(
              (a.assignees || []).map(async (as: any) => ({
                user: await mapUserMini(as.user as UserMiniRaw),
              }))
            );
            return {
              ...rest,
              assignees,
              lastMessage,
              unreadCount: _count?.messages ?? 0,
            };
          })
        ),
        meta: { total, limit, offset },
      };
      await cacheSet(cacheKey, responseData, 60);

      return res.json(successResponse(responseData, 'Список обращений'));
    } catch (error) {
      console.error('Ошибка получения списка обращений:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения списка обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/counters:
 *   get:
 *     tags: [Appeals]
 *     summary: Агрегированные счетчики обращений по scope
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 *     responses:
 *       200:
 *         description: Счетчики успешно получены
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AppealCountersData'
 */
router.get(
  '/counters',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (req: AuthRequest<{}, AppealCountersResponse>, res: express.Response) => {
    try {
      const userId = req.user!.userId;
      const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
      const departmentId = employee?.departmentId ?? null;

      const myAppealScopeWhere: Prisma.AppealWhereInput = { createdById: userId };
      const departmentAppealScopeWhere: Prisma.AppealWhereInput = departmentId
        ? { toDepartmentId: departmentId }
        : { id: -1 };

      const [
        myActiveCount,
        myUnreadMessagesCount,
        departmentActiveCount,
        departmentUnreadMessagesCount,
      ] = await prisma.$transaction([
        prisma.appeal.count({
          where: {
            ...myAppealScopeWhere,
            status: { in: ACTIVE_APPEAL_STATUSES },
          },
        }),
        prisma.appealMessage.count({
          where: {
            deleted: false,
            senderId: { not: userId },
            reads: { none: { userId } },
            appeal: myAppealScopeWhere,
          },
        }),
        prisma.appeal.count({
          where: departmentId
            ? {
                ...departmentAppealScopeWhere,
                status: { in: ACTIVE_APPEAL_STATUSES },
              }
            : { id: -1 },
        }),
        prisma.appealMessage.count({
          where: departmentId
            ? {
                deleted: false,
                senderId: { not: userId },
                reads: { none: { userId } },
                appeal: departmentAppealScopeWhere,
              }
            : { id: -1 },
        }),
      ]);

      return res.json(
        successResponse(
          {
            my: {
              activeCount: myActiveCount,
              unreadMessagesCount: myUnreadMessagesCount,
            },
            department: {
              available: Boolean(departmentId),
              activeCount: departmentId ? departmentActiveCount : 0,
              unreadMessagesCount: departmentId ? departmentUnreadMessagesCount : 0,
            },
          },
          'Счетчики обращений'
        )
      );
    } catch (error) {
      console.error('Ошибка получения счетчиков обращений:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения счетчиков обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/meta',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsAnalyticsMetaResponse>, res: express.Response) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!user) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }

      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const departments = await prisma.department.findMany({
        where: roleFlags.isAdmin ? undefined : { id: { in: managedDepartmentIds.length ? managedDepartmentIds : [-1] } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, appealPaymentRequired: true, appealLaborHourlyRate: true },
      });
      const availableAssigneesRaw = await prisma.user.findMany({
        where: {
          employeeProfile: roleFlags.isAdmin
            ? { isNot: null }
            : { departmentId: { in: managedDepartmentIds.length ? managedDepartmentIds : [-1] } },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          employeeProfile: { select: { appealLaborHourlyRate: true, department: { select: { id: true, name: true } } } },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { email: 'asc' }],
      });

      return res.json(
        successResponse(
          {
            availableDepartments: departments.map((d) => ({
              id: d.id,
              name: d.name,
              paymentRequired: d.appealPaymentRequired,
              hourlyRateRub: round2(Number(d.appealLaborHourlyRate || 0)),
            })),
            availableAssignees: availableAssigneesRaw.map((u) => ({
              id: u.id,
              email: u.email,
              firstName: u.firstName,
              lastName: u.lastName,
              department: u.employeeProfile?.department ?? null,
              hourlyRateRub: round2(Number(u.employeeProfile?.appealLaborHourlyRate || 0)),
            })),
            role: roleFlags,
          },
          'Метаданные аналитики загружены'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/analytics/meta:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки метаданных', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/appeals',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsAnalyticsAppealsResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsAppealsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!user) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }

      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, assigneeUserId, status, paymentState, search, limit, offset } = parsed.data;

      if (!roleFlags.isAdmin && departmentId && !managedDepartmentIds.includes(departmentId)) {
        return res.status(403).json(errorResponse('Нет доступа к отделу', ErrorCodes.FORBIDDEN));
      }

      const where = buildAnalyticsAppealsWhere({
        roleFlags,
        managedDepartmentIds,
        departmentId,
        fromDate,
        toDate,
        assigneeUserId,
        status,
        paymentState,
        search,
      });

      const [total, appeals] = await prisma.$transaction([
        prisma.appeal.count({ where }),
        prisma.appeal.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          include: {
            fromDepartment: { select: { id: true, name: true } },
            toDepartment: { select: { id: true, name: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
            createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            assignees: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    employeeProfile: { select: { appealLaborHourlyRate: true } },
                  },
                },
              },
            },
            statusHistory: { select: { oldStatus: true, newStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
            laborEntries: {
              include: {
                assignee: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    employeeProfile: { select: { appealLaborHourlyRate: true } },
                  },
                },
                paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
              },
              orderBy: { assigneeUserId: 'asc' },
            },
          },
        }),
      ]);

      const now = new Date();
      const actorUserId = Number((user as UserMiniRaw).id);
      const actorDepartmentId = Number((user as UserMiniRaw).employeeProfile?.department?.id || 0);
      const data = appeals.map((appeal) => {
        const completedAt = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.COMPLETED)?.changedAt ?? null;
        const sla = calculateAppealSla(
          appeal.createdAt,
          appeal.status,
          appeal.statusHistory.map((h) => ({ oldStatus: h.oldStatus, newStatus: h.newStatus, changedAt: h.changedAt })),
          now
        );
        const isCreator = appeal.createdById === actorUserId;
        const isAssignee = (appeal.assignees || []).some((a) => a.user.id === actorUserId);
        const isManager = isDepartmentManager(user as UserMiniRaw, appeal.toDepartmentId);
        const isClosed = appeal.status === AppealStatus.COMPLETED || appeal.status === AppealStatus.DECLINED;
        const isDeptMember = actorDepartmentId > 0 && actorDepartmentId === appeal.toDepartmentId;
        const allowedStatuses = computeAnalyticsAllowedStatuses({
          currentStatus: appeal.status,
          isAdmin: roleFlags.isAdmin,
          isManager,
          isCreator,
          isAssignee,
        });
        const canClaim = !isClosed && !isCreator && !isAssignee && isDeptMember;

        return {
          id: appeal.id,
          number: appeal.number,
          title: appeal.title ?? null,
          status: appeal.status,
          laborNotRequired: appeal.laborNotRequired,
          createdAt: appeal.createdAt,
          deadline: appeal.deadline ?? null,
          completedAt,
          createdBy: {
            id: appeal.createdBy.id,
            email: appeal.createdBy.email,
            firstName: appeal.createdBy.firstName,
            lastName: appeal.createdBy.lastName,
          },
          fromDepartment: appeal.fromDepartment
            ? {
                id: appeal.fromDepartment.id,
                name: appeal.fromDepartment.name,
              }
            : null,
          toDepartment: {
            id: appeal.toDepartment.id,
            name: appeal.toDepartment.name,
            paymentRequired: appeal.toDepartment.appealPaymentRequired,
            hourlyRateRub: round2(Number(appeal.toDepartment.appealLaborHourlyRate || 0)),
          },
          assignees: (appeal.assignees || []).map((a) => ({
            id: a.user.id,
            email: a.user.email,
            firstName: a.user.firstName,
            lastName: a.user.lastName,
            hourlyRateRub: round2(Number(a.user.employeeProfile?.appealLaborHourlyRate || 0)),
            effectiveHourlyRateRub: resolveEffectiveHourlyRate({
              departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
              departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
              assigneeHourlyRate:
                a.user.employeeProfile?.appealLaborHourlyRate == null
                  ? null
                  : Number(a.user.employeeProfile.appealLaborHourlyRate),
            }),
          })),
          sla,
          allowedStatuses,
          actionPermissions: {
            canChangeStatus: allowedStatuses.length > 0,
            canEditDeadline: roleFlags.isAdmin || isCreator,
            canAssign: roleFlags.isAdmin || isManager,
            canTransfer: roleFlags.isAdmin || isManager,
            canOpenParticipants: true,
            canSetLabor: roleFlags.isAdmin || isManager,
            canClaim,
          },
          laborEntries: (appeal.laborEntries || []).map((entry) =>
            mapLaborEntryDto(entry, {
              departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
              departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
              appealLaborNotRequired: appeal.laborNotRequired,
            })
          ),
        };
      });

      return res.json(
        successResponse(
          {
            data,
            meta: {
              total,
              limit,
              offset,
              hasMore: offset + data.length < total,
            },
          },
          'Аналитика обращений загружена'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/analytics/appeals:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки аналитики обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/users',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsAnalyticsUsersResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsUsersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!user) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }

      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId } = parsed.data;
      if (!roleFlags.isAdmin && departmentId && !managedDepartmentIds.includes(departmentId)) {
        return res.status(403).json(errorResponse('Нет доступа к отделу', ErrorCodes.FORBIDDEN));
      }

      const accessibleDepartmentIds = roleFlags.isAdmin
        ? (departmentId ? [departmentId] : undefined)
        : (departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1]);

      const appeals = await prisma.appeal.findMany({
        where: {
          toDepartmentId: roleFlags.isAdmin
            ? (departmentId ? departmentId : undefined)
            : { in: accessibleDepartmentIds },
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: new Date(fromDate) } : {}),
                  ...(toDate ? { lte: new Date(toDate) } : {}),
                },
              }
            : {}),
        },
        select: {
          id: true,
          toDepartment: { select: { id: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
        },
      });
      const appealIds = appeals.map((a) => a.id);

      const usersRaw = await prisma.user.findMany({
        where: {
          employeeProfile: roleFlags.isAdmin
            ? (departmentId ? { departmentId } : { isNot: null })
            : { departmentId: { in: accessibleDepartmentIds } },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          employeeProfile: {
            select: {
              appealLaborHourlyRate: true,
              department: {
                select: {
                  id: true,
                  name: true,
                  appealPaymentRequired: true,
                  appealLaborHourlyRate: true,
                },
              },
            },
          },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { email: 'asc' }],
      });

      const grouped = new Map<
        number,
        {
          appealIds: Set<number>;
          paidAppeals: Set<number>;
          unpaidAppeals: Set<number>;
          partialAppeals: Set<number>;
          notRequiredAppeals: Set<number>;
          accruedHours: number;
          paidHours: number;
          remainingHours: number;
          accruedAmountRub: number;
          paidAmountRub: number;
          remainingAmountRub: number;
        }
      >();

      if (appealIds.length > 0) {
        const laborEntries = await prisma.appealLaborEntry.findMany({
          where: { appealId: { in: appealIds } },
          include: {
            assignee: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                employeeProfile: { select: { appealLaborHourlyRate: true } },
              },
            },
            paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            appeal: {
              select: {
                laborNotRequired: true,
                toDepartment: { select: { id: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
              },
            },
          },
        });

        for (const entry of laborEntries) {
          if (!grouped.has(entry.assigneeUserId)) {
            grouped.set(entry.assigneeUserId, {
              appealIds: new Set<number>(),
              paidAppeals: new Set<number>(),
              unpaidAppeals: new Set<number>(),
              partialAppeals: new Set<number>(),
              notRequiredAppeals: new Set<number>(),
              accruedHours: 0,
              paidHours: 0,
              remainingHours: 0,
              accruedAmountRub: 0,
              paidAmountRub: 0,
              remainingAmountRub: 0,
            });
          }
          const row = grouped.get(entry.assigneeUserId)!;
          const dto = mapLaborEntryDto(entry, {
            departmentPaymentRequired: entry.appeal.toDepartment.appealPaymentRequired,
            departmentHourlyRate: Number(entry.appeal.toDepartment.appealLaborHourlyRate || 0),
            appealLaborNotRequired: entry.appeal.laborNotRequired,
          });
          row.appealIds.add(entry.appealId);
          if (dto.paymentStatus === AppealLaborPaymentStatus.PAID) row.paidAppeals.add(entry.appealId);
          if (dto.paymentStatus === AppealLaborPaymentStatus.UNPAID) row.unpaidAppeals.add(entry.appealId);
          if (dto.paymentStatus === AppealLaborPaymentStatus.PARTIAL) row.partialAppeals.add(entry.appealId);
          if (dto.paymentStatus === AppealLaborPaymentStatus.NOT_REQUIRED) row.notRequiredAppeals.add(entry.appealId);
          if (dto.payable) {
            row.accruedHours += dto.accruedHours;
            row.paidHours += dto.paidHours;
            row.remainingHours += dto.remainingHours;
          }
          row.accruedAmountRub += dto.amountAccruedRub;
          row.paidAmountRub += dto.amountPaidRub;
          row.remainingAmountRub += dto.amountRemainingRub;
        }
      }

      const data = usersRaw
        .map((u) => {
          const stats = grouped.get(u.id);
          const userHourlyRate = round2(Number(u.employeeProfile?.appealLaborHourlyRate || 0));
          const effectiveHourlyRate = resolveEffectiveHourlyRate({
            departmentPaymentRequired: Boolean(u.employeeProfile?.department?.appealPaymentRequired),
            departmentHourlyRate: Number(u.employeeProfile?.department?.appealLaborHourlyRate || 0),
            assigneeHourlyRate: u.employeeProfile?.appealLaborHourlyRate == null
              ? null
              : Number(u.employeeProfile.appealLaborHourlyRate),
          });
          return {
            user: {
              id: u.id,
              email: u.email,
              firstName: u.firstName,
              lastName: u.lastName,
              avatarUrl: u.avatarUrl ?? null,
              department: u.employeeProfile?.department
                ? { id: u.employeeProfile.department.id, name: u.employeeProfile.department.name }
                : null,
              hourlyRateRub: userHourlyRate,
              effectiveHourlyRateRub: effectiveHourlyRate,
            },
            stats: {
              appealsCount: stats?.appealIds.size ?? 0,
              paidAppealsCount: stats?.paidAppeals.size ?? 0,
              unpaidAppealsCount: stats?.unpaidAppeals.size ?? 0,
              partialAppealsCount: stats?.partialAppeals.size ?? 0,
              notRequiredAppealsCount: stats?.notRequiredAppeals.size ?? 0,
              accruedHours: round2(stats?.accruedHours ?? 0),
              paidHours: round2(stats?.paidHours ?? 0),
              remainingHours: round2(stats?.remainingHours ?? 0),
              accruedAmountRub: round2(stats?.accruedAmountRub ?? 0),
              paidAmountRub: round2(stats?.paidAmountRub ?? 0),
              remainingAmountRub: round2(stats?.remainingAmountRub ?? 0),
            },
          };
        })
        .sort((a, b) => b.stats.accruedAmountRub - a.stats.accruedAmountRub);

      return res.json(successResponse({ data }, 'Сводка по исполнителям загружена'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/users:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки аналитики по исполнителям', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/users/:userId/appeals',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{ userId: string }, AppealsAnalyticsUserAppealsResponse>, res: express.Response) => {
    try {
      const idParsed = IdParamSchema.safeParse({ id: req.params.userId });
      const queryParsed = AnalyticsUsersQuerySchema.safeParse(req.query);
      if (!idParsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(idParsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      if (!queryParsed.success) {
        const zodError = queryParsed.error;
        return res.status(400).json(errorResponse(zodErrorMessage(zodError), ErrorCodes.VALIDATION_ERROR));
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!user) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }

      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId } = queryParsed.data;
      if (!roleFlags.isAdmin && departmentId && !managedDepartmentIds.includes(departmentId)) {
        return res.status(403).json(errorResponse('Нет доступа к отделу', ErrorCodes.FORBIDDEN));
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: idParsed.data.id },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          employeeProfile: { select: { department: { select: { id: true, name: true } } } },
        },
      });
      if (!targetUser) {
        return res.status(404).json(errorResponse('Исполнитель не найден', ErrorCodes.NOT_FOUND));
      }

      const appeals = await prisma.appeal.findMany({
        where: {
          toDepartmentId: roleFlags.isAdmin
            ? (departmentId ? departmentId : undefined)
            : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
          laborEntries: { some: { assigneeUserId: idParsed.data.id } },
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: new Date(fromDate) } : {}),
                  ...(toDate ? { lte: new Date(toDate) } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          fromDepartment: { select: { id: true, name: true } },
          toDepartment: { select: { id: true, name: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          assignees: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  employeeProfile: { select: { appealLaborHourlyRate: true } },
                },
              },
            },
          },
          statusHistory: { select: { oldStatus: true, newStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          laborEntries: {
            include: {
              assignee: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  employeeProfile: { select: { appealLaborHourlyRate: true } },
                },
              },
              paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
            orderBy: { assigneeUserId: 'asc' },
          },
        },
      });

      const now = new Date();
      const actorUserId = Number((user as UserMiniRaw).id);
      const actorDepartmentId = Number((user as UserMiniRaw).employeeProfile?.department?.id || 0);
      const data = appeals.map((appeal) => {
        const completedAt = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.COMPLETED)?.changedAt ?? null;
        const sla = calculateAppealSla(
          appeal.createdAt,
          appeal.status,
          appeal.statusHistory.map((h) => ({ oldStatus: h.oldStatus, newStatus: h.newStatus, changedAt: h.changedAt })),
          now
        );
        const isCreator = appeal.createdById === actorUserId;
        const isAssignee = (appeal.assignees || []).some((a) => a.user.id === actorUserId);
        const isManager = isDepartmentManager(user as UserMiniRaw, appeal.toDepartmentId);
        const isClosed = appeal.status === AppealStatus.COMPLETED || appeal.status === AppealStatus.DECLINED;
        const isDeptMember = actorDepartmentId > 0 && actorDepartmentId === appeal.toDepartmentId;
        const allowedStatuses = computeAnalyticsAllowedStatuses({
          currentStatus: appeal.status,
          isAdmin: roleFlags.isAdmin,
          isManager,
          isCreator,
          isAssignee,
        });
        const canClaim = !isClosed && !isCreator && !isAssignee && isDeptMember;

        return {
          id: appeal.id,
          number: appeal.number,
          title: appeal.title ?? null,
          status: appeal.status,
          laborNotRequired: appeal.laborNotRequired,
          createdAt: appeal.createdAt,
          deadline: appeal.deadline ?? null,
          completedAt,
          createdBy: {
            id: appeal.createdBy.id,
            email: appeal.createdBy.email,
            firstName: appeal.createdBy.firstName,
            lastName: appeal.createdBy.lastName,
          },
          fromDepartment: appeal.fromDepartment
            ? {
                id: appeal.fromDepartment.id,
                name: appeal.fromDepartment.name,
              }
            : null,
          toDepartment: {
            id: appeal.toDepartment.id,
            name: appeal.toDepartment.name,
            paymentRequired: appeal.toDepartment.appealPaymentRequired,
            hourlyRateRub: round2(Number(appeal.toDepartment.appealLaborHourlyRate || 0)),
          },
          assignees: (appeal.assignees || []).map((a) => ({
            id: a.user.id,
            email: a.user.email,
            firstName: a.user.firstName,
            lastName: a.user.lastName,
            hourlyRateRub: round2(Number(a.user.employeeProfile?.appealLaborHourlyRate || 0)),
            effectiveHourlyRateRub: resolveEffectiveHourlyRate({
              departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
              departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
              assigneeHourlyRate:
                a.user.employeeProfile?.appealLaborHourlyRate == null
                  ? null
                  : Number(a.user.employeeProfile.appealLaborHourlyRate),
            }),
          })),
          sla,
          allowedStatuses,
          actionPermissions: {
            canChangeStatus: allowedStatuses.length > 0,
            canEditDeadline: roleFlags.isAdmin || isCreator,
            canAssign: roleFlags.isAdmin || isManager,
            canTransfer: roleFlags.isAdmin || isManager,
            canOpenParticipants: true,
            canSetLabor: roleFlags.isAdmin || isManager,
            canClaim,
          },
          laborEntries: (appeal.laborEntries || []).map((entry) =>
            mapLaborEntryDto(entry, {
              departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
              departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
              appealLaborNotRequired: appeal.laborNotRequired,
            })
          ),
        };
      });

      return res.json(
        successResponse(
          {
            user: {
              id: targetUser.id,
              email: targetUser.email,
              firstName: targetUser.firstName,
              lastName: targetUser.lastName,
              avatarUrl: targetUser.avatarUrl ?? null,
              department: targetUser.employeeProfile?.department ?? null,
            },
            data,
          },
          'Список обращений исполнителя загружен'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/analytics/users/:id/appeals:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки обращений исполнителя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/analytics/users/:userId/hourly-rate',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_labor']),
  async (req: AuthRequest<{ userId: string }, AppealsAnalyticsUpdateHourlyRateResponse>, res: express.Response) => {
    try {
      const idParsed = IdParamSchema.safeParse({ id: req.params.userId });
      if (!idParsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(idParsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const bodyParsed = UserHourlyRateBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(bodyParsed.error), ErrorCodes.VALIDATION_ERROR));
      }

      const actingUser = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!actingUser) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const target = await prisma.user.findUnique({
        where: { id: idParsed.data.id },
        select: {
          id: true,
          employeeProfile: { select: { departmentId: true } },
        },
      });
      if (!target?.employeeProfile) {
        return res.status(404).json(errorResponse('Профиль сотрудника не найден', ErrorCodes.NOT_FOUND));
      }

      const canManage =
        isAdminRole(actingUser as UserMiniRaw) ||
        isDepartmentManager(actingUser as UserMiniRaw, target.employeeProfile.departmentId);
      if (!canManage) {
        return res.status(403).json(errorResponse('Недостаточно прав для изменения ставки', ErrorCodes.FORBIDDEN));
      }

      const hourlyRateRub = round2(Number(bodyParsed.data.hourlyRateRub));
      await prisma.employeeProfile.update({
        where: { userId: target.id },
        data: { appealLaborHourlyRate: new Prisma.Decimal(hourlyRateRub) },
      });

      return res.json(
        successResponse(
          { userId: target.id, hourlyRateRub },
          'Ставка исполнителя обновлена'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/analytics/users/:userId/hourly-rate:', error);
      return res.status(500).json(errorResponse('Ошибка обновления ставки исполнителя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/:id/labor',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_labor']),
  async (req: AuthRequest<{ id: string }, AppealLaborUpsertResponse>, res: express.Response) => {
    try {
      const idParsed = IdParamSchema.safeParse(req.params);
      const bodyParsed = AppealLaborUpsertBodySchema.safeParse(req.body);
      if (!idParsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(idParsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      if (!bodyParsed.success) {
        const zodError = bodyParsed.error;
        return res.status(400).json(errorResponse(zodErrorMessage(zodError), ErrorCodes.VALIDATION_ERROR));
      }

      const actingUser = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: userMiniSelect,
      });
      if (!actingUser) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const appeal = await prisma.appeal.findUnique({
        where: { id: idParsed.data.id },
        include: {
          toDepartment: { select: { id: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
          assignees: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const canManageAppealLabor = isAdminRole(actingUser as UserMiniRaw) ||
        isDepartmentManager(actingUser as UserMiniRaw, appeal.toDepartmentId);
      if (!canManageAppealLabor) {
        return res.status(403).json(errorResponse('Недостаточно прав для редактирования часов', ErrorCodes.FORBIDDEN));
      }

      const assigneeSet = new Set<number>((appeal.assignees || []).map((a) => a.userId));
      const invalidAssignee = bodyParsed.data.items.find((i) => !assigneeSet.has(i.assigneeUserId));
      if (invalidAssignee) {
        return res
          .status(400)
          .json(errorResponse(`Пользователь ${invalidAssignee.assigneeUserId} не является исполнителем обращения`, ErrorCodes.VALIDATION_ERROR));
      }

      const assigneeRateRows = await prisma.user.findMany({
        where: { id: { in: Array.from(assigneeSet) } },
        select: { id: true, employeeProfile: { select: { appealLaborHourlyRate: true } } },
      });
      const assigneeRateMap = new Map<number, number | null>();
      assigneeRateRows.forEach((row) => {
        assigneeRateMap.set(
          row.id,
          row.employeeProfile?.appealLaborHourlyRate == null
            ? null
            : Number(row.employeeProfile.appealLaborHourlyRate)
        );
      });

      const departmentHourlyRate = Number(appeal.toDepartment.appealLaborHourlyRate || 0);
      const paymentRequired = appeal.toDepartment.appealPaymentRequired;
      const laborNotRequired = bodyParsed.data.laborNotRequired === true;

      const writeLaborAuditLog = async (
        tx: Prisma.TransactionClient,
        assigneeUserId: number,
        oldHours: number | null,
        newHours: number,
        oldPaidHours: number | null,
        newPaidHours: number,
        oldPaymentStatus: AppealLaborPaymentStatus | null,
        newPaymentStatus: AppealLaborPaymentStatus
      ) => {
        if (
          oldHours === newHours &&
          oldPaidHours === newPaidHours &&
          oldPaymentStatus === newPaymentStatus
        ) {
          return;
        }
        await (tx as any).appealLaborAuditLog.create({
          data: {
            appealId: appeal.id,
            assigneeUserId,
            changedById: actingUser.id,
            oldHours: oldHours == null ? null : new Prisma.Decimal(oldHours),
            newHours: new Prisma.Decimal(newHours),
            oldPaidHours: oldPaidHours == null ? null : new Prisma.Decimal(oldPaidHours),
            newPaidHours: new Prisma.Decimal(newPaidHours),
            oldPaymentStatus: oldPaymentStatus as any,
            newPaymentStatus,
          },
        });
      };

      try {
        await prisma.$transaction(async (tx) => {
          await tx.appeal.update({
            where: { id: appeal.id },
            data: { laborNotRequired },
          });

          const currentEntries = await tx.appealLaborEntry.findMany({
            where: { appealId: appeal.id },
          });
          const prevByAssignee = new Map<number, (typeof currentEntries)[number]>();
          currentEntries.forEach((entry) => prevByAssignee.set(entry.assigneeUserId, entry));

          if (laborNotRequired) {
            const targetAssigneeIds = Array.from(
              new Set<number>([
                ...Array.from(assigneeSet),
                ...currentEntries.map((entry) => entry.assigneeUserId),
              ])
            );

            for (const assigneeUserId of targetAssigneeIds) {
              const prev = prevByAssignee.get(assigneeUserId) ?? null;
              await tx.appealLaborEntry.upsert({
                where: {
                  appealId_assigneeUserId: {
                    appealId: appeal.id,
                    assigneeUserId,
                  },
                },
                update: {
                  hours: new Prisma.Decimal(0),
                  paidHours: new Prisma.Decimal(0),
                  effectiveHourlyRateRub: new Prisma.Decimal(0),
                  paymentStatus: AppealLaborPaymentStatus.NOT_REQUIRED,
                  paidAt: null,
                  paidById: null,
                  updatedById: actingUser.id,
                },
                create: {
                  appealId: appeal.id,
                  assigneeUserId,
                  hours: new Prisma.Decimal(0),
                  paidHours: new Prisma.Decimal(0),
                  effectiveHourlyRateRub: new Prisma.Decimal(0),
                  paymentStatus: AppealLaborPaymentStatus.NOT_REQUIRED,
                  paidAt: null,
                  paidById: null,
                  createdById: actingUser.id,
                  updatedById: actingUser.id,
                },
              });

              await writeLaborAuditLog(
                tx,
                assigneeUserId,
                prev ? Number(prev.hours) : null,
                0,
                prev ? Number(prev.paidHours ?? 0) : null,
                0,
                prev?.paymentStatus ?? null,
                AppealLaborPaymentStatus.NOT_REQUIRED
              );
            }
            return;
          }

          const processedAssigneeIds = new Set<number>();
          for (const item of bodyParsed.data.items) {
            processedAssigneeIds.add(item.assigneeUserId);
            const accruedHours = normalizeHourValue(
              Number(item.accruedHours ?? item.hours ?? 0)
            );
            const prev = prevByAssignee.get(item.assigneeUserId) ?? null;
            const previousPaidHours = normalizeHourValue(
              Number(
                prev?.paidHours ??
                  (prev?.paymentStatus === AppealLaborPaymentStatus.PAID ? prev?.hours : 0) ??
                  0
              )
            );
            let paidHours = item.paidHours != null
              ? normalizeHourValue(Number(item.paidHours))
              : resolveLegacyPaidHours({
                  accruedHours,
                  paymentStatus: item.paymentStatus,
                  previousPaidHours,
                });

            const effectiveHourlyRateRub = resolveEffectiveHourlyRate({
              departmentPaymentRequired: paymentRequired,
              departmentHourlyRate,
              assigneeHourlyRate: assigneeRateMap.get(item.assigneeUserId) ?? null,
            });
            const lockedEffectiveHourlyRateRub =
              prev?.effectiveHourlyRateRub == null || appeal.laborNotRequired
                ? effectiveHourlyRateRub
                : round2(Number(prev.effectiveHourlyRateRub));
            const payable = lockedEffectiveHourlyRateRub > 0;

            if (paidHours > accruedHours) {
              const err: any = new Error('Оплаченные часы не могут превышать начисленные');
              err.statusCode = 400;
              throw err;
            }
            paidHours = payable ? paidHours : 0;

            if (accruedHours <= 0 && paidHours <= 0) {
              if (prev) {
                await tx.appealLaborEntry.delete({
                  where: {
                    appealId_assigneeUserId: {
                      appealId: appeal.id,
                      assigneeUserId: item.assigneeUserId,
                    },
                  },
                });
              }
              await writeLaborAuditLog(
                tx,
                item.assigneeUserId,
                prev ? Number(prev.hours) : null,
                0,
                prev ? Number(prev.paidHours ?? 0) : null,
                0,
                prev?.paymentStatus ?? null,
                AppealLaborPaymentStatus.UNPAID
              );
              continue;
            }

            const paymentStatus = deriveLaborPaymentStatus({
              payable,
              accruedHours,
              paidHours,
            });
            const paidMeta =
              paymentStatus === AppealLaborPaymentStatus.PAID
                ? {
                    paidAt: prev?.paidAt ?? new Date(),
                    paidById: prev?.paidById ?? actingUser.id,
                  }
                : { paidAt: null, paidById: null as number | null };

            await tx.appealLaborEntry.upsert({
              where: {
                appealId_assigneeUserId: {
                  appealId: appeal.id,
                  assigneeUserId: item.assigneeUserId,
                },
              },
              update: {
                hours: new Prisma.Decimal(accruedHours),
                paidHours: new Prisma.Decimal(paidHours),
                effectiveHourlyRateRub: new Prisma.Decimal(lockedEffectiveHourlyRateRub),
                paymentStatus,
                ...paidMeta,
                updatedById: actingUser.id,
              },
              create: {
                appealId: appeal.id,
                assigneeUserId: item.assigneeUserId,
                hours: new Prisma.Decimal(accruedHours),
                paidHours: new Prisma.Decimal(paidHours),
                effectiveHourlyRateRub: new Prisma.Decimal(lockedEffectiveHourlyRateRub),
                paymentStatus,
                ...paidMeta,
                createdById: actingUser.id,
                updatedById: actingUser.id,
              },
            });

            await writeLaborAuditLog(
              tx,
              item.assigneeUserId,
              prev ? Number(prev.hours) : null,
              accruedHours,
              prev ? Number(prev.paidHours ?? 0) : null,
              paidHours,
              prev?.paymentStatus ?? null,
              paymentStatus
            );
          }

          for (const prev of currentEntries) {
            if (processedAssigneeIds.has(prev.assigneeUserId)) continue;
            await tx.appealLaborEntry.delete({
              where: {
                appealId_assigneeUserId: {
                  appealId: appeal.id,
                  assigneeUserId: prev.assigneeUserId,
                },
              },
            });
            await writeLaborAuditLog(
              tx,
              prev.assigneeUserId,
              Number(prev.hours),
              0,
              Number(prev.paidHours ?? 0),
              0,
              prev.paymentStatus,
              AppealLaborPaymentStatus.UNPAID
            );
          }
        });
      } catch (error: any) {
        if (error?.statusCode === 400) {
          return res.status(400).json(errorResponse(error.message, ErrorCodes.VALIDATION_ERROR));
        }
        throw error;
      }

      const laborEntries = await prisma.appealLaborEntry.findMany({
        where: { appealId: appeal.id },
        include: {
          assignee: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              employeeProfile: { select: { appealLaborHourlyRate: true } },
            },
          },
          paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { assigneeUserId: 'asc' },
      });

      return res.json(
        successResponse(
          {
            appealId: appeal.id,
            paymentRequired,
            laborNotRequired,
            currency: 'RUB' as const,
            laborEntries: laborEntries.map((entry) =>
              mapLaborEntryDto(entry, {
                departmentPaymentRequired: paymentRequired,
                departmentHourlyRate,
                appealLaborNotRequired: laborNotRequired,
              })
            ),
          },
          'Часы и статус оплаты обновлены'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/:id/labor:', error);
      return res.status(500).json(errorResponse('Ошибка сохранения трудозатрат', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/sla-dashboard',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsSlaDashboardResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsCommonQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId } = parsed.data;
      const where: Prisma.AppealWhereInput = {
        toDepartmentId: roleFlags.isAdmin
          ? (departmentId ? departmentId : undefined)
          : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
      };
      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) where.createdAt.gte = new Date(fromDate);
        if (toDate) where.createdAt.lte = new Date(toDate);
      }

      const appeals = await prisma.appeal.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          statusHistory: { orderBy: { changedAt: 'asc' }, select: { newStatus: true, changedAt: true } },
        },
      });

      const openToInProgress: number[] = [];
      const inProgressToResolved: number[] = [];
      const resolvedToCompleted: number[] = [];
      for (const appeal of appeals) {
        const firstInProgress = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.IN_PROGRESS);
        const firstResolved = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.RESOLVED);
        const firstCompleted = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.COMPLETED);
        if (firstInProgress) openToInProgress.push(Math.max(0, firstInProgress.changedAt.getTime() - appeal.createdAt.getTime()));
        if (firstInProgress && firstResolved) inProgressToResolved.push(Math.max(0, firstResolved.changedAt.getTime() - firstInProgress.changedAt.getTime()));
        if (firstResolved && firstCompleted) resolvedToCompleted.push(Math.max(0, firstCompleted.changedAt.getTime() - firstResolved.changedAt.getTime()));
      }

      const pack = (key: 'OPEN_TO_IN_PROGRESS' | 'IN_PROGRESS_TO_RESOLVED' | 'RESOLVED_TO_COMPLETED', values: number[]) => ({
        key,
        count: values.length,
        avgMs: avg(values),
        p50Ms: percentile(values, 50),
        p90Ms: percentile(values, 90),
      });

      return res.json(successResponse({ transitions: [
        pack('OPEN_TO_IN_PROGRESS', openToInProgress),
        pack('IN_PROGRESS_TO_RESOLVED', inProgressToResolved),
        pack('RESOLVED_TO_COMPLETED', resolvedToCompleted),
      ] }, 'SLA KPI загружены'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/sla-dashboard:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки SLA KPI', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/kpi-dashboard',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsKpiDashboardResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsKpiDashboardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }

      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, assigneeUserId, status, paymentState, search } = parsed.data;
      if (!roleFlags.isAdmin && departmentId && !managedDepartmentIds.includes(departmentId)) {
        return res.status(403).json(errorResponse('Нет доступа к отделу', ErrorCodes.FORBIDDEN));
      }

      const where = buildAnalyticsAppealsWhere({
        roleFlags,
        managedDepartmentIds,
        departmentId,
        fromDate,
        toDate,
        assigneeUserId,
        status,
        paymentState,
        search,
      });

      const appeals = await prisma.appeal.findMany({
        where,
        select: {
          id: true,
          status: true,
          laborNotRequired: true,
          createdAt: true,
          toDepartment: { select: { appealPaymentRequired: true, appealLaborHourlyRate: true } },
          statusHistory: { select: { oldStatus: true, newStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          laborEntries: {
            include: {
              assignee: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  employeeProfile: { select: { appealLaborHourlyRate: true } },
                },
              },
              paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          },
        },
      });

      let openCount = 0;
      let inProgressCount = 0;
      let completedCount = 0;
      let resolvedCount = 0;
      let declinedCount = 0;

      const takeValues: number[] = [];
      const executionValues: number[] = [];

      let totalAccruedHours = 0;
      let totalPaidHours = 0;
      let totalRemainingHours = 0;
      let totalNotRequiredHours = 0;
      let totalAccruedAmountRub = 0;
      let totalPaidAmountRub = 0;
      let totalRemainingAmountRub = 0;

      const now = new Date();
      for (const appeal of appeals) {
        if (appeal.status === AppealStatus.OPEN) openCount += 1;
        if (appeal.status === AppealStatus.IN_PROGRESS) inProgressCount += 1;
        if (appeal.status === AppealStatus.COMPLETED) completedCount += 1;
        if (appeal.status === AppealStatus.RESOLVED) resolvedCount += 1;
        if (appeal.status === AppealStatus.DECLINED) declinedCount += 1;

        const sla = calculateAppealSla(
          appeal.createdAt,
          appeal.status,
          (appeal.statusHistory || []).map((h) => ({
            oldStatus: h.oldStatus,
            newStatus: h.newStatus,
            changedAt: h.changedAt,
          })),
          now
        );
        if (sla.timeToFirstInProgressMs != null) takeValues.push(sla.timeToFirstInProgressMs);
        if (sla.workDurationMs > 0) executionValues.push(sla.workDurationMs);

        for (const entry of appeal.laborEntries || []) {
          const dto = mapLaborEntryDto(entry, {
            departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
            departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
            appealLaborNotRequired: appeal.laborNotRequired,
          });
          if (dto.payable) {
            totalAccruedHours += dto.accruedHours;
            totalPaidHours += dto.paidHours;
            totalRemainingHours += dto.remainingHours;
            totalAccruedAmountRub += dto.amountAccruedRub;
            totalPaidAmountRub += dto.amountPaidRub;
            totalRemainingAmountRub += dto.amountRemainingRub;
          } else {
            totalNotRequiredHours += dto.accruedHours;
          }
        }
      }

      return res.json(
        successResponse(
          {
            appeals: {
              totalCount: appeals.length,
              openCount,
              inProgressCount,
              completedCount,
              resolvedCount,
              declinedCount,
            },
            timing: {
              avgTakeMs: avg(takeValues),
              avgExecutionMs: avg(executionValues),
              takeCount: takeValues.length,
              executionCount: executionValues.length,
            },
            labor: {
              totalAccruedHours: round2(totalAccruedHours),
              totalPaidHours: round2(totalPaidHours),
              totalRemainingHours: round2(totalRemainingHours),
              totalNotRequiredHours: round2(totalNotRequiredHours),
              totalAccruedAmountRub: round2(totalAccruedAmountRub),
              totalPaidAmountRub: round2(totalPaidAmountRub),
              totalRemainingAmountRub: round2(totalRemainingAmountRub),
              currency: 'RUB' as const,
            },
          },
          'KPI dashboard загружен'
        )
      );
    } catch (error) {
      console.error('Ошибка /appeals/analytics/kpi-dashboard:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки KPI dashboard', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/payment-queue',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsPaymentQueueResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsCommonQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, assigneeUserId } = parsed.data;

      const entries = await prisma.appealLaborEntry.findMany({
        where: {
          assigneeUserId: assigneeUserId || undefined,
          paymentStatus: {
            in: [
              AppealLaborPaymentStatus.UNPAID,
              AppealLaborPaymentStatus.PARTIAL,
              AppealLaborPaymentStatus.PAID,
            ],
          },
          appeal: {
            toDepartmentId: roleFlags.isAdmin
              ? (departmentId ? departmentId : undefined)
              : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
            ...(fromDate || toDate
              ? {
                  createdAt: {
                    ...(fromDate ? { gte: new Date(fromDate) } : {}),
                    ...(toDate ? { lte: new Date(toDate) } : {}),
                  },
                }
              : {}),
          },
        },
        include: {
          assignee: {
            select: {
              id: true, email: true, firstName: true, lastName: true,
              employeeProfile: { select: { department: { select: { id: true, name: true } } } },
            },
          },
          appeal: {
            select: {
              id: true,
              number: true,
              laborNotRequired: true,
              toDepartment: { select: { id: true, name: true, appealPaymentRequired: true } },
              laborEntries: { select: { paymentStatus: true } },
            },
          },
        },
      });

      const grouped = new Map<number, any>();
      for (const entry of entries) {
        const assigneeId = entry.assigneeUserId;
        if (!grouped.has(assigneeId)) {
          grouped.set(assigneeId, {
            assignee: {
              id: entry.assignee.id,
              email: entry.assignee.email,
              firstName: entry.assignee.firstName,
              lastName: entry.assignee.lastName,
              department: entry.assignee.employeeProfile?.department ?? null,
            },
            departments: new Map<number, any>(),
            totalHours: 0,
          });
        }
        const row = grouped.get(assigneeId);
        if (!row.departments.has(entry.appeal.toDepartment.id)) {
          row.departments.set(entry.appeal.toDepartment.id, {
            id: entry.appeal.toDepartment.id,
            name: entry.appeal.toDepartment.name,
            items: [],
            totalHours: 0,
          });
        }
        const financialStatus = resolveFinancialFunnelStatus({
          paymentRequired: entry.appeal.toDepartment.appealPaymentRequired,
          laborNotRequired: entry.appeal.laborNotRequired,
          statuses: entry.appeal.laborEntries.map((x) => x.paymentStatus),
        });
        const dep = row.departments.get(entry.appeal.toDepartment.id);
        dep.items.push({
          appealId: entry.appealId,
          appealNumber: entry.appeal.number,
          hours: Number(entry.hours),
          paymentStatus: entry.paymentStatus,
          financialStatus,
        });
        dep.totalHours += Number(entry.hours);
        row.totalHours += Number(entry.hours);
      }

      const data = Array.from(grouped.values()).map((row) => ({
        assignee: row.assignee,
        departments: Array.from(row.departments.values()),
        totalHours: Number(row.totalHours.toFixed(2)),
      }));
      const totalItems = data.reduce((acc, row) => acc + row.departments.reduce((a: number, d: any) => a + d.items.length, 0), 0);
      return res.json(successResponse({ data, meta: { totalItems } }, 'Очередь выплат загружена'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/payment-queue:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки очереди выплат', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/analytics/payment-queue/mark-paid',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_labor']),
  async (req: AuthRequest<{}, AppealsPaymentQueueMarkPaidResponse>, res: express.Response) => {
    try {
      const parsed = PaymentQueueMarkPaidBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const actingUser = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!actingUser) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));

      let updated = 0;
      await prisma.$transaction(async (tx) => {
        for (const item of parsed.data.items) {
          const entry = await tx.appealLaborEntry.findUnique({
            where: { appealId_assigneeUserId: { appealId: item.appealId, assigneeUserId: item.assigneeUserId } },
            include: { appeal: { include: { toDepartment: true } } },
          });
          if (!entry) continue;
          const canManage = isAdminRole(actingUser as UserMiniRaw) || isDepartmentManager(actingUser as UserMiniRaw, entry.appeal.toDepartmentId);
          if (!canManage) continue;
          if (!entry.appeal.toDepartment.appealPaymentRequired || entry.paymentStatus === AppealLaborPaymentStatus.NOT_REQUIRED) continue;
          if (entry.paymentStatus === AppealLaborPaymentStatus.PAID) continue;

          await tx.appealLaborEntry.update({
            where: { id: entry.id },
            data: {
              paidHours: entry.hours,
              paymentStatus: AppealLaborPaymentStatus.PAID,
              paidAt: new Date(),
              paidById: actingUser.id,
              updatedById: actingUser.id,
            },
          });
          await (tx as any).appealLaborAuditLog.create({
            data: {
              appealId: entry.appealId,
              assigneeUserId: entry.assigneeUserId,
              changedById: actingUser.id,
              oldHours: entry.hours,
              newHours: entry.hours,
              oldPaidHours: entry.paidHours,
              newPaidHours: entry.hours,
              oldPaymentStatus: entry.paymentStatus,
              newPaymentStatus: AppealLaborPaymentStatus.PAID,
            },
          });
          updated += 1;
        }
      });
      return res.json(successResponse({ updated }, 'Статусы оплаты обновлены'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/payment-queue/mark-paid:', error);
      return res.status(500).json(errorResponse('Ошибка массового обновления оплаты', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/labor-audit',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealLaborAuditLogResponse>, res: express.Response) => {
    try {
      const parsed = LaborAuditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, assigneeUserId, appealId, limit, offset } = parsed.data;
      const where: any = {
        assigneeUserId: assigneeUserId || undefined,
        appealId: appealId || undefined,
        changedAt: fromDate || toDate ? {
          ...(fromDate ? { gte: new Date(fromDate) } : {}),
          ...(toDate ? { lte: new Date(toDate) } : {}),
        } : undefined,
        appeal: {
          toDepartmentId: roleFlags.isAdmin
            ? (departmentId ? departmentId : undefined)
            : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
        },
      };
      const [total, rows] = await prisma.$transaction([
        (prisma as any).appealLaborAuditLog.count({ where }),
        (prisma as any).appealLaborAuditLog.findMany({
          where,
          orderBy: { changedAt: 'desc' },
          skip: offset,
          take: limit,
          include: {
            changedBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          },
        }),
      ]);
      return res.json(successResponse({
        data: rows.map((r: any) => ({
          id: r.id,
          appealId: r.appealId,
          assigneeUserId: r.assigneeUserId,
          changedBy: r.changedBy,
          oldHours: r.oldHours == null ? null : Number(r.oldHours),
          newHours: Number(r.newHours),
          oldPaidHours: r.oldPaidHours == null ? null : Number(r.oldPaidHours),
          newPaidHours: r.newPaidHours == null ? null : Number(r.newPaidHours),
          oldPaymentStatus: r.oldPaymentStatus,
          newPaymentStatus: r.newPaymentStatus,
          changedAt: r.changedAt,
        })),
        meta: { total, limit, offset, hasMore: offset + rows.length < total },
      }, 'История изменений загружена'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/labor-audit:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки истории изменений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/funnel',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsFunnelResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsCommonQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId } = parsed.data;
      const appeals = await prisma.appeal.findMany({
        where: {
          toDepartmentId: roleFlags.isAdmin
            ? (departmentId ? departmentId : undefined)
            : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: new Date(fromDate) } : {}),
                  ...(toDate ? { lte: new Date(toDate) } : {}),
                },
              }
            : {}),
        },
        select: {
          id: true,
          laborNotRequired: true,
          toDepartment: { select: { appealPaymentRequired: true } },
          laborEntries: { select: { paymentStatus: true } },
        },
      });
      const counts = new Map<string, number>([
        ['NOT_PAYABLE', 0], ['TO_PAY', 0], ['PARTIAL', 0], ['PAID', 0],
      ]);
      for (const a of appeals) {
        const status = resolveFinancialFunnelStatus({
          paymentRequired: a.toDepartment.appealPaymentRequired,
          laborNotRequired: a.laborNotRequired,
          statuses: a.laborEntries.map((x) => x.paymentStatus),
        });
        counts.set(status, (counts.get(status) || 0) + 1);
      }
      return res.json(successResponse({
        byStatus: Array.from(counts.entries()).map(([status, count]) => ({ status: status as any, count })),
      }, 'Финансовая воронка загружена'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/funnel:', error);
      return res.status(500).json(errorResponse('Ошибка расчета воронки', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/heatmap',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsHeatmapResponse>, res: express.Response) => {
    try {
      const parsed = AnalyticsCommonQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, assigneeUserId } = parsed.data;
      const laborRows = await prisma.appealLaborEntry.findMany({
        where: {
          assigneeUserId: assigneeUserId || undefined,
          appeal: {
            toDepartmentId: roleFlags.isAdmin
              ? (departmentId ? departmentId : undefined)
              : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
            ...(fromDate || toDate
              ? {
                  createdAt: {
                    ...(fromDate ? { gte: new Date(fromDate) } : {}),
                    ...(toDate ? { lte: new Date(toDate) } : {}),
                  },
                }
              : {}),
          },
        },
        include: {
          assignee: {
            select: {
              id: true, email: true, firstName: true, lastName: true,
              employeeProfile: { select: { department: { select: { id: true, name: true } } } },
            },
          },
          appeal: { select: { createdAt: true } },
        },
      });
      const grouped = new Map<number, any>();
      for (const row of laborRows) {
        if (!grouped.has(row.assigneeUserId)) {
          grouped.set(row.assigneeUserId, {
            user: {
              id: row.assignee.id,
              email: row.assignee.email,
              firstName: row.assignee.firstName,
              lastName: row.assignee.lastName,
              department: row.assignee.employeeProfile?.department ?? null,
            },
            cells: new Map<string, { date: string; totalHours: number; appealsCount: number }>(),
          });
        }
        const date = toIsoDate(row.appeal.createdAt);
        const u = grouped.get(row.assigneeUserId);
        if (!u.cells.has(date)) u.cells.set(date, { date, totalHours: 0, appealsCount: 0 });
        const cell = u.cells.get(date);
        cell.totalHours += Number(row.hours);
        cell.appealsCount += 1;
      }
      return res.json(successResponse({
        data: Array.from(grouped.values()).map((u) => ({
          user: u.user,
          cells: Array.from(u.cells.values()).map((c: any) => ({ ...c, totalHours: Number(c.totalHours.toFixed(2)) })),
        })),
      }, 'Heatmap загружен'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/heatmap:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки heatmap', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/forecast',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest<{}, AppealsForecastResponse>, res: express.Response) => {
    try {
      const parsed = ForecastQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      if (!roleFlags.isAdmin && !roleFlags.isDepartmentManager) {
        return res.status(403).json(errorResponse('Нет доступа к аналитике', ErrorCodes.FORBIDDEN));
      }
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const { departmentId, horizon } = parsed.data;
      const today = new Date();
      const remainingDays = horizon === 'month'
        ? new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate()
        : (7 - ((today.getDay() + 6) % 7) - 1);
      const lookbackDays = 30;
      const lookbackFrom = new Date(Date.now() - lookbackDays * 24 * 3600_000);
      const departments = await prisma.department.findMany({
        where: roleFlags.isAdmin
          ? (departmentId ? { id: departmentId } : undefined)
          : { id: { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] } },
        select: { id: true, name: true, appealLaborHourlyRate: true } as any,
      });
      const data = [];
      for (const dep of departments) {
        const depId = Number((dep as any).id);
        const rows = await prisma.appealLaborEntry.findMany({
          where: {
            appeal: { toDepartmentId: depId, createdAt: { gte: lookbackFrom, lte: today } },
          },
          select: { hours: true },
        });
        const totalHours = rows.reduce((acc, r) => acc + Number(r.hours), 0);
        const avgDailyHours = totalHours / lookbackDays;
        const expectedHours = Number((avgDailyHours * Math.max(0, remainingDays)).toFixed(2));
        const rate = Number((dep as any).appealLaborHourlyRate ?? 1);
        const expectedPayout = Number((expectedHours * rate).toFixed(2));
        data.push({
          id: depId,
          name: (dep as any).name,
          expectedHours,
          expectedPayout,
          formula: `expectedHours = (hours_${lookbackDays}d / ${lookbackDays}) * remainingDays; expectedPayout = expectedHours * hourlyRate`,
        });
      }
      return res.json(successResponse({
        horizon,
        generatedAt: today,
        lookbackDays,
        remainingDays: Math.max(0, remainingDays),
        departments: data,
      }, 'Прогноз рассчитан'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/forecast:', error);
      return res.status(500).json(errorResponse('Ошибка расчета прогноза', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/thresholds',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeals_analytics']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const data = await (prisma as any).appealAnalyticsThreshold.findMany({
        where: isAdminRole(user as UserMiniRaw) ? undefined : { departmentId: { in: managedDepartmentIds.length ? managedDepartmentIds : [-1] } },
        include: { department: { select: { id: true, name: true } } },
      });
      return res.json(successResponse({ data }, 'Пороги уведомлений загружены'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/thresholds:', error);
      return res.status(500).json(errorResponse('Ошибка загрузки порогов', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/analytics/thresholds',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_labor']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const schema = z.object({
        departmentId: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().positive()),
        openTooLongHours: z.number().int().min(1).max(720),
        resolvedTooLongHours: z.number().int().min(1).max(720),
        laborMissingDays: z.number().int().min(1).max(90),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      if (!isAdminRole(user as UserMiniRaw) && !isDepartmentManager(user as UserMiniRaw, parsed.data.departmentId)) {
        return res.status(403).json(errorResponse('Нет доступа к отделу', ErrorCodes.FORBIDDEN));
      }
      const item = await (prisma as any).appealAnalyticsThreshold.upsert({
        where: { departmentId: parsed.data.departmentId },
        update: {
          openTooLongHours: parsed.data.openTooLongHours,
          resolvedTooLongHours: parsed.data.resolvedTooLongHours,
          laborMissingDays: parsed.data.laborMissingDays,
        },
        create: parsed.data,
      });
      return res.json(successResponse({ item }, 'Пороги уведомлений обновлены'));
    } catch (error) {
      console.error('Ошибка /appeals/analytics/thresholds PUT:', error);
      return res.status(500).json(errorResponse('Ошибка сохранения порогов', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/export/appeals',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['export_appeals']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const parsed = AnalyticsExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, userId, assigneeUserId, status, paymentState, search, format, columns } = parsed.data;
      const effectiveAssigneeId = assigneeUserId || undefined;
      const selectedColumns = columns?.length
        ? ANALYTICS_EXPORT_COLUMN_ORDER.filter((key) => columns.includes(key))
        : [...ANALYTICS_EXPORT_COLUMN_ORDER];

      const where: Prisma.AppealWhereInput = buildAnalyticsAppealsWhere({
        roleFlags,
        managedDepartmentIds,
        departmentId,
        fromDate,
        toDate,
        assigneeUserId: effectiveAssigneeId,
        status,
        paymentState,
        search,
      });
      if (!effectiveAssigneeId && userId) {
        const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
        where.AND = [
          ...existingAnd,
          { laborEntries: { some: { assigneeUserId: userId } } },
        ];
      }

      const rows = await prisma.appeal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          fromDepartment: { select: { id: true, name: true } },
          toDepartment: { select: { name: true, appealPaymentRequired: true, appealLaborHourlyRate: true } },
          assignees: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  employeeProfile: { select: { appealLaborHourlyRate: true } },
                },
              },
            },
          },
          statusHistory: { select: { oldStatus: true, newStatus: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          laborEntries: {
            include: {
              assignee: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  employeeProfile: { select: { appealLaborHourlyRate: true } },
                },
              },
              paidBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
            orderBy: { assigneeUserId: 'asc' },
          },
        },
      });
      const now = new Date();
      const rawRows = rows.map((appeal) => {
        const completedAt = appeal.statusHistory.find((h) => h.newStatus === AppealStatus.COMPLETED)?.changedAt ?? null;
        const sla = calculateAppealSla(
          appeal.createdAt,
          appeal.status,
          appeal.statusHistory.map((h) => ({ oldStatus: h.oldStatus, newStatus: h.newStatus, changedAt: h.changedAt })),
          now
        );
        const assignees = (appeal.assignees || []).map((a) => ({
          id: a.user.id,
          email: a.user.email,
          firstName: a.user.firstName,
          lastName: a.user.lastName,
          effectiveHourlyRateRub: resolveEffectiveHourlyRate({
            departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
            departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
            assigneeHourlyRate:
              a.user.employeeProfile?.appealLaborHourlyRate == null
                ? null
                : Number(a.user.employeeProfile.appealLaborHourlyRate),
          }),
        }));
        const laborEntries = (appeal.laborEntries || []).map((entry) =>
          mapLaborEntryDto(entry, {
            departmentPaymentRequired: appeal.toDepartment.appealPaymentRequired,
            departmentHourlyRate: Number(appeal.toDepartment.appealLaborHourlyRate || 0),
            appealLaborNotRequired: appeal.laborNotRequired,
          })
        );
        const laborColumns = buildLaborColumnsForExcelFriendlyExport({
          assignees,
          laborNotRequired: appeal.laborNotRequired,
          laborEntries,
        });
        return {
          number: `#${appeal.number}`,
          title: appeal.title || 'Без названия',
          createdBy: getUserDisplayName(appeal.createdBy as UserMiniRaw | null),
          status: appealStatusLabelForExport(appeal.status),
          department: appeal.toDepartment.name,
          departmentRoute: `${appeal.fromDepartment?.name || 'Без отдела'} -> ${appeal.toDepartment.name}`,
          deadline: formatAnalyticsDeadlineForExport({
            status: appeal.status,
            deadline: appeal.deadline,
            completedAt,
            now,
          }),
          slaOpen: formatHoursByMsForExcelExport(sla.openDurationMs),
          slaWork: formatHoursByMsForExcelExport(sla.workDurationMs),
          slaToTake: formatHoursByMsForExcelExport(sla.timeToFirstInProgressMs),
          slaToResolve: formatHoursByMsForExcelExport(sla.timeToFirstResolvedMs),
          ...laborColumns,
        };
      });
      const flat = rawRows.map((row) => {
        const out: Record<string, ExportCellValue> = {};
        for (const key of selectedColumns) {
          out[ANALYTICS_EXPORT_COLUMN_HEADERS[key]] = (row as any)[key] ?? '';
        }
        return out;
      });
      const parser = new Parser({
        fields: selectedColumns.map((key) => ANALYTICS_EXPORT_COLUMN_HEADERS[key]),
      });
      const csv = parser.parse(flat);
      const ext = format === 'xlsx' ? 'xlsx' : 'csv';
      res.setHeader('Content-Disposition', `attachment; filename=\"appeals_analytics_${Date.now()}.${ext}\"`);
      if (format === 'xlsx') {
        const xlsx = await buildXlsxBuffer(
          'Appeals',
          flat,
          undefined,
          Object.fromEntries(
            selectedColumns.map((key) => [ANALYTICS_EXPORT_COLUMN_HEADERS[key], APPEALS_EXPORT_COLUMN_FORMATS[key]])
          )
        );
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.status(200).send(xlsx);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(csv);
    } catch (error) {
      console.error('Ошибка /appeals/analytics/export/appeals:', error);
      return res.status(500).json(errorResponse('Ошибка экспорта по обращениям', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.get(
  '/analytics/export/users',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['export_appeals']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const parsed = AnalyticsExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: userMiniSelect });
      if (!user) return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      const managedDepartmentIds = await getManagedDepartmentIds(user as UserMiniRaw);
      const roleFlags = toRoleFlags(user as UserMiniRaw);
      const { fromDate, toDate, departmentId, userId, assigneeUserId, status, search, format } = parsed.data;
      const effectiveAssigneeId = assigneeUserId || userId || undefined;
      const searchNumber = search ? Number(search) : NaN;
      const statusMatchesBySearch = search ? resolveStatusMatchesFromSearch(search) : [];
      const rows = await prisma.appealLaborEntry.findMany({
        where: {
          assigneeUserId: effectiveAssigneeId,
          ...(search
            ? {
                OR: [
                  { assignee: { firstName: { contains: search, mode: 'insensitive' } } },
                  { assignee: { lastName: { contains: search, mode: 'insensitive' } } },
                  { assignee: { email: { contains: search, mode: 'insensitive' } } },
                  ...(Number.isInteger(searchNumber) && searchNumber > 0 ? [{ appeal: { number: searchNumber } }] : []),
                  { appeal: { title: { contains: search, mode: 'insensitive' } } },
                  { appeal: { toDepartment: { name: { contains: search, mode: 'insensitive' } } } },
                  ...(statusMatchesBySearch.length ? [{ appeal: { status: { in: statusMatchesBySearch } } }] : []),
                ],
              }
            : {}),
          appeal: {
            toDepartmentId: roleFlags.isAdmin
              ? (departmentId ? departmentId : undefined)
              : { in: departmentId ? [departmentId] : managedDepartmentIds.length ? managedDepartmentIds : [-1] },
            ...(status ? { status } : {}),
            ...(fromDate || toDate ? { createdAt: { ...(fromDate ? { gte: new Date(fromDate) } : {}), ...(toDate ? { lte: new Date(toDate) } : {}) } } : {}),
          },
        },
        include: {
          assignee: { select: { id: true, email: true, firstName: true, lastName: true } },
          appeal: { select: { toDepartment: { select: { name: true } }, number: true } },
        },
      });
      const flat = rows.map((r) => ({
        userId: r.assignee.id,
        user: [r.assignee.firstName, r.assignee.lastName].filter(Boolean).join(' ').trim() || r.assignee.email,
        department: r.appeal.toDepartment.name,
        appealNumber: r.appeal.number,
        hours: Number(r.hours),
        paymentStatus: r.paymentStatus,
      }));
      const totalHours = flat.reduce((acc, r) => acc + r.hours, 0);
      const parser = new Parser({ fields: ['userId', 'user', 'department', 'appealNumber', 'hours', 'paymentStatus'] });
      const csv = `${parser.parse(flat)}\nTOTAL,,,,${totalHours.toFixed(2)},`;
      const ext = format === 'xlsx' ? 'xlsx' : 'csv';
      res.setHeader('Content-Disposition', `attachment; filename=\"users_analytics_${Date.now()}.${ext}\"`);
      if (format === 'xlsx') {
        const xlsx = await buildXlsxBuffer('Users', flat, {
          userId: 'TOTAL',
          user: '',
          department: '',
          appealNumber: '',
          hours: Number(totalHours.toFixed(2)),
          paymentStatus: '',
        }, USERS_EXPORT_COLUMN_FORMATS);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return res.status(200).send(xlsx);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.status(200).send(csv);
    } catch (error) {
      console.error('Ошибка /appeals/analytics/export/users:', error);
      return res.status(500).json(errorResponse('Ошибка экспорта по исполнителям', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}:
 *   get:
 *     tags: [Appeals]
 *     summary: Детали обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
  router.get(
    '/:id',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
  async (req: AuthRequest<{ id: string }, AppealDetailResponse>, res: express.Response) => {
    try {
      const parsed = IdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = parsed.data;

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          fromDepartment: true,
          toDepartment: true,
          createdBy: { select: userMiniSelect },
          assignees: { include: { user: { select: userMiniSelect } } },
          watchers: { include: { user: { select: userMiniSelect } } },
          statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: userMiniSelect } } },
          messages: {
            where: { deleted: false },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 30,
            include: {
              sender: { select: userMiniSelect },
              attachments: true,
              reads: { select: { userId: true, readAt: true } },
            },
          },
        },
      });

      if (!appeal) {
        return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const actor = await loadUserMini(userId);
      if (!actor) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a: any) => a.userId === userId);
      const isAdmin = isAdminRole(actor as UserMiniRaw);
      const isManager = isDepartmentManager(actor as UserMiniRaw, appeal.toDepartmentId);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee && !isManager && !isAdmin) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      const mappedAppeal = {
        ...appeal,
        createdBy: await mapUserMini(appeal.createdBy as UserMiniRaw),
        assignees: await Promise.all(
          (appeal.assignees || []).map(async (as: any) => ({
            user: await mapUserMini(as.user as UserMiniRaw),
          }))
        ),
        watchers: await Promise.all(
          (appeal.watchers || []).map(async (w: any) => ({
            user: await mapUserMini(w.user as UserMiniRaw),
          }))
        ),
        statusHistory: await Promise.all(
          (appeal.statusHistory || []).map(async (h: any) => ({
            ...h,
            changedBy: await mapUserMini(h.changedBy as UserMiniRaw),
          }))
        ),
        messages: await Promise.all(
          [...appeal.messages].reverse().map((m) =>
            mapMessageWithReads(m as MessageWithRelations, userId)
          )
        ),
      };

      return res.json(successResponse(mappedAppeal, 'Детали обращения'));
    } catch (error) {
      console.error('Ошибка получения обращения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка получения обращения', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

  /**
   * @openapi
   * /appeals/{id}/messages:
   *   get:
   *     tags: [Appeals]
   *     summary: Получить сообщения обращения (пагинация)
   *     security: [ { bearerAuth: [] } ]
   *     x-permissions: ["view_appeal"]
   */
  router.get(
    '/:id/messages',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
    async (req: AuthRequest<{ id: string }, AppealMessagesResponse>, res: express.Response) => {
      try {
        const p = IdParamSchema.safeParse(req.params);
        if (!p.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
        }
        const q = MessagesQuerySchema.safeParse(req.query);
        if (!q.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(q.error), ErrorCodes.VALIDATION_ERROR));
        }

        const { id: appealId } = p.data;
        const {
          limit,
          cursor,
          direction = 'before',
          mode = 'page',
          anchor,
          before,
          after,
        } = q.data as {
          limit: number;
          cursor?: string;
          direction?: 'before' | 'after';
          mode?: 'page' | 'bootstrap';
          anchor?: 'first_unread' | 'last_unread';
          before?: number;
          after?: number;
        };
        const parsedCursor = decodeMessageCursor(cursor);
        if (cursor && !parsedCursor) {
          return res
            .status(400)
            .json(errorResponse('Некорректный cursor', ErrorCodes.VALIDATION_ERROR));
        }

        const appeal = await prisma.appeal.findUnique({
          where: { id: appealId },
          include: {
            assignees: { select: { userId: true } },
          },
        });
        if (!appeal) {
          return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
        }

        const userId = req.user!.userId;
        const actor = await loadUserMini(userId);
        if (!actor) {
          return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
        }
        const isCreator = appeal.createdById === userId;
        const isAssignee = appeal.assignees.some((a) => a.userId === userId);
        const isAdmin = isAdminRole(actor as UserMiniRaw);
        const employee = await prisma.employeeProfile.findFirst({
          where: { userId, departmentId: appeal.toDepartmentId },
        });

        if (!isCreator && !isAssignee && !employee && !isAdmin) {
          return res
            .status(403)
            .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
        }

        let ordered: any[] = [];
        let hasMoreBefore = false;
        let hasMoreAfter = false;
        let prevCursor: string | null = null;
        let nextCursor: string | null = null;
        let anchorMessageId: number | null = null;

        if (mode === 'bootstrap') {
          const beforeTake = before ?? 40;
          const afterTake = after ?? 20;
          let firstUnread: { id: number; createdAt: Date } | null = null;

          if (anchor === 'first_unread' || anchor === 'last_unread') {
            firstUnread = await prisma.appealMessage.findFirst({
              where: {
                appealId,
                deleted: false,
                senderId: { not: userId },
                reads: { none: { userId } },
              },
              orderBy:
                anchor === 'last_unread'
                  ? [{ createdAt: 'desc' }, { id: 'desc' }]
                  : [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, createdAt: true },
            });
          }

          if (firstUnread) {
            anchorMessageId = firstUnread.id;
            const olderRaw = await prisma.appealMessage.findMany({
              where: {
                appealId,
                deleted: false,
                OR: [
                  { createdAt: { lt: firstUnread.createdAt } },
                  { createdAt: firstUnread.createdAt, id: { lt: firstUnread.id } },
                ],
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: beforeTake + 1,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            const olderPage = olderRaw.slice(0, beforeTake);
            hasMoreBefore = olderRaw.length > beforeTake;

            const newerRaw = await prisma.appealMessage.findMany({
              where: {
                appealId,
                deleted: false,
                OR: [
                  { createdAt: { gt: firstUnread.createdAt } },
                  { createdAt: firstUnread.createdAt, id: { gte: firstUnread.id } },
                ],
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: afterTake + 2,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            const newerPage = newerRaw.slice(0, afterTake + 1);
            hasMoreAfter = newerRaw.length > afterTake + 1;

            ordered = [...olderPage.reverse(), ...newerPage];
          } else {
            const raw = await prisma.appealMessage.findMany({
              where: { appealId, deleted: false },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit + 1,
              include: {
                sender: { select: userMiniSelect },
                attachments: true,
                reads: { select: { userId: true, readAt: true } },
              },
            });
            hasMoreBefore = raw.length > limit;
            ordered = raw.slice(0, limit).reverse();
          }
        } else {
          const where = buildMessageCursorWhere({
            appealId,
            parsedCursor,
            direction,
          });
          const raw = await prisma.appealMessage.findMany({
            where,
            orderBy:
              direction === 'before'
                ? [{ createdAt: 'desc' }, { id: 'desc' }]
                : [{ createdAt: 'asc' }, { id: 'asc' }],
            take: limit + 1,
            include: {
              sender: { select: userMiniSelect },
              attachments: true,
              reads: { select: { userId: true, readAt: true } },
            },
          });

          const hasMore = raw.length > limit;
          const page = raw.slice(0, limit);
          ordered = direction === 'before' ? page.reverse() : page;
          if (direction === 'before') {
            hasMoreBefore = hasMore;
            hasMoreAfter = !!parsedCursor;
          } else {
            hasMoreAfter = hasMore;
            hasMoreBefore = !!parsedCursor;
          }
        }

        if (ordered.length) {
          prevCursor = encodeMessageCursor(ordered[0].createdAt as Date, ordered[0].id);
          nextCursor = encodeMessageCursor(
            ordered[ordered.length - 1].createdAt as Date,
            ordered[ordered.length - 1].id
          );
        }

        const mapped = await Promise.all(
          ordered.map((m) => mapMessageWithReads(m as MessageWithRelations, userId))
        );
        const compatHasMore = direction === 'after' ? hasMoreAfter : hasMoreBefore;
        const compatNextCursor = direction === 'after' ? nextCursor : prevCursor;

        return res.json(
          successResponse(
            {
              data: mapped,
              meta: {
                hasMore: compatHasMore,
                nextCursor: compatNextCursor,
                hasMoreBefore,
                prevCursor,
                hasMoreAfter,
                anchorMessageId,
              },
            },
            'Сообщения обращения'
          )
        );
      } catch (error) {
        console.error('Ошибка получения сообщений обращения:', error);
        return res
          .status(500)
          .json(errorResponse('Ошибка получения сообщений обращения', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

/**
 * @openapi
 * /appeals/{id}/assign:
 *   put:
 *     tags: [Appeals]
 *     summary: Назначить исполнителей обращению
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["assign_appeal"]
 */
router.put(
  '/:id/assign',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['assign_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealAssignResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = AssignBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { assigneeIds } = b.data as { assigneeIds: number[] };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      const actorId = req.user!.userId;
      const actorName = getUserDisplayName(actor);

      const canAssign = isAdminRole(actor) || isDepartmentManager(actor, appeal.toDepartmentId);
      if (!canAssign) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на назначение исполнителей', ErrorCodes.FORBIDDEN));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const nextAssignees = Array.from(new Set(assigneeIds || []));
      const prevSet = new Set(prevAssignees);
      const nextSet = new Set(nextAssignees);
      const added = nextAssignees.filter((id) => !prevSet.has(id));
      const removed = prevAssignees.filter((id) => !nextSet.has(id));
      const addedUsers = added.filter((id) => id !== actorId);
      const removedUsers = removed.filter((id) => id !== actorId);

      const nextStatus =
        nextAssignees.length > 0
          ? AppealStatus.IN_PROGRESS
          : appeal.status === AppealStatus.IN_PROGRESS
          ? AppealStatus.OPEN
          : appeal.status;

      await prisma.$transaction(async (tx) => {
        await tx.appealAssignee.deleteMany({ where: { appealId } });
        if (nextAssignees.length) {
          await tx.appealAssignee.createMany({
            data: nextAssignees.map((uid) => ({ appealId, userId: uid })),
            skipDuplicates: true,
          });
        }
        if (nextStatus !== appeal.status) {
          await tx.appeal.update({
            where: { id: appealId },
            data: { status: nextStatus },
          });
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: appeal.status,
              newStatus: nextStatus,
              changedById: actorId,
            },
          });
        }
      });
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      const watcherIds = (appeal.watchers || []).map((w) => w.userId);
      const affectedUserIds = Array.from(
        new Set([appeal.createdById, ...prevAssignees, ...nextAssignees, ...watcherIds])
      );

      if (added.length || removed.length) {
        const users = await prisma.user.findMany({
          where: { id: { in: Array.from(new Set([...added, ...removed])) } },
          select: userMiniSelect,
        });
        const nameById = new Map(users.map((u) => [u.id, getUserDisplayName(u)]));
        const addedNames = added.map((id) => nameById.get(id)).filter(Boolean).join(', ');
        const removedNames = removed.map((id) => nameById.get(id)).filter(Boolean).join(', ');
        const parts = [];
        if (addedNames) parts.push(`Добавлены: ${addedNames}`);
        if (removedNames) parts.push(`Удалены: ${removedNames}`);
        const text = parts.length ? `Исполнители обновлены. ${parts.join('. ')}.` : 'Исполнители обновлены.';
        await createSystemMessage({
          appealId,
          actorId,
          text,
          systemEvent: { type: 'assignees_changed', added, removed },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients: affectedUserIds,
        });
      }

      if (nextStatus !== appeal.status) {
        await createSystemMessage({
          appealId,
          actorId,
          text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[nextStatus]}.`,
          systemEvent: { type: 'status_changed', from: appeal.status, to: nextStatus },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients: affectedUserIds,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status: nextStatus });
      }

      for (const uid of added) {
        io.to(`user:${uid}`).emit('appealAssigned', { appealId, userId: uid });
      }
      io.to(`appeal:${appealId}`).emit('assigneesUpdated', {
        appealId,
        assigneeIds: nextAssignees,
      });

      void (async () => {
        try {
          if (addedUsers.length) {
            await dispatchNotification({
              type: 'STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `Вас назначили исполнителем. Назначил: ${actorName}`,
              telegramText: tplAssigneeAssigned({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                channel: 'telegram',
              }),
              maxText: tplAssigneeAssigned({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: addedUsers,
              excludeSenderUserId: actorId,
              respectMute: true,
              pushData: {
                type: 'APPEAL_ASSIGNED',
                appealId,
                appealNumber: appeal.number,
              },
            });
            emitAppealNotify({
              io,
              userIds: addedUsers,
              kind: 'ASSIGNED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              message: `Вас назначил(а) ${actorName} исполнителем.`,
              icon: 'person-add-outline',
              actorId,
              actorName,
              dedupeScope: `assign:add:${nextAssignees.join(',')}`,
            });
          }

          if (removedUsers.length) {
            await dispatchNotification({
              type: 'STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `Вас сняли с исполнения. Изменил: ${actorName}`,
              telegramText: tplAssigneeRemoved({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                channel: 'telegram',
              }),
              maxText: tplAssigneeRemoved({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: removedUsers,
              excludeSenderUserId: actorId,
              respectMute: true,
              pushData: {
                type: 'APPEAL_UNASSIGNED',
                appealId,
                appealNumber: appeal.number,
              },
            });
            emitAppealNotify({
              io,
              userIds: removedUsers,
              kind: 'UNASSIGNED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              message: `Вас снял(а) ${actorName} с исполнения.`,
              icon: 'person-remove-outline',
              actorId,
              actorName,
              dedupeScope: `assign:remove:${nextAssignees.join(',')}`,
            });
          }
        } catch (err: any) {
          console.error('[notifications] assignees change error:', err?.message);
        }
      })();

      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: affectedUserIds,
        assigneeIds: nextAssignees,
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse({ id: appealId, status: nextStatus }, 'Исполнители назначены')
      );
    } catch (error) {
      console.error('Ошибка назначения исполнителей:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка назначения исполнителей', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/claim:
 *   post:
 *     tags: [Appeals]
 *     summary: Взять обращение в работу
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.post(
  '/:id/claim',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealClaimResponse>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
      if (!employee?.departmentId || employee.departmentId !== appeal.toDepartmentId) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому отделу', ErrorCodes.FORBIDDEN));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const alreadyAssigned = prevAssignees.includes(userId);
      const nextAssignees = alreadyAssigned ? prevAssignees : [...prevAssignees, userId];

      const shouldChangeStatus = appeal.status !== AppealStatus.IN_PROGRESS;

      await prisma.$transaction(async (tx) => {
        if (!alreadyAssigned) {
          await tx.appealAssignee.create({
            data: { appealId, userId },
          });
        }
        if (shouldChangeStatus) {
          await tx.appeal.update({
            where: { id: appealId },
            data: { status: AppealStatus.IN_PROGRESS },
          });
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: appeal.status,
              newStatus: AppealStatus.IN_PROGRESS,
              changedById: userId,
            },
          });
        }
      });
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([appeal.createdById, ...nextAssignees, ...appeal.watchers.map((w) => w.userId)])
      );

      if (!alreadyAssigned) {
        await createSystemMessage({
          appealId,
          actorId: userId,
          text: `Исполнитель взял обращение в работу: ${getUserDisplayName(await loadUserMini(userId))}.`,
          systemEvent: { type: 'assignees_changed', added: [userId], removed: [] },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients,
        });
        io.to(`user:${userId}`).emit('appealAssigned', { appealId, userId });
        io.to(`appeal:${appealId}`).emit('assigneesUpdated', { appealId, assigneeIds: nextAssignees });
      }

      if (shouldChangeStatus) {
        await createSystemMessage({
          appealId,
          actorId: userId,
          text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[AppealStatus.IN_PROGRESS]}.`,
          systemEvent: { type: 'status_changed', from: appeal.status, to: AppealStatus.IN_PROGRESS },
          io,
          toDepartmentId: appeal.toDepartmentId,
          recipients,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', {
          appealId,
          status: AppealStatus.IN_PROGRESS,
        });
      }

      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: recipients,
        assigneeIds: nextAssignees,
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse(
          { id: appealId, status: AppealStatus.IN_PROGRESS, assigneeIds: nextAssignees },
          'Обращение взято в работу'
        )
      );
    } catch (error) {
      console.error('Ошибка self-assign:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка назначения исполнителя', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/department:
 *   put:
 *     tags: [Appeals]
 *     summary: Перевести обращение в другой отдел
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["assign_appeal"]
 */
router.put(
  '/:id/department',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['assign_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealDepartmentChangeResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = ChangeDepartmentBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const { departmentId } = b.data as { departmentId: number };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
          toDepartment: true,
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      const actorId = req.user!.userId;
      const actorName = getUserDisplayName(actor);

      const canMove = isAdminRole(actor) || isDepartmentManager(actor, appeal.toDepartmentId);
      if (!canMove) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на перевод отдела', ErrorCodes.FORBIDDEN));
      }

      if (appeal.toDepartmentId === departmentId) {
        return res.json(
          successResponse(
            { id: appealId, status: appeal.status, toDepartmentId: appeal.toDepartmentId },
            'Отдел не изменён'
          )
        );
      }

      const targetDept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!targetDept) {
        return res
          .status(404)
          .json(errorResponse('Отдел не найден', ErrorCodes.NOT_FOUND));
      }

      const prevAssignees = (appeal.assignees || []).map((a) => a.userId);
      const prevStatus = appeal.status;
      const nextStatus = AppealStatus.OPEN;
      const fromDepartmentName = appeal.toDepartment?.name ?? `#${appeal.toDepartmentId}`;
      const toDepartmentName = targetDept.name;

      await prisma.$transaction(async (tx) => {
        await tx.appealAssignee.deleteMany({ where: { appealId } });
        await tx.appeal.update({
          where: { id: appealId },
          data: { toDepartmentId: departmentId, status: nextStatus },
        });
        if (prevStatus !== nextStatus) {
          await tx.appealStatusHistory.create({
            data: {
              appealId,
              oldStatus: prevStatus,
              newStatus: nextStatus,
              changedById: actorId,
            },
          });
        }
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([appeal.createdById, ...prevAssignees, ...appeal.watchers.map((w) => w.userId)])
      );

      const deptChangeMessage = await createSystemMessage({
        appealId,
        actorId,
        text: `Отдел изменён: ${fromDepartmentName} → ${toDepartmentName}.`,
        systemEvent: {
          type: 'department_changed',
          fromDepartmentId: appeal.toDepartmentId,
          toDepartmentId: departmentId,
        },
        io,
        toDepartmentId: departmentId,
        recipients,
      });

      if (deptChangeMessage) {
        io.to(`department:${appeal.toDepartmentId}`).emit('messageAdded', deptChangeMessage);
      }

      if (prevAssignees.length) {
        await createSystemMessage({
          appealId,
          actorId,
          text: 'Исполнители сняты из-за смены отдела.',
          systemEvent: { type: 'assignees_changed', added: [], removed: prevAssignees },
          io,
          toDepartmentId: departmentId,
          recipients,
        });
      }

      if (prevStatus !== nextStatus) {
        await createSystemMessage({
          appealId,
          actorId,
          text: `Статус изменён: ${STATUS_LABELS[prevStatus]} → ${STATUS_LABELS[nextStatus]}.`,
          systemEvent: { type: 'status_changed', from: prevStatus, to: nextStatus },
          io,
          toDepartmentId: departmentId,
          recipients,
        });
        io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status: nextStatus });
      }

      io.to(`appeal:${appealId}`).emit('assigneesUpdated', { appealId, assigneeIds: [] });
      io.to(`appeal:${appealId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });
      io.to(`department:${appeal.toDepartmentId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });
      io.to(`department:${departmentId}`).emit('departmentChanged', {
        appealId,
        fromDepartmentId: appeal.toDepartmentId,
        toDepartmentId: departmentId,
      });

      const [targetDeptRoleMembers, targetDeptEmployees] = await Promise.all([
        prisma.departmentRole.findMany({
          where: { departmentId },
          select: { userId: true },
        }),
        prisma.employeeProfile.findMany({
          where: { departmentId },
          select: { userId: true },
        }),
      ]);
      const targetDepartmentUsers = Array.from(
        new Set([
          ...targetDeptRoleMembers.map((row) => row.userId),
          ...targetDeptEmployees.map((row) => row.userId),
        ])
      ).filter((id) => id !== actorId);

      const removedUsers = prevAssignees.filter((id) => id !== actorId);
      const authorUsers =
        appeal.createdById && appeal.createdById !== actorId ? [appeal.createdById] : [];
      const transferAuthorUsers = authorUsers.filter((id) => !removedUsers.includes(id));
      const blockedUsers = new Set([...removedUsers, ...transferAuthorUsers]);
      const transferToDeptUsers = targetDepartmentUsers.filter((id) => !blockedUsers.has(id));

      void (async () => {
        try {
          if (removedUsers.length) {
            await dispatchNotification({
              type: 'STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `Отдел изменён: ${fromDepartmentName} → ${toDepartmentName}. Вы больше не исполнитель.`,
              telegramText: tplTransferRemovedAssignee({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                fromDepartmentName,
                toDepartmentName,
                channel: 'telegram',
              }),
              maxText: tplTransferRemovedAssignee({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                fromDepartmentName,
                toDepartmentName,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: removedUsers,
              excludeSenderUserId: actorId,
              respectMute: true,
              pushData: {
                type: 'APPEAL_TRANSFERRED',
                appealId,
                appealNumber: appeal.number,
              },
            });
            emitAppealNotify({
              io,
              userIds: removedUsers,
              kind: 'TRANSFER_REMOVED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              message: `Отдел изменён: ${fromDepartmentName} → ${toDepartmentName}. Вы больше не исполнитель.`,
              icon: 'swap-horizontal-outline',
              actorId,
              actorName,
              dedupeScope: `transfer:${appeal.toDepartmentId}->${departmentId}:removed`,
            });
          }

          if (transferAuthorUsers.length) {
            await dispatchNotification({
              type: 'STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `Обращение передано в отдел ${toDepartmentName}. Изменил: ${actorName}`,
              telegramText: tplTransferAuthor({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                fromDepartmentName,
                toDepartmentName,
                channel: 'telegram',
              }),
              maxText: tplTransferAuthor({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                fromDepartmentName,
                toDepartmentName,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: transferAuthorUsers,
              excludeSenderUserId: actorId,
              respectMute: true,
              pushData: {
                type: 'APPEAL_TRANSFERRED',
                appealId,
                appealNumber: appeal.number,
              },
            });
            emitAppealNotify({
              io,
              userIds: transferAuthorUsers,
              kind: 'TRANSFER_AUTHOR',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              message: `Обращение передано в отдел ${toDepartmentName}. Изменил: ${actorName}`,
              icon: 'swap-horizontal-outline',
              actorId,
              actorName,
              dedupeScope: `transfer:${appeal.toDepartmentId}->${departmentId}:author`,
            });
          }

          if (transferToDeptUsers.length) {
            await dispatchNotification({
              type: 'STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `В ваш отдел передано обращение #${appeal.number}. Передал: ${actorName}`,
              telegramText: tplTransferToDepartment({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                toDepartmentName,
                channel: 'telegram',
              }),
              maxText: tplTransferToDepartment({
                appealId,
                number: appeal.number,
                changedByName: actorName,
                toDepartmentName,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: transferToDeptUsers,
              excludeSenderUserId: actorId,
              respectMute: true,
              pushData: {
                type: 'APPEAL_TRANSFERRED',
                appealId,
                appealNumber: appeal.number,
              },
            });
            emitAppealNotify({
              io,
              userIds: transferToDeptUsers,
              kind: 'TRANSFER_TO_DEPT',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              message: `В ваш отдел передано обращение. Передал: ${actorName}`,
              icon: 'business-outline',
              actorId,
              actorName,
              dedupeScope: `transfer:${appeal.toDepartmentId}->${departmentId}:target`,
            });
          }
        } catch (err: any) {
          console.error('[notifications] department transfer error:', err?.message);
        }
      })();

      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: departmentId,
        userIds: recipients,
        assigneeIds: [],
      });

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse(
          { id: appealId, status: nextStatus, toDepartmentId: departmentId },
          'Отдел изменён'
        )
      );
    } catch (error) {
      console.error('Ошибка смены отдела:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка смены отдела', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/status:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить статус обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.put(
  '/:id/status',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealStatusUpdateResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = StatusBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { status } = b.data as { status: AppealStatus };

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a: any) => a.userId === userId);
      const isAdmin = isAdminRole(actor);
      const isManager = isDepartmentManager(actor, appeal.toDepartmentId);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee && !isManager && !isAdmin) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      let allowed = false;
      if (isAdmin || isManager) {
        allowed = true;
      } else if (isCreator) {
        allowed =
          status === AppealStatus.COMPLETED ||
          (appeal.status === AppealStatus.RESOLVED && status === AppealStatus.IN_PROGRESS);
      } else if (isAssignee) {
        allowed = status === AppealStatus.RESOLVED;
      }

      if (!allowed) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на смену статуса', ErrorCodes.FORBIDDEN));
      }

      if (status === appeal.status) {
        return res.json(
          successResponse({ id: appealId, status: appeal.status }, 'Статус не изменён')
        );
      }

      await prisma.appeal.update({
        where: { id: appealId },
        data: { status },
      });

      await prisma.appealStatusHistory.create({
        data: {
          appealId,
          oldStatus: appeal.status,
          newStatus: status,
          changedById: req.user!.userId,
        },
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([
          appeal.createdById,
          ...appeal.assignees.map((a: any) => a.userId),
          ...appeal.watchers.map((w: any) => w.userId),
        ])
      );

      await createSystemMessage({
        appealId,
        actorId: req.user!.userId,
        text: `Статус изменён: ${STATUS_LABELS[appeal.status]} → ${STATUS_LABELS[status]}.`,
        systemEvent: { type: 'status_changed', from: appeal.status, to: status },
        io,
        toDepartmentId: appeal.toDepartmentId,
        recipients,
      });

      io.to(`appeal:${appealId}`).emit('statusUpdated', { appealId, status });
      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: recipients,
      });

      // Push/Telegram-уведомления + управление планировщиком
      void (async () => {
        try {
          const changedByName = [actor?.firstName, actor?.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || actor?.email || 'Пользователь';

          await dispatchNotification({
            type: 'STATUS_CHANGED',
            appealId,
            appealNumber: appeal.number,
            title: `Обращение #${appeal.number}`,
            body: `Статус изменён на: ${STATUS_LABELS[status] ?? status}`,
            telegramText: tplStatusChanged({
              appealId,
              number: appeal.number,
              oldStatus: appeal.status,
              newStatus: status,
              changedByName,
              channel: 'telegram',
            }),
            maxText: tplStatusChanged({
              appealId,
              number: appeal.number,
              oldStatus: appeal.status,
              newStatus: status,
              changedByName,
              channel: 'max',
            }),
            channels: ['push', 'telegram', 'max'],
            recipientUserIds: recipients,
            excludeSenderUserId: req.user!.userId,
            pushData: {
              type: 'APPEAL_STATUS_CHANGED',
              appealId,
              appealNumber: appeal.number,
              status,
            },
          });

          // Управление задачами планировщика
          if (['RESOLVED', 'COMPLETED'].includes(status)) {
            await cancelAppealJobs(appealId);
            await scheduleClosureReminder(appealId);
          } else if (['DECLINED'].includes(status)) {
            await cancelAppealJobs(appealId);
          } else {
            await cancelAppealJobs(appealId);
            await scheduleUnreadReminder(appealId);
          }
        } catch (err: any) {
          console.error('[notifications] status change error:', err?.message);
        }
      })();

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse({ id: appealId, status }, 'Статус обновлён')
      );
    } catch (error) {
      console.error('Ошибка обновления статуса:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления статуса', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/{id}/deadline:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить дедлайн обращения
 *     description: Доступно только автору обращения или администратору.
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.put(
  '/:id/deadline',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ id: string }, AppealDeadlineUpdateResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = DeadlineBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const nextDeadline = b.data.deadline ? new Date(b.data.deadline) : null;

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      const actor = await loadUserMini(req.user!.userId);
      if (!actor) {
        return res
          .status(404)
          .json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const isCreator = appeal.createdById === userId;
      const isAdmin = isAdminRole(actor);
      if (!isCreator && !isAdmin) {
        return res
          .status(403)
          .json(errorResponse('Нет прав на изменение дедлайна', ErrorCodes.FORBIDDEN));
      }

      const prevDeadline = appeal.deadline ?? null;
      const prevTime = prevDeadline ? prevDeadline.getTime() : null;
      const nextTime = nextDeadline ? nextDeadline.getTime() : null;
      if (prevTime === nextTime) {
        return res.json(
          successResponse(
            { id: appealId, deadline: prevDeadline },
            'Дедлайн не изменён'
          )
        );
      }

      await prisma.appeal.update({
        where: { id: appealId },
        data: { deadline: nextDeadline },
      });

      const io = req.app.get('io') as SocketIOServer;
      const recipients = Array.from(
        new Set([
          appeal.createdById,
          ...appeal.assignees.map((a: any) => a.userId),
          ...appeal.watchers.map((w: any) => w.userId),
        ])
      );
      const fromLabel = prevDeadline
        ? prevDeadline.toLocaleString('ru-RU', { hour12: false })
        : 'без дедлайна';
      const toLabel = nextDeadline
        ? nextDeadline.toLocaleString('ru-RU', { hour12: false })
        : 'без дедлайна';

      await createSystemMessage({
        appealId,
        actorId: userId,
        text: `Дедлайн изменён: ${fromLabel} → ${toLabel}.`,
        systemEvent: {
          type: 'deadline_changed',
          from: prevDeadline ? prevDeadline.toISOString() : null,
          to: nextDeadline ? nextDeadline.toISOString() : null,
        },
        io,
        toDepartmentId: appeal.toDepartmentId,
        recipients,
      });

      io.to(`appeal:${appealId}`).emit('deadlineUpdated', {
        appealId,
        deadline: nextDeadline,
      });
      await emitAppealUpdated({
        io,
        appealId,
        toDepartmentId: appeal.toDepartmentId,
        userIds: recipients,
      });

      // Push/Telegram-уведомление
      void (async () => {
        try {
          const changedByName = [actor?.firstName, actor?.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || actor?.email || 'Пользователь';

          await dispatchNotification({
            type: 'DEADLINE_CHANGED',
            appealId,
            appealNumber: appeal.number,
            title: `Обращение #${appeal.number}`,
            body: nextDeadline
              ? `Дедлайн до ${nextDeadline.toLocaleDateString('ru-RU')}`
              : 'Дедлайн удалён',
            telegramText: tplDeadlineChanged({
              appealId,
              number:        appeal.number,
              deadline:      nextDeadline,
              changedByName,
              channel: 'telegram',
            }),
            maxText: tplDeadlineChanged({
              appealId,
              number: appeal.number,
              deadline: nextDeadline,
              changedByName,
              channel: 'max',
            }),
            channels: ['push', 'telegram', 'max'],
            recipientUserIds: recipients,
            excludeSenderUserId: req.user!.userId,
            pushData: {
              type: 'APPEAL_DEADLINE_CHANGED',
              appealId,
              appealNumber: appeal.number,
              deadline: nextDeadline ? nextDeadline.toISOString() : null,
            },
          });
        } catch (err: any) {
          console.error('[notifications] deadline change error:', err?.message);
        }
      })();

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      return res.json(
        successResponse(
          { id: appealId, deadline: nextDeadline },
          'Дедлайн обновлён'
        )
      );
    } catch (error) {
      console.error('Ошибка обновления дедлайна:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления дедлайна', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// POST /appeals/:id/messages — добавить сообщение (с файлами в облаке)
/**
 * @openapi
 * /appeals/{id}/messages:
 *   post:
 *     tags: [Appeals]
 *     summary: Добавить сообщение к обращению
 *     description: Можно отправить текст и/или файлы-вложения.
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["add_appeal_message"]
 */
router.post(
  '/:id/messages',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['add_appeal_message']),
  upload.array('attachments'),
  async (
    req: AuthRequest<{ id: string }, AppealAddMessageResponse, unknown>,
    res: express.Response
  ) => {
    // --- ЛОГИРОВАНИЕ ЗАПРОСА / ОТВЕТА ---
    const requestId = randomUUID();
    const startedAt = Date.now();

    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let responseStatus: number | undefined;

    res.status = (code: number) => {
      responseStatus = code;
      return originalStatus(code);
    };

    res.json = (data: any) => {
      if (responseStatus === undefined) responseStatus = res.statusCode || 200;
      const durationMs = Date.now() - startedAt;
      try {
        console.log('[APPEAL MESSAGE][RESPONSE]', {
          requestId,
          status: responseStatus,
          durationMs,
          data,
        });
      } catch {}
      return originalJson(data);
    };

    try {
      const files = (req.files as Express.Multer.File[]) ?? [];
      console.log('[APPEAL MESSAGE][REQUEST]', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        params: req.params,
        body: req.body,
        userId: req.user?.userId,
        files: files.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
        })),
      });
    } catch {}
    // --- КОНЕЦ БЛОКА ЛОГИРОВАНИЯ ---

    try {
      // 1) Валидация параметров
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }

      const b = AddMessageBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }

      const { id: appealId } = p.data;
      const { text } = b.data as { text?: string };

      // 2) Проверяем, что обращение существует
      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        include: {
          assignees: { select: { userId: true } },
          watchers: { select: { userId: true } },
        },
      });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      // 3) Проверяем, что есть либо текст, либо файлы
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (!text && files.length === 0) {
        return res
          .status(400)
          .json(errorResponse('Нужно отправить текст или вложения', ErrorCodes.VALIDATION_ERROR));
      }

      // 4) Создаём сообщение
      const message = await prisma.appealMessage.create({
        data: {
          appealId,
          senderId: req.user!.userId,
          text: text ?? null,
        },
      });

      // 5) Загружаем вложения в MinIO
      for (const file of files) {
        try {
          const { key, fileName } = await uploadMulterFile(file, false);
          await prisma.appealAttachment.create({
            data: {
              messageId: message.id,
              fileUrl: key,
              fileName,
              fileType: detectAttachmentType(file.mimetype),
            },
          });
        } catch (err) {
          console.error('[APPEAL MESSAGE] Не удалось сохранить вложение:', {
            requestId,
            file: {
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
            },
            error: err,
          });
        }
      }

      const fullMessage = await prisma.appealMessage.findUnique({
        where: { id: message.id },
        include: {
          attachments: true,
          reads: { select: { userId: true, readAt: true } },
          sender: {
            select: userMiniSelect,
          },
        },
      });

      const mappedMessage = fullMessage
        ? await mapMessageWithReads(fullMessage as MessageWithRelations, req.user!.userId)
        : {
            id: message.id,
            appealId,
            senderId: req.user!.userId,
            text: message.text,
            type: AppealMessageType.USER,
            systemEvent: null,
            createdAt: message.createdAt,
            attachments: [],
            readBy: [],
            isRead: true,
          };
      const mappedMessageWithAppeal: any = {
        ...mappedMessage,
        appealNumber: appeal.number,
      };

      // 6) Инвалидация кэша обращения + обновляем версию
      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');
      await prisma.appeal.update({
        where: { id: appealId },
        data: { updatedAt: new Date() },
      });

      const recipients = new Set<number>();
      // отправителя тоже уведомляем, чтобы список у него обновился без ручного рефреша
      recipients.add(req.user!.userId);
      if (appeal.createdById !== req.user!.userId) {
        recipients.add(appeal.createdById);
      }
      const assignees = (appeal as any).assignees as { userId: number }[] | undefined;
      assignees?.forEach((a) => {
        if (a.userId !== req.user!.userId) recipients.add(a.userId);
      });
      const watchers = (appeal as any).watchers as { userId: number }[] | undefined;
      watchers?.forEach((w) => {
        if (w.userId !== req.user!.userId) recipients.add(w.userId);
      });

      // 7) Уведомляем всех подписчиков по WebSocket
      const io = req.app.get('io') as unknown as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageAdded', mappedMessageWithAppeal);
      // Уведомляем участников персонально (чтобы список обращений получил событие)
      if (recipients.size) {
        for (const uid of recipients) {
          io.to(`user:${uid}`).emit('messageAdded', mappedMessageWithAppeal);
        }
      }
      // Уведомляем отдел-получатель (для вкладки "Задачи отдела")
        if (appeal.toDepartmentId) {
          io.to(`department:${appeal.toDepartmentId}`).emit('messageAdded', mappedMessageWithAppeal);
        }

        await emitAppealUpdated({
          io,
          appealId,
          toDepartmentId: appeal.toDepartmentId,
          userIds: Array.from(recipients),
          lastMessage: mappedMessageWithAppeal,
        });

        const senderName = mappedMessageWithAppeal.sender
          ? [
              mappedMessageWithAppeal.sender.firstName,
              mappedMessageWithAppeal.sender.lastName,
            ]
              .filter(Boolean)
              .join(' ')
              .trim() || mappedMessageWithAppeal.sender.email || 'Пользователь'
          : 'Пользователь';
        const snippet = mappedMessageWithAppeal.text
          ? String(mappedMessageWithAppeal.text).trim().slice(0, 120)
          : '[Вложение]';
      // Push/Telegram-уведомление участникам + перепланировка UNREAD_REMINDER
      void (async () => {
        try {
          const notificationRecipients = Array.from(recipients).filter(
            (uid) => uid !== req.user!.userId
          );
          if (notificationRecipients.length) {
            await dispatchNotification({
              type: 'NEW_MESSAGE',
              appealId,
              appealNumber: appeal.number,
              title: `Обращение #${appeal.number}`,
              body: `${senderName}: ${snippet}`,
              telegramText: tplNewMessage({
                appealId,
                number: appeal.number,
                senderName,
                snippet,
                channel: 'telegram',
              }),
              maxText: tplNewMessage({
                appealId,
                number: appeal.number,
                senderName,
                snippet,
                channel: 'max',
              }),
              channels: ['push', 'telegram', 'max'],
              recipientUserIds: notificationRecipients,
              excludeSenderUserId: req.user!.userId,
              pushData: {
                type: 'APPEAL_MESSAGE',
                appealId,
                appealNumber: appeal.number,
                messageId: mappedMessageWithAppeal.id,
                senderName,
                senderAvatarUrl: mappedMessageWithAppeal.sender?.avatarUrl ?? null,
              },
            });
          }
          // Сбросить и перепланировать напоминание о непрочитанных
          await cancelAppealJobs(appealId);
          await scheduleUnreadReminder(appealId);
        } catch (err: any) {
          console.error('[notifications] new message error:', err?.message);
        }
      })();

      // 8) Отправляем ответ
      return res
        .status(201)
        .json(
          successResponse(
            { id: mappedMessage.id, createdAt: mappedMessage.createdAt },
            'Сообщение добавлено'
          )
        );
    } catch (error) {
      console.error('[APPEAL MESSAGE][ERROR]', { requestId, error });
      return res
        .status(500)
        .json(errorResponse('Ошибка добавления сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
  );

  /**
   * @openapi
   * /appeals/{id}/messages/read-bulk:
   *   post:
   *     tags: [Appeals]
   *     summary: Пометить несколько сообщений прочитанными
   *     security: [ { bearerAuth: [] } ]
   *     x-permissions: ["view_appeal"]
   */
  router.post(
    '/:id/messages/read-bulk',
    authenticateToken,
    checkUserStatus,
    authorizeServiceAccess('appeals'),
    authorizePermissions(['view_appeal']),
    async (req: AuthRequest<{ id: string }, AppealReadBulkResponse>, res: express.Response) => {
      try {
        const p = IdParamSchema.safeParse(req.params);
        if (!p.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
        }
        const b = ReadBulkBodySchema.safeParse(req.body);
        if (!b.success) {
          return res
            .status(400)
            .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
        }

        const { id: appealId } = p.data;
        const { messageIds } = b.data as { messageIds: number[] };
        const userId = req.user!.userId;

        const appeal = await prisma.appeal.findUnique({
          where: { id: appealId },
          include: { assignees: { select: { userId: true } } },
        });
        if (!appeal) {
          return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
        }

        const isCreator = appeal.createdById === userId;
        const isAssignee = appeal.assignees.some((a) => a.userId === userId);
        const actor = await loadUserMini(userId);
        if (!actor) {
          return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
        }
        const isAdmin = isAdminRole(actor as UserMiniRaw);
        const employee = await prisma.employeeProfile.findFirst({
          where: { userId, departmentId: appeal.toDepartmentId },
        });
        if (!isCreator && !isAssignee && !employee && !isAdmin) {
          return res
            .status(403)
            .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
        }

        const validIds = Array.from(new Set(messageIds)).filter((id) => Number.isFinite(id));
        if (!validIds.length) {
          return res
            .status(400)
            .json(errorResponse('Список messageIds пуст', ErrorCodes.VALIDATION_ERROR));
        }

        const readableMessages = await prisma.appealMessage.findMany({
          where: {
            id: { in: validIds },
            appealId,
            deleted: false,
            senderId: { not: userId },
          },
          select: { id: true, createdAt: true },
        });
        let finalReadIds: number[] = [];

        if (readableMessages.length) {
          const boundary = readableMessages.reduce((max, cur) => {
            if (cur.createdAt > max.createdAt) return cur;
            if (cur.createdAt.getTime() === max.createdAt.getTime() && cur.id > max.id) return cur;
            return max;
          }, readableMessages[0]);

          const upToBoundary = await prisma.appealMessage.findMany({
            where: {
              appealId,
              deleted: false,
              senderId: { not: userId },
              reads: { none: { userId } },
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lte: boundary.id } },
              ],
            },
            select: { id: true },
          });
          finalReadIds = Array.from(new Set(upToBoundary.map((m) => m.id)));
        }

        const now = new Date();
        if (finalReadIds.length) {
          await prisma.appealMessageRead.createMany({
            data: finalReadIds.map((messageId) => ({ messageId, userId, readAt: now })),
            skipDuplicates: true,
          });
        }

        await cacheDel(`appeal:${appealId}`);
        await cacheDelPrefix('appeals:list:');

        const io = req.app.get('io') as SocketIOServer;
        if (finalReadIds.length) {
          io.to(`appeal:${appealId}`).emit('messageRead', {
            appealId,
            messageIds: finalReadIds,
            userId,
            readAt: now,
          });
        }

        // Перепланировать UNREAD_REMINDER в зависимости от остатка непрочитанных
        if (finalReadIds.length) {
          void rescheduleUnreadReminderIfNeeded(appealId).catch((err: any) => {
            console.error('[notifications] rescheduleUnreadReminderIfNeeded error:', err?.message);
          });
        }

        return res.json(
          successResponse(
            { messageIds: finalReadIds, readAt: now },
            'Сообщения помечены прочитанными'
          )
        );
      } catch (error) {
        console.error('Ошибка bulk read сообщений:', error);
        return res
          .status(500)
          .json(errorResponse('Ошибка bulk read сообщений', ErrorCodes.INTERNAL_ERROR));
      }
    }
  );

  /**
   * @openapi
   * /appeals/{appealId}/messages/{messageId}/read:
   *   post:
 *     tags: [Appeals]
 *     summary: Пометить сообщение обращения прочитанным
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["view_appeal"]
 */
router.post(
  '/:appealId/messages/:messageId/read',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['view_appeal']),
  async (
    req: AuthRequest<{ appealId: string; messageId: string }>,
    res: express.Response
  ) => {
    try {
      const appealId = Number(req.params.appealId);
      const messageId = Number(req.params.messageId);
      if (Number.isNaN(appealId) || Number.isNaN(messageId)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный идентификатор', ErrorCodes.VALIDATION_ERROR));
      }

      const message = await prisma.appealMessage.findFirst({
        where: { id: messageId, appealId, deleted: false },
        include: {
          appeal: {
            select: {
              id: true,
              createdById: true,
              toDepartmentId: true,
              assignees: { select: { userId: true } },
            },
          },
        },
      });

      if (!message) {
        return res.status(404).json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }

      const userId = req.user!.userId;
      const appeal = message.appeal;
      const isCreator = appeal.createdById === userId;
      const isAssignee = appeal.assignees.some((a) => a.userId === userId);
      const actor = await loadUserMini(userId);
      if (!actor) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }
      const isAdmin = isAdminRole(actor as UserMiniRaw);
      const employee = await prisma.employeeProfile.findFirst({
        where: { userId, departmentId: appeal.toDepartmentId },
      });

      if (!isCreator && !isAssignee && !employee && !isAdmin) {
        return res
          .status(403)
          .json(errorResponse('Нет доступа к этому обращению', ErrorCodes.FORBIDDEN));
      }

      let finalReadIds: number[] = [];
      const now = new Date();
      if (message.senderId !== userId) {
        const upToBoundary = await prisma.appealMessage.findMany({
          where: {
            appealId,
            deleted: false,
            senderId: { not: userId },
            reads: { none: { userId } },
            OR: [
              { createdAt: { lt: message.createdAt } },
              { createdAt: message.createdAt, id: { lte: message.id } },
            ],
          },
          select: { id: true },
        });
        finalReadIds = Array.from(new Set(upToBoundary.map((m) => m.id)));
      }

      if (finalReadIds.length) {
        await prisma.appealMessageRead.createMany({
          data: finalReadIds.map((id) => ({ messageId: id, userId, readAt: now })),
          skipDuplicates: true,
        });
      }

      await cacheDel(`appeal:${appealId}`);
      await cacheDelPrefix('appeals:list:');

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('messageRead', {
        appealId,
        messageId,
        messageIds: finalReadIds,
        userId,
        readAt: now,
      });

      if (finalReadIds.length) {
        void rescheduleUnreadReminderIfNeeded(appealId).catch((err: any) => {
          console.error('[notifications] rescheduleUnreadReminderIfNeeded error:', err?.message);
        });
      }

      return res.json(
        successResponse(
          { appealId, messageId, messageIds: finalReadIds, readAt: now },
          'Сообщение помечено прочитанным'
        )
      );
    } catch (error) {
      console.error('Ошибка пометки прочитанного сообщения:', error);
      return res
        .status(500)
        .json(
          errorResponse('Ошибка пометки прочитанного сообщения', ErrorCodes.INTERNAL_ERROR)
        );
    }
  }
);


/**
 * @openapi
 * /appeals/{id}/watchers:
 *   put:
 *     tags: [Appeals]
 *     summary: Обновить список наблюдателей обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["manage_appeal_watchers"]
 */
router.put(
  '/:id/watchers',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['manage_appeal_watchers']),
  async (
    req: AuthRequest<{ id: string }, AppealWatchersUpdateResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = IdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = WatchersBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { id: appealId } = p.data;
      const { watcherIds } = b.data as { watcherIds: number[] };

      const appeal = await prisma.appeal.findUnique({ where: { id: appealId } });
      if (!appeal) {
        return res
          .status(404)
          .json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      await prisma.appealWatcher.deleteMany({ where: { appealId } });
      for (const uid of watcherIds) {
        await prisma.appealWatcher.create({ data: { appealId, userId: uid } });
      }

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${appealId}`).emit('watchersUpdated', {
        appealId,
        watchers: watcherIds,
      });

      return res.json(
        successResponse({ id: appealId, watchers: watcherIds }, 'Список наблюдателей обновлён')
      );
    } catch (error) {
      console.error('Ошибка обновления наблюдателей:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка обновления наблюдателей', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/messages/{messageId}:
 *   put:
 *     tags: [Appeals]
 *     summary: Редактировать сообщение обращения
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["edit_appeal_message"]
 */
router.put(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['edit_appeal_message']),
  async (
    req: AuthRequest<{ messageId: string }, AppealEditMessageResponse, unknown>,
    res: express.Response
  ) => {
    try {
      const p = MessageIdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const b = EditMessageBodySchema.safeParse(req.body);
      if (!b.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(b.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { messageId } = p.data;
      const { text } = b.data as { text: string };

      const message = await prisma.appealMessage.findUnique({ where: { id: messageId } });
      if (!message) {
        return res
          .status(404)
          .json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }
      if (message.senderId !== req.user!.userId) {
        return res
          .status(403)
          .json(errorResponse('Нельзя редактировать чужое сообщение', ErrorCodes.FORBIDDEN));
      }

      const updated = await prisma.appealMessage.update({
        where: { id: messageId },
        data: { text, editedAt: new Date() },
      });

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${updated.appealId}`).emit('messageEdited', {
        appealId: updated.appealId,
        messageId: updated.id,
        editedAt: updated.editedAt!,
        text: updated.text,
      });

      return res.json(
        successResponse({ id: updated.id, editedAt: updated.editedAt! }, 'Сообщение изменено')
      );
    } catch (error) {
      console.error('Ошибка редактирования сообщения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка редактирования сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/messages/{messageId}:
 *   delete:
 *     tags: [Appeals]
 *     summary: Удалить сообщение обращения (soft-delete)
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["delete_appeal_message"]
 */
router.delete(
  '/messages/:messageId',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['delete_appeal_message']),
  async (
    req: AuthRequest<{ messageId: string }, AppealDeleteMessageResponse>,
    res: express.Response
  ) => {
    try {
      const p = MessageIdParamSchema.safeParse(req.params);
      if (!p.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(p.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { messageId } = p.data;

      const message = await prisma.appealMessage.findUnique({ where: { id: messageId } });
      if (!message) {
        return res
          .status(404)
          .json(errorResponse('Сообщение не найдено', ErrorCodes.NOT_FOUND));
      }
      if (message.senderId !== req.user!.userId) {
        return res
          .status(403)
          .json(errorResponse('Нельзя удалить чужое сообщение', ErrorCodes.FORBIDDEN));
      }

      await prisma.appealMessage.update({
        where: { id: messageId },
        data: { deleted: true },
      });

      const io = req.app.get('io') as SocketIOServer;
      io.to(`appeal:${message.appealId}`).emit('messageDeleted', {
        appealId: message.appealId,
        messageId,
      });

      return res.json(successResponse({ id: messageId }, 'Сообщение удалено'));
    } catch (error) {
      console.error('Ошибка удаления сообщения:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка удаления сообщения', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /appeals/export:
 *   get:
 *     tags: [Appeals]
 *     summary: Экспорт обращений в CSV
 *     description: Возвращает CSV-файл согласно фильтрам и области (scope).
 *     security: [ { bearerAuth: [] } ]
 *     x-permissions: ["export_appeals"]
 */
router.get(
  '/export',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('appeals'),
  authorizePermissions(['export_appeals']),
  async (req: AuthRequest, res: express.Response) => {
    try {
      const parsed = ExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json(errorResponse(zodErrorMessage(parsed.error), ErrorCodes.VALIDATION_ERROR));
      }
      const { scope, status, priority, fromDate, toDate } = parsed.data;

      const userId = req.user!.userId;

      let where: any = {};
      switch (scope) {
        case 'my':
          where.createdById = userId;
          break;
        case 'department': {
          const employee = await prisma.employeeProfile.findUnique({ where: { userId } });
          if (!employee?.departmentId) {
            return res
              .status(400)
              .json(errorResponse('У пользователя не указан отдел', ErrorCodes.VALIDATION_ERROR));
          }
          where.toDepartmentId = employee.departmentId;
          break;
        }
        case 'assigned':
          where.assignees = { some: { userId } };
          break;
      }

      if (status) where.status = status;
      if (priority) where.priority = priority;

      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) where.createdAt.gte = new Date(fromDate);
        if (toDate) where.createdAt.lte = new Date(toDate);
      }

      const appeals = await prisma.appeal.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          priority: true,
          createdAt: true,
          deadline: true,
          title: true,
          toDepartmentId: true,
          fromDepartmentId: true,
          createdById: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const fields = [
        { label: 'ID', value: 'id' },
        { label: 'Номер', value: 'number' },
        { label: 'Статус', value: 'status' },
        { label: 'Приоритет', value: 'priority' },
        { label: 'Дата создания', value: 'createdAt' },
        { label: 'Дедлайн', value: 'deadline' },
        { label: 'Заголовок', value: 'title' },
        { label: 'Отдел отправителя', value: 'fromDepartmentId' },
        { label: 'Отдел получателя', value: 'toDepartmentId' },
        { label: 'ID создателя', value: 'createdById' },
      ];

      const parser = new Parser({ fields });
      const csv = parser.parse(appeals);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="appeals_${Date.now()}.csv"`);
      return res.send('\uFEFF' + csv);
    } catch (error) {
      console.error('Ошибка экспорта обращений:', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка экспорта обращений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
