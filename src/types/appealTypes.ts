// src/types/appeals.ts

import {
  AppealStatus,
  AppealPriority,
  AttachmentType,
  AppealMessageType,
  AppealLaborPaymentStatus,
} from '@prisma/client';
import { SuccessResponse, ErrorResponse } from '../utils/apiResponse';

/**
 * Запрос на создание обращения
 */
export interface AppealCreateRequest {
  toDepartmentId: number;
  title?: string;
  text: string;
  priority?: AppealPriority;
  deadline?: string; // ISO-строка
}

/**
 * Ответ на создание обращения
 */
export type AppealCreateResponse =
  | SuccessResponse<{
      id: number;
      number: number;
      status: AppealStatus;
      priority: AppealPriority;
      createdAt: Date;
    }>
  | ErrorResponse;

/**
 * Ответ на получение списка обращений
 * Можно уточнить тип поля data, если заранее известна структура
 */
export type AppealListResponse = SuccessResponse<{
  data: any[];
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
}> | ErrorResponse;

export type AppealCountersResponse = SuccessResponse<{
  my: {
    activeCount: number;
    unreadMessagesCount: number;
  };
  department: {
    available: boolean;
    activeCount: number;
    unreadMessagesCount: number;
  };
}> | ErrorResponse;

/**
 * Ответ на получение подробностей обращения
 */
export type AppealDetailResponse =
  | SuccessResponse<any> // здесь можно описать точную структуру обращения, если нужно
  | ErrorResponse;

/**
 * Запрос на назначение исполнителей
 */
export interface AppealAssignRequest {
  assigneeIds: number[];
}

/**
 * Ответ на назначение исполнителей
 */
export type AppealAssignResponse =
  | SuccessResponse<{
      id: number;
      status: AppealStatus;
    }>
  | ErrorResponse;

/**
 * Запрос на смену статуса
 */
export interface AppealStatusUpdateRequest {
  status: AppealStatus;
}

/**
 * Ответ на смену статуса
 */
export type AppealStatusUpdateResponse =
  | SuccessResponse<{
      id: number;
      status: AppealStatus;
    }>
  | ErrorResponse;

/**
 * Запрос на изменение дедлайна
 */
export interface AppealDeadlineUpdateRequest {
  deadline?: string | null;
}

/**
 * Ответ на изменение дедлайна
 */
export type AppealDeadlineUpdateResponse =
  | SuccessResponse<{
      id: number;
      deadline: Date | null;
    }>
  | ErrorResponse;

/**
 * Запрос на перевод обращения в другой отдел
 */
export interface AppealDepartmentChangeRequest {
  departmentId: number;
}

/**
 * Ответ на перевод обращения в другой отдел
 */
export type AppealDepartmentChangeResponse =
  | SuccessResponse<{
      id: number;
      status: AppealStatus;
      toDepartmentId: number;
    }>
  | ErrorResponse;

/**
 * Ответ на self-assign
 */
export type AppealClaimResponse =
  | SuccessResponse<{
      id: number;
      status: AppealStatus;
      assigneeIds: number[];
    }>
  | ErrorResponse;

/**
 * Запрос на добавление сообщения
 */
export interface AppealAddMessageRequest {
  text?: string;
  // Файлы передаются через multipart/form-data и не отражаются в типе тела запроса
}

/**
 * Ответ на добавление сообщения
 */
export type AppealAddMessageResponse =
  | SuccessResponse<{
      id: number;
      createdAt: Date;
    }>
  | ErrorResponse;

/**
 * Ответ на получение сообщений обращения (пагинация)
 */
export type AppealMessagesResponse =
  | SuccessResponse<{
      data: any[];
      meta: {
        hasMore?: boolean;
        nextCursor?: string | null;
        hasMoreBefore: boolean;
        prevCursor: string | null;
        hasMoreAfter: boolean;
        anchorMessageId: number | null;
      };
    }>
  | ErrorResponse;

/**
 * Ответ на bulk read сообщений
 */
