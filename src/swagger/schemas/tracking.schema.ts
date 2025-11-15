// src/swagger/schemas/tracking.schema.ts

/**
 * OpenAPI-схемы для блока "Tracking" (маршруты и координаты).
 */

const RouteStatusEnum = {
  type: 'string',
  enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
} as const;

const RouteEventTypeEnum = {
  type: 'string',
  enum: ['MOVE', 'STOP'],
} as const;

const TrackingRouteSummary = {
  type: 'object',
  required: ['id', 'status', 'startedAt', 'pointsCount'],
  properties: {
    id: { type: 'integer', example: 1 },
    status: RouteStatusEnum,
    startedAt: {
      type: 'string',
      format: 'date-time',
      example: '2025-08-22T10:00:00.000Z',
    },
    endedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      example: '2025-08-22T11:30:00.000Z',
    },
    pointsCount: { type: 'integer', example: 120 },
  },
} as const;

const TrackingRoutePoint = {
  type: 'object',
  required: ['id', 'latitude', 'longitude', 'recordedAt', 'eventType'],
  properties: {
    id: { type: 'integer', example: 10 },
    latitude: { type: 'number', example: 55.751244 },
    longitude: { type: 'number', example: 37.618423 },
    recordedAt: {
      type: 'string',
      format: 'date-time',
      example: '2025-08-22T10:05:00.000Z',
    },
    eventType: RouteEventTypeEnum,
    accuracy: { type: 'number', nullable: true, example: 5.2 },
    speed: { type: 'number', nullable: true, example: 1.8 },
    heading: { type: 'number', nullable: true, example: 180 },
    stayDurationSeconds: {
      type: 'integer',
      nullable: true,
      example: 120,
    },
    sequence: { type: 'integer', nullable: true, example: 42 },
  },
} as const;

const trackingSchemas = {
  RouteStatusEnum,
  RouteEventTypeEnum,
  TrackingRouteSummary,
  TrackingRoutePoint,
} as const;

export default trackingSchemas;

