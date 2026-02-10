// src/swagger/schemas/appeals.schema.ts

/**
 * Схемы OpenAPI (components.schemas) для модуль "Appeals".
 * Эти схемы описывают структуру поля "data" в ваших обёртках ApiSuccess/ApiError.
 * Используйте их в аннотациях через allOf + $ref, не меняя код обработчиков.
 */

/** Общие enum'ы для обращений */
const AppealStatusEnum = {
  type: 'string',
  enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'COMPLETED', 'DECLINED'],
} as const;

const AppealPriorityEnum = {
  type: 'string',
  enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
} as const;

const AttachmentTypeEnum = {
  type: 'string',
  enum: ['IMAGE', 'AUDIO', 'FILE'],
} as const;

const AppealMessageTypeEnum = {
  type: 'string',
  enum: ['USER', 'SYSTEM'],
} as const;

const DepartmentMini = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'integer', example: 7 },
    name: { type: 'string', example: 'Support' },
  },
} as const;

/** Базовые сущности (минимальные) */
const UserMini = {
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'integer', example: 42 },
    email: { type: 'string', format: 'email', example: 'user@example.com' },
    firstName: { type: 'string', nullable: true, example: 'Ivan' },
    lastName: { type: 'string', nullable: true, example: 'Ivanov' },
    avatarUrl: { type: 'string', nullable: true, example: 'https://api.example.com/files/u/avatar.png' },
    department: { ...DepartmentMini, nullable: true },
    isAdmin: { type: 'boolean', example: false },
    isDepartmentManager: { type: 'boolean', example: false },
  },
} as const;

/** Вложенные сущности для деталей обращения */
const AppealAttachment = {
  type: 'object',
  required: ['fileUrl', 'fileName', 'fileType'],
  properties: {
    id: { type: 'integer', example: 101 },
    fileUrl: { type: 'string', example: 'https://api.example.com/files/uploads/file-123.png?token=...' },
    fileName: { type: 'string', example: 'screenshot.png' },
    fileType: AttachmentTypeEnum,
  },
} as const;

const AppealMessage = {
  type: 'object',
  required: ['id', 'createdAt', 'sender'],
  properties: {
    id: { type: 'integer', example: 555 },
    text: { type: 'string', nullable: true, example: 'Описание проблемы' },
    type: AppealMessageTypeEnum,
    systemEvent: { type: 'object', nullable: true },
    createdAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:00:00.000Z' },
    editedAt: { type: 'string', format: 'date-time', nullable: true },
    sender: UserMini,
    readBy: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId: { type: 'integer', example: 42 },
          readAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    isRead: { type: 'boolean', nullable: true },
    attachments: {
      type: 'array',
      items: AppealAttachment,
    },
  },
} as const;

const AppealStatusHistory = {
  type: 'object',
  required: ['oldStatus', 'newStatus', 'changedAt', 'changedBy'],
  properties: {
    oldStatus: AppealStatusEnum,
    newStatus: AppealStatusEnum,
    changedAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:05:00.000Z' },
    changedBy: UserMini,
  },
} as const;

const AppealAssignee = {
  type: 'object',
  required: ['user'],
  properties: {
    user: UserMini,
  },
} as const;

const AppealWatcher = {
  type: 'object',
  required: ['user'],
  properties: {
    user: UserMini,
  },
} as const;

/* =========================
 * Схемы DATA для ответов
 * ========================= */

/** POST /appeals — data */
const AppealCreateData = {
  type: 'object',
  required: ['id', 'number', 'status', 'priority', 'createdAt'],
  properties: {
    id: { type: 'integer', example: 123 },
    number: { type: 'integer', example: 456 },
    status: { ...AppealStatusEnum, example: 'OPEN' },
    priority: { ...AppealPriorityEnum, example: 'MEDIUM' },
    createdAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:00:00.000Z' },
  },
  example: {
    id: 123,
    number: 456,
    status: 'OPEN',
    priority: 'MEDIUM',
    createdAt: '2025-08-22T10:00:00.000Z',
  },
} as const;

/** GET /appeals — data (список) */
const AppealListItem = {
  type: 'object',
  required: ['id', 'number', 'status', 'priority', 'createdAt'],
  properties: {
    id: { type: 'integer', example: 123 },
    number: { type: 'integer', example: 456 },
    status: AppealStatusEnum,
    priority: AppealPriorityEnum,
    title: { type: 'string', nullable: true, example: 'Не работает принтер' },
    createdAt: { type: 'string', format: 'date-time' },
    fromDepartment: { ...DepartmentMini, nullable: true },
    toDepartment: DepartmentMini,
    assignees: {
      type: 'array',
      items: AppealAssignee,
    },
    lastMessage: { ...AppealMessage, nullable: true },
    unreadCount: { type: 'integer', nullable: true },
  },
} as const;