export type AppealReadBulkResponse =
  | SuccessResponse<{
      messageIds: number[];
      readAt: Date;
    }>
  | ErrorResponse;

export interface AppealWatchersUpdateRequest {
  watcherIds: number[]; // новые списки наблюдателей
}

export type AppealWatchersUpdateResponse =
  | SuccessResponse<{ id: number; watchers: number[] }>
  | ErrorResponse;

export interface AppealEditMessageRequest {
  text: string;
}

export type AppealEditMessageResponse =
  | SuccessResponse<{ id: number; editedAt: Date }>
  | ErrorResponse;

export type AppealDeleteMessageResponse =
  | SuccessResponse<{ id: number }>
  | ErrorResponse;

export interface AppealExportQuery {
  scope?: 'my' | 'department' | 'assigned';
  status?: AppealStatus;
  priority?: AppealPriority;
  fromDate?: string; // ISO-строка (gte)
  toDate?: string;   // ISO-строка (lte)
}

export type AppealsAnalyticsMetaResponse = SuccessResponse<{
  availableDepartments: Array<{
    id: number;
    name: string;
    paymentRequired: boolean;
    hourlyRateRub: number;
  }>;
  availableAssignees: Array<{
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    department: { id: number; name: string } | null;
    hourlyRateRub: number | null;
  }>;
  role: {
    isAdmin: boolean;
    isDepartmentManager: boolean;
  };
}> | ErrorResponse;

export type AppealLaborEntryDto = {
  assigneeUserId: number;
  accruedHours: number;
  paidHours: number;
  remainingHours: number;
  payable: boolean;
  hourlyRateRub: number | null;
  effectiveHourlyRateRub: number;
  amountAccruedRub: number;
  amountPaidRub: number;
  amountRemainingRub: number;
  // alias for backward compatibility
  hours: number;
  paymentStatus: AppealLaborPaymentStatus;
  paidAt: Date | null;
  paidBy: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  assignee: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  updatedAt: Date;
};

export type AppealsAnalyticsAppealItem = {
  id: number;
  number: number;
  title: string | null;
  status: AppealStatus;
  createdAt: Date;
  deadline: Date | null;
  completedAt: Date | null;
  createdBy: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  toDepartment: {
    id: number;
    name: string;
    paymentRequired: boolean;
    hourlyRateRub: number;
  };
  assignees: Array<{
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    hourlyRateRub: number | null;
    effectiveHourlyRateRub: number;
  }>;
  sla: {
    openDurationMs: number;
    workDurationMs: number;
    timeToFirstInProgressMs: number | null;
    timeToFirstResolvedMs: number | null;
  };
  allowedStatuses: AppealStatus[];
  actionPermissions: {
    canChangeStatus: boolean;
    canEditDeadline: boolean;
    canAssign: boolean;
    canTransfer: boolean;
    canOpenParticipants: boolean;
    canSetLabor: boolean;
    canClaim: boolean;
  };
  laborEntries: AppealLaborEntryDto[];
};

export type AppealsAnalyticsAppealsResponse = SuccessResponse<{
  data: AppealsAnalyticsAppealItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}> | ErrorResponse;

export type AppealsAnalyticsUsersSummaryItem = {
  user: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    department: { id: number; name: string } | null;
    hourlyRateRub: number | null;
    effectiveHourlyRateRub: number;
  };
  stats: {
    appealsCount: number;
    paidAppealsCount: number;
    unpaidAppealsCount: number;
    partialAppealsCount: number;
    notRequiredAppealsCount: number;
    accruedHours: number;
    paidHours: number;
    remainingHours: number;
    accruedAmountRub: number;
    paidAmountRub: number;
    remainingAmountRub: number;
  };
};

export type AppealsAnalyticsUsersResponse = SuccessResponse<{
  data: AppealsAnalyticsUsersSummaryItem[];
}> | ErrorResponse;

export type AppealsAnalyticsUserAppealsResponse = SuccessResponse<{
  user: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    department: { id: number; name: string } | null;
  };
  data: AppealsAnalyticsAppealItem[];
}> | ErrorResponse;

