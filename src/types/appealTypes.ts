// src/types/appeals.ts

import {
  AppealStatus,
  AppealPriority,
  AttachmentType,
  AppealMessageType,
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
