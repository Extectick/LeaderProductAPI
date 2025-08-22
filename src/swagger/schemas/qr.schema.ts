// src/swagger/schemas/qr.schema.ts

/**
 * Схемы OpenAPI (components.schemas) для модуля "QR".
 * Используйте их в аннотациях через $ref: '#/components/schemas/...'
 * Ничего в коде роутов менять не требуется.
 */

/** Enum'ы */
const QRTypeEnum = {
  type: 'string',
  enum: ['PHONE', 'LINK', 'EMAIL', 'TEXT', 'WHATSAPP', 'TELEGRAM', 'CONTACT'],
} as const;

const QRStatusEnum = {
  type: 'string',
  enum: ['ACTIVE', 'PAUSED', 'DELETED'],
} as const;

/** Мини-пользователь (совместимо с appeals.UserMini) */
const UserMini = {
  type: 'object',
  required: ['id', 'email'],
  properties: {
    id: { type: 'integer', example: 10 },
    email: { type: 'string', format: 'email', example: 'user@example.com' },
    firstName: { type: 'string', nullable: true, example: 'Ivan' },
    lastName: { type: 'string', nullable: true, example: 'Ivanov' },
  },
} as const;

/** Единичный QR для create/update */
const QRItem = {
  type: 'object',
  required: ['id', 'qrData', 'qrType', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', example: 'AbCd1234' },
    qrData: { type: 'string', example: 'https://example.com' },
    qrType: QRTypeEnum,
    description: { type: 'string', nullable: true, example: 'QR для лендинга' },
    status: QRStatusEnum,
    createdAt: { type: 'string', format: 'date-time', example: '2025-08-22T10:00:00.000Z' },
  },
} as const;

/** Элемент списка QR (+ автор) */
const QRListItem = {
  type: 'object',
  required: ['id', 'qrData', 'qrType', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', example: 'AbCd1234' },
    qrData: { type: 'string', example: 'https://example.com' },
    qrType: QRTypeEnum,
    description: { type: 'string', nullable: true },
    status: QRStatusEnum,
    createdAt: { type: 'string', format: 'date-time' },
    createdBy: {
      ...UserMini,
      nullable: true, // в списке может не запрашиваться
    },
  },
} as const;

/** Totals для универсальной аналитики */
const QRTotals = {
  type: 'object',
  required: ['scans', 'uniqueIPs', 'uniqueDevices'],
  properties: {
    scans: { type: 'integer', example: 345 },
    uniqueIPs: { type: 'integer', example: 210 },
    uniqueDevices: { type: 'integer', example: 180 },
  },
} as const;

/** Точка временного ряда */
const QRSeriesPoint = {
  type: 'object',
  required: ['ts', 'scans'],
  properties: {
    ts: { type: 'string', format: 'date-time', example: '2025-08-22T12:00:00.000Z' },
    scans: { type: 'integer', example: 15 },
  },
} as const;

/** Строка разбивки (группировки) */
const QRBreakdownRow = {
  type: 'object',
  required: ['key', 'scans'],
  properties: {
    key: {
      type: 'object',
      additionalProperties: { type: 'string' }, // произвольные ключи: device/browser/location/qrId
      example: { device: 'mobile', browser: 'Chrome', location: 'Warsaw,PL' },
    },
    scans: { type: 'integer', example: 27 },
  },
} as const;

/** Событие сканирования (для /qr/analytics/scans) */
const QRScanEvent = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'evt_01HTQ4...' },
    qrListId: { type: 'string', example: 'AbCd1234' },
    createdAt: { type: 'string', format: 'date-time' },
    ip: { type: 'string', example: '203.0.113.10' },
    device: { type: 'string', example: 'mobile' },
    browser: { type: 'string', example: 'Chrome 124' },
    location: { type: 'string', example: 'Warsaw,PL' },
    scanDuration: { type: 'number', example: 0.42 },
  },
} as const;

/** Данные ответа на восстановление QR */
const QRRestoreData = {
  type: 'object',
  required: ['id', 'status', 'qrData'],
  properties: {
    id: { type: 'string', example: 'AbCd1234' },
    status: QRStatusEnum,
    qrData: { type: 'string', example: 'https://example.com' },
    description: { type: 'string', nullable: true },
  },
} as const;

/** Экспортируем как набор компонентов для swagger.components.schemas */
const qrSchemas = {
  // enums / базовые
  QRTypeEnum,
  QRStatusEnum,
  UserMini,

  // основные сущности
  QRItem,
  QRListItem,

  // аналитика
  QRTotals,
  QRSeriesPoint,
  QRBreakdownRow,
  QRScanEvent,

  // восстановление
  QRRestoreData,
} as const;

export default qrSchemas;