export interface AppealLaborUpsertRequestItem {
  assigneeUserId: number;
  accruedHours?: number;
  paidHours?: number;
  hours?: number;
  paymentStatus?: AppealLaborPaymentStatus;
}

export interface AppealLaborUpsertRequest {
  items: AppealLaborUpsertRequestItem[];
}

export type AppealLaborUpsertResponse = SuccessResponse<{
  appealId: number;
  paymentRequired: boolean;
  currency: 'RUB';
  laborEntries: AppealLaborEntryDto[];
}> | ErrorResponse;

export type AppealsKpiDashboardResponse = SuccessResponse<{
  appeals: {
    totalCount: number;
    openCount: number;
    inProgressCount: number;
    completedCount: number;
    resolvedCount: number;
    declinedCount: number;
  };
  timing: {
    avgTakeMs: number | null;
    avgExecutionMs: number | null;
    takeCount: number;
    executionCount: number;
  };
  labor: {
    totalAccruedHours: number;
    totalPaidHours: number;
    totalRemainingHours: number;
    totalNotRequiredHours: number;
    totalAccruedAmountRub: number;
    totalPaidAmountRub: number;
    totalRemainingAmountRub: number;
    currency: 'RUB';
  };
}> | ErrorResponse;

export type AppealsAnalyticsUpdateHourlyRateResponse = SuccessResponse<{
  userId: number;
  hourlyRateRub: number;
}> | ErrorResponse;

export type AppealsSlaDashboardResponse = SuccessResponse<{
  transitions: Array<{
    key: 'OPEN_TO_IN_PROGRESS' | 'IN_PROGRESS_TO_RESOLVED' | 'RESOLVED_TO_COMPLETED';
    count: number;
    avgMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
  }>;
}> | ErrorResponse;

export type AppealsPaymentQueueResponse = SuccessResponse<{
  data: Array<{
    assignee: {
      id: number;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      department: { id: number; name: string } | null;
    };
    departments: Array<{
      id: number;
      name: string;
      items: Array<{
        appealId: number;
        appealNumber: number;
        hours: number;
        paymentStatus: AppealLaborPaymentStatus;
        financialStatus: 'NOT_PAYABLE' | 'TO_PAY' | 'PARTIAL' | 'PAID';
      }>;
      totalHours: number;
    }>;
    totalHours: number;
  }>;
  meta: { totalItems: number };
}> | ErrorResponse;

export type AppealsPaymentQueueMarkPaidResponse = SuccessResponse<{
  updated: number;
}> | ErrorResponse;

export type AppealLaborAuditLogResponse = SuccessResponse<{
  data: Array<{
    id: number;
    appealId: number;
    assigneeUserId: number;
    changedBy: {
      id: number;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
    };
    oldHours: number | null;
    newHours: number;
    oldPaidHours: number | null;
    newPaidHours: number | null;
    oldPaymentStatus: AppealLaborPaymentStatus | null;
    newPaymentStatus: AppealLaborPaymentStatus;
    changedAt: Date;
  }>;
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}> | ErrorResponse;

export type AppealsFunnelResponse = SuccessResponse<{
  byStatus: Array<{ status: 'NOT_PAYABLE' | 'TO_PAY' | 'PARTIAL' | 'PAID'; count: number }>;
}> | ErrorResponse;

export type AppealsHeatmapResponse = SuccessResponse<{
  data: Array<{
    user: {
      id: number;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      department: { id: number; name: string } | null;
    };
    cells: Array<{
      date: string;
      totalHours: number;
      appealsCount: number;
    }>;
  }>;
}> | ErrorResponse;

export type AppealsForecastResponse = SuccessResponse<{
  horizon: 'week' | 'month';
  generatedAt: Date;
  lookbackDays: number;
  remainingDays: number;
  departments: Array<{
    id: number;
    name: string;
    expectedHours: number;
    expectedPayout: number;
    formula: string;
  }>;
}> | ErrorResponse;