const AppealListData = {
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'array',
      items: AppealListItem,
    },
    meta: {
      type: 'object',
      required: ['total', 'limit', 'offset'],
      properties: {
        total: { type: 'integer', example: 37 },
        limit: { type: 'integer', example: 20 },
        offset: { type: 'integer', example: 0 },
      },
    },
  },
  example: {
    data: [
      {
        id: 1,
        number: 1001,
        status: 'OPEN',
        priority: 'MEDIUM',
        title: 'Не работает принтер',
        createdAt: '2025-08-22T09:00:00.000Z',
        fromDepartment: { id: 2, name: 'Sales' },
        toDepartment: { id: 7, name: 'Support' },
        assignees: [{ user: { id: 5, email: 'tech@example.com' } }],
      },
    ],
    meta: { total: 37, limit: 20, offset: 0 },
  },
} as const;

/** GET /appeals/{id} — data (детали) */
const AppealDetailData = {
  type: 'object',
  required: [
    'id',
    'number',
    'status',
    'priority',
    'createdAt',
    'toDepartment',
    'createdBy',
    'assignees',
    'watchers',
    'statusHistory',
    'messages',
  ],
  properties: {
    id: { type: 'integer', example: 123 },
    number: { type: 'integer', example: 456 },
    title: { type: 'string', nullable: true },
    status: AppealStatusEnum,
    priority: AppealPriorityEnum,
    createdAt: { type: 'string', format: 'date-time' },
    deadline: { type: 'string', format: 'date-time', nullable: true },
    fromDepartment: { ...DepartmentMini, nullable: true },
    toDepartment: DepartmentMini,
    createdBy: UserMini,
    assignees: {
      type: 'array',
      items: AppealAssignee,
    },
    watchers: {
      type: 'array',
      items: AppealWatcher,
    },
    statusHistory: {
      type: 'array',
      items: AppealStatusHistory,
    },
    messages: {
      type: 'array',
      items: AppealMessage,
    },
  },
} as const;

/** PUT /appeals/{id}/assign — data */
const AppealAssignData = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'integer', example: 123 },
    status: AppealStatusEnum,
  },
  example: { id: 123, status: 'IN_PROGRESS' },
} as const;

/** PUT /appeals/{id}/status — data */
const AppealStatusUpdateData = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'integer', example: 123 },
    status: AppealStatusEnum,
  },
  example: { id: 123, status: 'RESOLVED' },
} as const;

/** POST /appeals/{id}/messages — data */
const AppealAddMessageData = {
  type: 'object',
  required: ['id', 'createdAt'],
  properties: {
    id: { type: 'integer', example: 555 },
    createdAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:15:00.000Z' },
  },
} as const;

/** PUT /appeals/{id}/watchers — data */
const AppealWatchersUpdateData = {
  type: 'object',
  required: ['id', 'watchers'],
  properties: {
    id: { type: 'integer', example: 123 },
    watchers: {
      type: 'array',
      items: { type: 'integer' },
      example: [3, 4, 8],
    },
  },
} as const;

/** PUT /appeals/messages/{messageId} — data */
const AppealEditMessageData = {
  type: 'object',
  required: ['id', 'editedAt'],
  properties: {
    id: { type: 'integer', example: 555 },
    editedAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:20:00.000Z' },
  },
} as const;

/** DELETE /appeals/messages/{messageId} — data */
const AppealDeleteMessageData = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', example: 555 },
  },
} as const;

/** GET /appeals/counters — data */
const AppealCountersData = {
  type: 'object',
  required: ['my', 'department'],
  properties: {
    my: {
      type: 'object',
      required: ['activeCount', 'unreadMessagesCount'],
      properties: {
        activeCount: { type: 'integer', example: 4 },
        unreadMessagesCount: { type: 'integer', example: 9 },
      },
    },
    department: {
      type: 'object',
      required: ['available', 'activeCount', 'unreadMessagesCount'],
      properties: {
        available: { type: 'boolean', example: true },
        activeCount: { type: 'integer', example: 12 },
        unreadMessagesCount: { type: 'integer', example: 21 },
      },
    },
  },
} as const;

/**
 * Экспортируем как набор компонентов для swagger.components.schemas
 * Пример использования:
 *   components.schemas = { ...appealsSchemas }
 */
const appealsSchemas = {
  // enums / базовые
  AppealStatusEnum,
  AppealPriorityEnum,
  AttachmentTypeEnum,
  AppealMessageTypeEnum,
  UserMini,
  DepartmentMini,
  AppealAttachment,
  AppealMessage,
  AppealStatusHistory,
  AppealAssignee,
  AppealWatcher,

  // data-схемы для ответов
  AppealCreateData,
  AppealListItem,
  AppealListData,
  AppealDetailData,
  AppealAssignData,
  AppealStatusUpdateData,
  AppealAddMessageData,
  AppealWatchersUpdateData,
  AppealEditMessageData,
  AppealDeleteMessageData,
  AppealCountersData,
} as const;

export default appealsSchemas;
