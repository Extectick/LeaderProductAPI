import express from 'express';
import { ActionType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import prisma from '../prisma/client';
import {
  authenticateToken,
  AuthRequest,
  authorizeRoles,
} from '../middleware/auth';
import { authorizeServiceAccess } from '../middleware/serviceAccess';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { rateLimit } from '../middleware/rateLimit';
import {
  errorResponse,
  ErrorCodes,
  successResponse,
} from '../utils/apiResponse';
import {
  SaveTrackingPointsRequest,
  SaveTrackingPointsResponse,
  GetUserRoutesQuery,
  GetUserRoutesResponse,
  GetRoutePointsQuery,
  GetRoutePointsResponse,
  RoutePointDto,
  GetDailyTrackingStatsQuery,
  GetDailyTrackingStatsResponse,
  GetUserRoutesWithPointsQuery,
  GetUserRoutesWithPointsResponse,
  GetUserPointsQuery,
  GetUserPointsResponse,
  StartTrackingSessionResponse,
  StopTrackingSessionRequest,
  StopTrackingSessionResponse,
  TrackingSessionDto,
  TrackingStatusResponse,
} from '../types/routes';

const router = express.Router();

const MAX_POINTS_BATCH = 1000;
const DEFAULT_MAX_ACCURACY_METERS = 100;
const MIN_DISTANCE_METERS = 5;
const MIN_MOVING_DISTANCE_METERS = 12;
const MIN_MOVING_INTERVAL_MS = 12_000;
const STATIONARY_ALIVE_INTERVAL_MS = 90_000;
const ACTIVE_DEVICE_STALE_MS = 15 * 60_000;
const TRACKING_DEVICE_TOKEN_PREFIX = 'lpt_';
const TRACKING_DEVICE_TOKEN_TTL_DAYS = Number(process.env.TRACKING_DEVICE_TOKEN_TTL_DAYS || 180);

type NativeTrackingTokenRequest = {
  installId?: string | null;
  deviceSessionId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  deviceName?: string | null;
  reason?: 'start' | 'repair' | 'token_invalid' | null;
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function generateTrackingDeviceToken() {
  return `${TRACKING_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function hashTrackingDeviceToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function readBearerToken(req: express.Request) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const fallback = req.headers['x-tracking-token'];
  return typeof fallback === 'string' ? fallback.trim() : undefined;
}

function cleanTokenMeta(value?: string | null) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

type TrackingRouteLike = {
  id: number;
  userId: number;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  startedAt: Date;
  endedAt?: Date | null;
};

function mapRouteToSessionDto(
  route: {
    id: number;
    status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
    startedAt: Date;
    endedAt?: Date | null;
  },
  pointsCount?: number
): TrackingSessionDto {
  return {
    id: route.id,
    status: route.status,
    startedAt: route.startedAt.toISOString(),
    endedAt: route.endedAt ? route.endedAt.toISOString() : null,
    pointsCount,
  };
}

function mapRoutePointToDto(point: {
  id: number;
  routeId: number;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  recordedTimeZone?: string | null;
  recordedTimezoneOffsetMinutes?: number | null;
  eventType: 'MOVE' | 'STOP';
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  stayDurationSeconds?: number | null;
  sequence?: number | null;
}): RoutePointDto {
  return {
    id: point.id,
    routeId: point.routeId,
    latitude: point.latitude,
    longitude: point.longitude,
    recordedAt: point.recordedAt.toISOString(),
    recordedTimeZone: point.recordedTimeZone ?? null,
    recordedTimezoneOffsetMinutes: point.recordedTimezoneOffsetMinutes ?? null,
    eventType: point.eventType,
    accuracy: point.accuracy,
    speed: point.speed,
    heading: point.heading,
    stayDurationSeconds: point.stayDurationSeconds,
    sequence: point.sequence,
  };
}

async function writeTrackingAudit(
  db: any,
  userId: number,
  trackingAction: 'START' | 'STOP' | 'POINTS' | 'TOKEN_ISSUED' | 'TOKEN_REVOKED' | 'UPLOAD_REJECTED',
  routeId?: number | null,
  details?: Record<string, unknown>
) {
  try {
    await db.auditLog.create({
      data: {
        userId,
        action: ActionType.OTHER,
        targetType: 'USER_ROUTE',
        targetId: routeId ?? undefined,
        details: JSON.stringify({
          trackingAction,
          ...details,
        }),
      },
    });
  } catch (error) {
    console.warn('[tracking] audit write failed', error);
  }
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseTimezoneOffsetMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= -14 * 60 && rounded <= 14 * 60 ? rounded : undefined;
}

function parseTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > 128) return undefined;
  if (!/^[A-Za-z0-9_+\-./]+$/.test(text)) return undefined;
  return text;
}

function clampRouteEndAt(route: { startedAt: Date }, candidate?: Date | null) {
  const endAt = candidate ?? new Date();
  return endAt < route.startedAt ? route.startedAt : endAt;
}

async function ensureRouteStartedAtCoversPoint<T extends TrackingRouteLike>(
  db: any,
  route: T,
  firstPointAt: Date
): Promise<T> {
  if (firstPointAt >= route.startedAt) return route;
  return db.userRoute.update({
    where: { id: route.id },
    data: { startedAt: firstPointAt },
  }) as Promise<T>;
}

function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * @openapi
 * tags:
 *   - name: Tracking
 *     description: Маршруты и трекинг геопозиции пользователей
 */

router.post(
  '/sessions/start',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 60 }),
  async (
    req: AuthRequest<{}, StartTrackingSessionResponse, {}>,
    res: express.Response<StartTrackingSessionResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      let created = false;
      const route = await prisma.$transaction(async (tx) => {
        let active = await tx.userRoute.findFirst({
          where: { userId, status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
        });

        if (!active) {
          created = true;
          active = await tx.userRoute.create({
            data: {
              userId,
              status: 'ACTIVE',
              startedAt: new Date(),
            },
          });
        }

        await writeTrackingAudit(tx, userId, 'START', active.id, {
          created,
        });
        return active;
      });

      const pointsCount = await prisma.routePoint.count({
        where: { routeId: route.id, userId },
      });

      return res.json(
        successResponse(
          { route: mapRouteToSessionDto(route, pointsCount) },
          'Сессия отслеживания маршрута активна'
        )
      );
    } catch (err) {
      console.error('Ошибка старта сессии отслеживания:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка старта сессии отслеживания',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

router.post(
  '/sessions/stop',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 60 }),
  async (
    req: AuthRequest<{}, StopTrackingSessionResponse, StopTrackingSessionRequest>,
    res: express.Response<StopTrackingSessionResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const rawRouteId = req.body?.routeId;
      const routeId =
        rawRouteId === undefined || rawRouteId === null
          ? undefined
          : Number(rawRouteId);

      if (routeId !== undefined && (!Number.isInteger(routeId) || routeId <= 0)) {
        return res
          .status(400)
          .json(errorResponse('routeId должен быть положительным целым числом', ErrorCodes.VALIDATION_ERROR));
      }

      const route = await prisma.$transaction(async (tx) => {
        let active = routeId
          ? await tx.userRoute.findFirst({ where: { id: routeId, userId } })
          : await tx.userRoute.findFirst({
              where: { userId, status: 'ACTIVE' },
              orderBy: { startedAt: 'desc' },
            });

        if (!active) return null;

        if (active.status !== 'ACTIVE') {
          await writeTrackingAudit(tx, userId, 'STOP', active.id, {
            alreadyClosed: true,
            status: active.status,
          });
          return active;
        }

        const lastPoint = await tx.routePoint.findFirst({
          where: { routeId: active.id, userId },
          orderBy: { recordedAt: 'desc' },
        });
        const firstPoint = await tx.routePoint.findFirst({
          where: { routeId: active.id, userId },
          orderBy: { recordedAt: 'asc' },
        });
        if (firstPoint) {
          active = await ensureRouteStartedAtCoversPoint(tx, active, firstPoint.recordedAt);
        }

        active = await tx.userRoute.update({
          where: { id: active.id },
          data: {
            status: 'COMPLETED',
            endedAt: clampRouteEndAt(active, lastPoint?.recordedAt),
          },
        });

        await writeTrackingAudit(tx, userId, 'STOP', active.id, {
          lastPointAt: lastPoint?.recordedAt?.toISOString() ?? null,
        });
        return active;
      });

      const pointsCount = route
        ? await prisma.routePoint.count({ where: { routeId: route.id, userId } })
        : 0;

      return res.json(
        successResponse(
          { route: route ? mapRouteToSessionDto(route, pointsCount) : null },
          route ? 'Сессия отслеживания маршрута остановлена' : 'Активная сессия отслеживания не найдена'
        )
      );
    } catch (err) {
      console.error('Ошибка остановки сессии отслеживания:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка остановки сессии отслеживания',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

router.get(
  '/status',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{}, TrackingStatusResponse>,
    res: express.Response<TrackingStatusResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
      const [activeRoute, lastRoute, lastPoint, todayPointsCount, nativeToken, tokenIssueCountLastHour] = await Promise.all([
        prisma.userRoute.findFirst({
          where: { userId, status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.userRoute.findFirst({
          where: { userId },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.routePoint.findFirst({
          where: { userId },
          orderBy: { recordedAt: 'desc' },
        }),
        prisma.routePoint.count({
          where: { userId, recordedAt: { gte: todayStart } },
        }),
        prisma.trackingDeviceToken.findFirst({
          where: {
            userId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
        }),
        prisma.trackingDeviceToken.count({
          where: { userId, createdAt: { gte: oneHourAgo } },
        }),
      ]);

      const activePointsCount = activeRoute
        ? await prisma.routePoint.count({ where: { routeId: activeRoute.id, userId } })
        : 0;
      const lastRoutePointsCount = lastRoute
        ? activeRoute && lastRoute.id === activeRoute.id
          ? activePointsCount
          : await prisma.routePoint.count({ where: { routeId: lastRoute.id, userId } })
        : 0;

      return res.json(
        successResponse(
          {
            serverTime: new Date().toISOString(),
            activeRoute: activeRoute ? mapRouteToSessionDto(activeRoute, activePointsCount) : null,
            lastRoute: lastRoute ? mapRouteToSessionDto(lastRoute, lastRoutePointsCount) : null,
            lastPoint: lastPoint ? mapRoutePointToDto(lastPoint) : null,
            activePointsCount,
            todayPointsCount,
            nativeDevice: nativeToken
              ? {
                  active: true,
                  installId: nativeToken.installId,
                  platform: nativeToken.platform,
                  appVersion: nativeToken.appVersion,
                  lastUploadAt: nativeToken.lastUsedAt?.toISOString() ?? null,
                  tokenExpiresAt: nativeToken.expiresAt?.toISOString() ?? null,
                  stale: !nativeToken.lastUsedAt || now.getTime() - nativeToken.lastUsedAt.getTime() > ACTIVE_DEVICE_STALE_MS,
                  tokenIssueCountLastHour,
                }
              : null,
          },
          'Статус отслеживания получен'
        )
      );
    } catch (err) {
      console.error('Ошибка получения статуса отслеживания:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения статуса отслеживания',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

async function authenticateTrackingDeviceToken(
  req: AuthRequest<{}, SaveTrackingPointsResponse, SaveTrackingPointsRequest>,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      return res
        .status(401)
        .json(errorResponse('Требуется токен трекинга', ErrorCodes.UNAUTHORIZED));
    }

    const tokenRecord = await prisma.trackingDeviceToken.findUnique({
      where: { tokenHash: hashTrackingDeviceToken(token) },
      include: {
        user: {
          select: {
            id: true,
            isActive: true,
            profileStatus: true,
          },
        },
      },
    });

    const now = new Date();
    if (
      !tokenRecord ||
      tokenRecord.revokedAt ||
      (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)
    ) {
      return res
        .status(401)
        .json(errorResponse('Токен трекинга недействителен', ErrorCodes.UNAUTHORIZED));
    }

    if (!tokenRecord.user?.isActive) {
      return res
        .status(403)
        .json(errorResponse('Пользователь отключен', ErrorCodes.FORBIDDEN));
    }

    req.user = {
      userId: tokenRecord.userId,
      role: 'tracking-device',
      permissions: [],
      profileStatus: tokenRecord.user.profileStatus,
      iat: 0,
      exp: Math.floor((tokenRecord.expiresAt?.getTime() || now.getTime() + 60_000) / 1000),
    };

    void prisma.trackingDeviceToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: now },
      })
      .catch((error) => console.warn('[tracking] device token touch failed', error));

    return next();
  } catch (error) {
    console.error('[tracking] native token auth failed', error);
    return res
      .status(500)
      .json(errorResponse('Ошибка проверки токена трекинга', ErrorCodes.INTERNAL_ERROR));
  }
}

router.post(
  '/native-token',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 30 }),
  async (
    req: AuthRequest<{}, { ok: boolean }, NativeTrackingTokenRequest>,
    res
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const now = new Date();
      const token = generateTrackingDeviceToken();
      const expiresAt = addDays(now, Number.isFinite(TRACKING_DEVICE_TOKEN_TTL_DAYS) ? TRACKING_DEVICE_TOKEN_TTL_DAYS : 180);
      const installId = cleanTokenMeta(req.body?.installId);
      const deviceSessionId = cleanTokenMeta(req.body?.deviceSessionId);
      const requestedReason = cleanTokenMeta(req.body?.reason);
      const issueReason = requestedReason === 'start' || requestedReason === 'repair' || requestedReason === 'token_invalid'
        ? requestedReason
        : 'repair';
      const revokeOr = [
        installId ? { installId } : undefined,
        deviceSessionId ? { deviceSessionId } : undefined,
      ].filter(Boolean) as Array<{ installId?: string; deviceSessionId?: string }>;

      // A healthy application never asks for more than one token per install.
      // Keep a small recovery allowance, then reject a loop before it revokes
      // the working device credential again and again.
      const recentIssueCount = await prisma.trackingDeviceToken.count({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 15 * 60_000) },
          ...(revokeOr.length > 0 ? { OR: revokeOr } : {}),
        },
      });
      if (recentIssueCount >= 3) {
        await writeTrackingAudit(prisma, userId, 'UPLOAD_REJECTED', null, {
          reason: 'TOKEN_CHURN_RATE_LIMIT',
          installId,
          deviceSessionId,
          recentIssueCount,
        });
        return res.status(429).json(
          errorResponse('Слишком частое обновление токена трекинга. Откройте приложение позже.', ErrorCodes.TOO_MANY_REQUESTS)
        );
      }

      await prisma.$transaction(async (tx) => {
        const revoked = revokeOr.length > 0
          ? await tx.trackingDeviceToken.updateMany({
              where: {
                userId,
                revokedAt: null,
                OR: revokeOr,
              },
              data: { revokedAt: now },
            })
          : { count: 0 };

        await tx.trackingDeviceToken.create({
          data: {
            tokenHash: hashTrackingDeviceToken(token),
            userId,
            installId,
            deviceSessionId,
            platform: cleanTokenMeta(req.body?.platform),
            appVersion: cleanTokenMeta(req.body?.appVersion),
            deviceName: cleanTokenMeta(req.body?.deviceName),
            issueReason,
            expiresAt,
          },
        });
        await writeTrackingAudit(tx, userId, 'TOKEN_ISSUED', null, {
          installId,
          deviceSessionId,
          issueReason,
          revokedActiveTokens: revoked.count,
          expiresAt: expiresAt.toISOString(),
        });
      });

      return res.json(
        successResponse(
          {
            token,
            expiresAt: expiresAt.toISOString(),
            endpoint: '/tracking/native/points',
          },
          'Токен фонового трекинга создан'
        )
      );
    } catch (error) {
      console.error('[tracking] native token issue failed', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка создания токена фонового трекинга', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.delete(
  '/native-token',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 60 }),
  async (
    req: AuthRequest<{}, { ok: boolean }, NativeTrackingTokenRequest & { token?: string }>,
    res
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const now = new Date();
      const token = cleanTokenMeta(req.body?.token);
      const installId = cleanTokenMeta(req.body?.installId);
      const deviceSessionId = cleanTokenMeta(req.body?.deviceSessionId);
      const revokeOr = [
        token ? { tokenHash: hashTrackingDeviceToken(token) } : undefined,
        installId ? { installId } : undefined,
        deviceSessionId ? { deviceSessionId } : undefined,
      ].filter(Boolean) as Array<{ tokenHash?: string; installId?: string; deviceSessionId?: string }>;

      const result = await prisma.trackingDeviceToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(revokeOr.length > 0 ? { OR: revokeOr } : {}),
        },
        data: { revokedAt: now },
      });

      if (result.count > 0) {
        await writeTrackingAudit(prisma, userId, 'TOKEN_REVOKED', null, {
          installId,
          deviceSessionId,
          revoked: result.count,
        });
      }

      return res.json(
        successResponse(
          { revoked: result.count },
          'Токены фонового трекинга отозваны'
        )
      );
    } catch (error) {
      console.error('[tracking] native token revoke failed', error);
      return res
        .status(500)
        .json(errorResponse('Ошибка отзыва токена фонового трекинга', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

/**
 * @openapi
 * /tracking/points:
 *   post:
 *     tags: [Tracking]
 *     summary: Сохранить точки маршрута текущего пользователя
 *     description: >
 *       Принимает массив геоточек (широта, долгота, время фиксации) от текущего
 *       авторизованного пользователя и сохраняет их в базе. Можно передать
 *       существующий `routeId`, начать новый маршрут (`startNewRoute=true`)
 *       или продолжить последний активный маршрут пользователя.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               points:
 *                 type: array
 *                 description: Массив точек геолокации
 *                 items:
 *                   type: object
 *                   required: [latitude, longitude, recordedAt]
 *                   properties:
 *                     latitude:
 *                       type: number
 *                       example: 55.751244
 *                     longitude:
 *                       type: number
 *                       example: 37.618423
 *                     recordedAt:
 *                       type: string
 *                       format: date-time
 *                       description: Время фиксации (ISO 8601)
 *                     eventType:
 *                       type: string
 *                       enum: [MOVE, STOP]
 *                       description: Тип события (движение или остановка)
 *                     accuracy:
 *                       type: number
 *                       nullable: true
 *                     speed:
 *                       type: number
 *                       nullable: true
 *                     heading:
 *                       type: number
 *                       nullable: true
 *                     stayDurationSeconds:
 *                       type: integer
 *                       nullable: true
 *     responses:
 *       200:
 *         description: Точки успешно сохранены
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         routeId:      { type: integer }
 *                         createdPoints:{ type: integer }
 *                         routeStatus:
 *                           type: string
 *                           enum: [ACTIVE, COMPLETED, CANCELLED]
 *       400:
 *         description: Ошибка валидации данных
 *       401:
 *         description: Не авторизован
 *       403:
 *         description: Доступ запрещён
 */
const saveTrackingPointsHandler = async (
  req: AuthRequest<{}, SaveTrackingPointsResponse, SaveTrackingPointsRequest>,
  res: express.Response<SaveTrackingPointsResponse>
) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { points, routeId, startNewRoute, endRoute } = req.body || {};

      if (!Array.isArray(points) || points.length === 0) {
        return res.status(400).json(
          errorResponse(
            'Поле points должно быть непустым массивом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (points.length > MAX_POINTS_BATCH) {
        return res.status(400).json(
          errorResponse(
            `Превышен максимальный размер batch: ${MAX_POINTS_BATCH} точек`,
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const parsedPoints: {
        clientPointId?: string;
        latitude: number;
        longitude: number;
        recordedAt: Date;
        recordedTimeZone?: string;
        recordedTimezoneOffsetMinutes?: number;
        eventType: 'MOVE' | 'STOP';
        accuracy?: number;
        speed?: number;
        heading?: number;
        stayDurationSeconds?: number;
      }[] = [];

      for (const p of points) {
        if (
          typeof p.latitude !== 'number' ||
          typeof p.longitude !== 'number' ||
          typeof p.recordedAt !== 'string'
        ) {
          return res.status(400).json(
            errorResponse(
              'Некорректные данные точки: latitude, longitude и recordedAt обязательны',
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }

        const recordedAtDate = parseDate(p.recordedAt);
        if (!recordedAtDate) {
          return res.status(400).json(
            errorResponse(
              'Некорректное значение recordedAt (ожидается строка в формате ISO 8601)',
              ErrorCodes.VALIDATION_ERROR
            )
          );
        }

        let eventType: 'MOVE' | 'STOP' = 'MOVE';
        if (p.eventType) {
          if (p.eventType !== 'MOVE' && p.eventType !== 'STOP') {
            return res.status(400).json(
              errorResponse(
                'eventType должен быть MOVE или STOP',
                ErrorCodes.VALIDATION_ERROR
              )
            );
          }
          eventType = p.eventType;
        }

        parsedPoints.push({
          clientPointId: typeof p.clientPointId === 'string' && p.clientPointId.trim() ? p.clientPointId.trim() : undefined,
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAt: recordedAtDate,
          recordedTimeZone: parseTimeZone(p.recordedTimeZone),
          recordedTimezoneOffsetMinutes: parseTimezoneOffsetMinutes(p.recordedTimezoneOffsetMinutes),
          eventType,
          accuracy:
            typeof p.accuracy === 'number' ? p.accuracy : undefined,
          speed: typeof p.speed === 'number' ? p.speed : undefined,
          heading:
            typeof p.heading === 'number' ? p.heading : undefined,
          stayDurationSeconds:
            typeof p.stayDurationSeconds === 'number'
              ? p.stayDurationSeconds
              : undefined,
        });
      }

      let targetRouteId: number | undefined;
      let routeStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' = 'ACTIVE';
      let createdPoints = 0;
      let rejectedAccuracyPoints = 0;
      let rejectedDuplicatePoints = 0;
      let rejectedJitterPoints = 0;

      await prisma.$transaction(async (tx) => {
        // Всегда используем один непрерывный активный маршрут пользователя,
        // чтобы писать точки круглосуточно. Если нет - создаём.
        let active = routeId
          ? await tx.userRoute.findFirst({
              where: { id: routeId, userId },
            })
          : null;

        if (active && active.status !== 'ACTIVE' && !endRoute) {
          active = null;
        }

        if (!active && startNewRoute) {
          const previousActive = await tx.userRoute.findFirst({
            where: { userId, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
          });
          if (previousActive) {
            await tx.userRoute.update({
              where: { id: previousActive.id },
              data: {
                status: 'COMPLETED',
                endedAt: clampRouteEndAt(previousActive, parsedPoints[0]?.recordedAt),
              },
            });
          }
        }

        if (!active && !startNewRoute) {
          active = await tx.userRoute.findFirst({
            where: { userId, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
          });
        }
        const lastSavedPoint = active
          ? await tx.routePoint.findFirst({
              where: { routeId: active.id, userId },
              orderBy: { recordedAt: 'desc' },
            })
          : null;
        const firstSavedPoint = active
          ? await tx.routePoint.findFirst({
              where: { routeId: active.id, userId },
              orderBy: { recordedAt: 'asc' },
            })
          : null;

        const incomingClientPointIds = parsedPoints
          .map((p) => p.clientPointId)
          .filter((id): id is string => Boolean(id));
        const duplicateClientPointIds = incomingClientPointIds.length
          ? new Set(
              (
                await tx.routePoint.findMany({
                  where: {
                    userId,
                    clientPointId: { in: incomingClientPointIds },
                  },
                  select: { clientPointId: true },
                })
              )
                .map((p) => p.clientPointId)
                .filter((id): id is string => Boolean(id))
            )
          : new Set<string>();

        const filteredPoints: typeof parsedPoints = [];
        const seenClientPointIds = new Set<string>();
        for (const p of parsedPoints) {
          if (
            (p.clientPointId && duplicateClientPointIds.has(p.clientPointId)) ||
            (p.clientPointId && seenClientPointIds.has(p.clientPointId))
          ) {
            rejectedDuplicatePoints += 1;
            continue;
          }
          if (p.clientPointId) seenClientPointIds.add(p.clientPointId);
          if (p.accuracy !== undefined && p.accuracy > DEFAULT_MAX_ACCURACY_METERS) {
            rejectedAccuracyPoints += 1;
            continue;
          }
          const prev = filteredPoints.length
            ? filteredPoints[filteredPoints.length - 1]
            : lastSavedPoint;
          if (prev && p.eventType !== 'STOP') {
            const distance = haversineDistanceMeters(
              prev.latitude,
              prev.longitude,
              p.latitude,
              p.longitude
            );
            const elapsed = Math.max(0, p.recordedAt.getTime() - prev.recordedAt.getTime());
            const isJitter =
              (distance < MIN_DISTANCE_METERS && elapsed < STATIONARY_ALIVE_INTERVAL_MS) ||
              (distance < MIN_MOVING_DISTANCE_METERS && elapsed < MIN_MOVING_INTERVAL_MS);
            if (isJitter) {
              rejectedJitterPoints += 1;
              continue;
            }
          }
          filteredPoints.push(p);
        }

        if (!filteredPoints.length) {
          if (!active) {
            const fallbackStartedAt = parsedPoints[0].recordedAt;
            active = await tx.userRoute.create({
              data: {
                userId,
                startedAt: fallbackStartedAt,
                status: 'ACTIVE',
              },
            });
          } else if (firstSavedPoint) {
            active = await ensureRouteStartedAtCoversPoint(tx, active, firstSavedPoint.recordedAt);
          }
          if (endRoute && active.status === 'ACTIVE') {
            active = await tx.userRoute.update({
              where: { id: active.id },
              data: {
                status: 'COMPLETED',
                endedAt: clampRouteEndAt(active, parsedPoints[parsedPoints.length - 1]?.recordedAt),
              },
            });
            await writeTrackingAudit(tx, userId, 'STOP', active.id, {
              createdPoints: 0,
              rejectedAccuracyPoints,
              rejectedDuplicatePoints,
              rejectedJitterPoints,
            });
          }
          targetRouteId = active.id;
          routeStatus = active.status;
          if (rejectedAccuracyPoints || rejectedDuplicatePoints || rejectedJitterPoints) {
            await writeTrackingAudit(tx, userId, 'UPLOAD_REJECTED', active.id, {
              source: req.user?.role === 'tracking-device' ? 'native' : 'app',
              receivedPoints: parsedPoints.length,
              rejectedAccuracyPoints,
              rejectedDuplicatePoints,
              rejectedJitterPoints,
            });
          }
          return;
        }

        const minTs =
          filteredPoints.reduce(
            (min, p) =>
              p.recordedAt < min ? p.recordedAt : min,
            filteredPoints[0].recordedAt
          );
        const maxTs =
          filteredPoints.reduce(
            (max, p) =>
              p.recordedAt > max ? p.recordedAt : max,
            filteredPoints[0].recordedAt
          );

        if (!active) {
          active = await tx.userRoute.create({
            data: {
              userId,
              startedAt: minTs,
              status: 'ACTIVE',
            },
          });
        } else {
          const firstPointAt =
            firstSavedPoint && firstSavedPoint.recordedAt < minTs
              ? firstSavedPoint.recordedAt
              : minTs;
          active = await ensureRouteStartedAtCoversPoint(tx, active, firstPointAt);
        }
        targetRouteId = active.id;
        routeStatus = active.status;

        const existingPointsCount = await tx.routePoint.count({
          where: { routeId: targetRouteId },
        });

        const data = filteredPoints.map((p, idx) => ({
          routeId: targetRouteId!,
          userId,
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAt: p.recordedAt,
          recordedTimeZone: p.recordedTimeZone,
          recordedTimezoneOffsetMinutes: p.recordedTimezoneOffsetMinutes,
          eventType: p.eventType,
          accuracy: p.accuracy,
          speed: p.speed,
          heading: p.heading,
          stayDurationSeconds: p.stayDurationSeconds,
          clientPointId: p.clientPointId,
          sequence: existingPointsCount + idx + 1,
        }));

        const insertResult = await tx.routePoint.createMany({ data, skipDuplicates: true });
        createdPoints = insertResult.count;
        await writeTrackingAudit(tx, userId, 'POINTS', targetRouteId, {
          createdPoints,
          receivedPoints: parsedPoints.length,
          endRoute: Boolean(endRoute),
          source: req.user?.role === 'tracking-device' ? 'native' : 'app',
          rejectedAccuracyPoints,
          rejectedDuplicatePoints,
          rejectedJitterPoints,
        });

        if (endRoute && active.status === 'ACTIVE') {
          active = await tx.userRoute.update({
            where: { id: active.id },
            data: {
              status: 'COMPLETED',
              endedAt: clampRouteEndAt(active, maxTs),
            },
          });
          await writeTrackingAudit(tx, userId, 'STOP', active.id, {
            createdPoints,
            endedAt: clampRouteEndAt(active, maxTs).toISOString(),
          });
          routeStatus = active.status;
        }
      });

      if (createdPoints === 0) {
        return res.json(
          successResponse(
            {
              routeId: targetRouteId!,
              createdPoints: 0,
              routeStatus,
            },
            'Новые точки не сохранены: смещение менее 5 метров'
          )
        );
      }

      return res.json(
        successResponse(
          {
            routeId: targetRouteId!,
            createdPoints,
            routeStatus: routeStatus!,
          },
          'Точки маршрута успешно сохранены'
        )
      );
    } catch (err: any) {
      if (err && err.error && err.error.code) {
        // Это уже готовый errorResponse из транзакции
        const status =
          err.error.code === ErrorCodes.NOT_FOUND
            ? 404
            : 400;
        return res.status(status).json(err);
      }

      console.error('Ошибка сохранения точек маршрута:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка сохранения точек маршрута',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
};

router.post(
  '/points',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 600 }),
  saveTrackingPointsHandler
);

router.post(
  '/native/points',
  authenticateTrackingDeviceToken,
  authorizeServiceAccess('tracking'),
  rateLimit({ windowSec: 60, limit: 1200 }),
  saveTrackingPointsHandler
);

/**
 * Compact operational view for administrators. It deliberately exposes no
 * device token or route coordinates, only the health signals needed to react
 * to a stalled collector.
 */
router.get(
  '/admin/health',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (req: AuthRequest<{}, any, {}, { limit?: string }>, res) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (!role.includes('admin')) {
      return res.status(403).json(
        errorResponse('Недостаточно прав для просмотра состояния трекинга', ErrorCodes.FORBIDDEN)
      );
    }
    try {
      const requestedLimit = Number(req.query.limit || 50);
      const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, Math.floor(requestedLimit))) : 50;
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
      const devices = await prisma.trackingDeviceToken.findMany({
        where: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              middleName: true,
              email: true,
            },
          },
        },
      });
      const [activeDevices, staleDevices, tokenIssuesLastHour] = await Promise.all([
        prisma.trackingDeviceToken.count({
          where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        }),
        prisma.trackingDeviceToken.count({
          where: {
            revokedAt: null,
            OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - ACTIVE_DEVICE_STALE_MS) } }],
          },
        }),
        prisma.trackingDeviceToken.count({ where: { createdAt: { gte: oneHourAgo } } }),
      ]);
      return res.json(successResponse({
        serverTime: now.toISOString(),
        thresholds: { staleAfterMinutes: ACTIVE_DEVICE_STALE_MS / 60_000 },
        summary: { activeDevices, staleDevices, tokenIssuesLastHour },
        devices: devices.map((device) => ({
          id: device.id,
          user: device.user,
          installId: device.installId,
          platform: device.platform,
          appVersion: device.appVersion,
          issueReason: device.issueReason,
          createdAt: device.createdAt.toISOString(),
          lastUploadAt: device.lastUsedAt?.toISOString() ?? null,
          expiresAt: device.expiresAt?.toISOString() ?? null,
          stale: !device.lastUsedAt || now.getTime() - device.lastUsedAt.getTime() > ACTIVE_DEVICE_STALE_MS,
        })),
      }, 'Состояние устройств трекинга получено'));
    } catch (error) {
      console.error('[tracking] admin health failed', error);
      return res.status(500).json(
        errorResponse('Не удалось получить состояние устройств трекинга', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /tracking/routes/{routeId}/stops:
 *   get:
 *     tags: [Tracking]
 *     summary: Получить остановки маршрута
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: routeId
 *         required: true
 *         schema: { type: integer }
 *         description: ID маршрута
 *     responses:
 *       200:
 *         description: Список остановок маршрута
 *       400:
 *         description: Ошибка валидации параметров
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Маршрут не найден или не принадлежит пользователю
 */
router.get(
  '/routes/:routeId/stops',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (req: AuthRequest<{ routeId: string }>, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { routeId } = req.params;
      const idNum = parseInt(routeId, 10);
      if (isNaN(idNum)) {
        return res.status(400).json(
          errorResponse(
            'routeId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const route = await prisma.userRoute.findFirst({
        where: { id: idNum, userId },
      });

      if (!route) {
        return res.status(404).json(
          errorResponse(
            'Маршрут не найден или не принадлежит пользователю',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const points = await prisma.routePoint.findMany({
        where: { routeId: idNum, userId },
        orderBy: { recordedAt: 'asc' },
      });

      const MIN_STOP_DURATION_SEC = 60;
      const MAX_STOP_RADIUS_METERS = 30;

      type StopAgg = {
        latitude: number;
        longitude: number;
        startedAt: string;
        endedAt: string;
        durationSeconds: number;
      };

      const stops: StopAgg[] = [];

      if (points.length > 0) {
        let clusterStartIndex = 0;
        let clusterLatSum = points[0].latitude;
        let clusterLonSum = points[0].longitude;
        let clusterCount = 1;

        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];

          const dist = haversineDistanceMeters(
            prev.latitude,
            prev.longitude,
            curr.latitude,
            curr.longitude
          );

          if (dist <= MAX_STOP_RADIUS_METERS) {
            clusterLatSum += curr.latitude;
            clusterLonSum += curr.longitude;
            clusterCount += 1;
          } else {
            const start = points[clusterStartIndex].recordedAt;
            const end = prev.recordedAt;
            const durationSec =
              (end.getTime() - start.getTime()) / 1000;
            if (durationSec >= MIN_STOP_DURATION_SEC) {
              stops.push({
                latitude: clusterLatSum / clusterCount,
                longitude: clusterLonSum / clusterCount,
                startedAt: start.toISOString(),
                endedAt: end.toISOString(),
                durationSeconds: Math.round(durationSec),
              });
            }
            clusterStartIndex = i;
            clusterLatSum = curr.latitude;
            clusterLonSum = curr.longitude;
            clusterCount = 1;
          }
        }

        const lastStart = points[clusterStartIndex].recordedAt;
        const lastEnd = points[points.length - 1].recordedAt;
        const lastDurationSec =
          (lastEnd.getTime() - lastStart.getTime()) / 1000;
        if (lastDurationSec >= MIN_STOP_DURATION_SEC) {
          stops.push({
            latitude: clusterLatSum / clusterCount,
            longitude: clusterLonSum / clusterCount,
            startedAt: lastStart.toISOString(),
            endedAt: lastEnd.toISOString(),
            durationSeconds: Math.round(lastDurationSec),
          });
        }
      }

      return res.json(
        successResponse(
          {
            route: {
              id: route.id,
              status: route.status,
              startedAt: route.startedAt.toISOString(),
              endedAt: route.endedAt
                ? route.endedAt.toISOString()
                : null,
            },
            stops,
          },
          'Остановки маршрута успешно получены'
        )
      );
    } catch (err) {
      console.error('Ошибка получения остановок маршрута:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения остановок маршрута',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /tracking/routes/{routeId}/export:
 *   get:
 *     tags: [Tracking]
 *     summary: Экспорт маршрута в формате GPX
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: routeId
 *         required: true
 *         schema: { type: integer }
 *         description: ID маршрута
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [gpx]
 *         description: Формат файла. По умолчанию gpx.
 *     responses:
 *       200:
 *         description: GPX-файл маршрута
 *         content:
 *           application/gpx+xml:
 *             schema:
 *               type: string
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Маршрут не найден или не принадлежит пользователю
 */
router.get(
  '/routes/:routeId/export',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{ routeId: string }, any, {}, { format?: string }>,
    res
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { routeId } = req.params;
      const idNum = parseInt(routeId, 10);
      if (isNaN(idNum)) {
        return res.status(400).json(
          errorResponse(
            'routeId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const route = await prisma.userRoute.findFirst({
        where: { id: idNum, userId },
      });

      if (!route) {
        return res.status(404).json(
          errorResponse(
            'Маршрут не найден или не принадлежит пользователю',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const points = await prisma.routePoint.findMany({
        where: { routeId: idNum, userId },
        orderBy: { recordedAt: 'asc' },
      });

      const format = (req.query.format || 'gpx') as string;

      if (format !== 'gpx') {
        return res.status(400).json(
          errorResponse(
            'Неподдерживаемый формат. Допустим только gpx',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const lines: string[] = [];
      lines.push('<?xml version="1.0" encoding="UTF-8"?>');
      lines.push(
        '<gpx version="1.1" creator="LeaderProductAPI" xmlns="http://www.topografix.com/GPX/1/1">'
      );
      lines.push(`<trk><name>Route ${route.id}</name><trkseg>`);
      for (const p of points) {
        lines.push(
          `<trkpt lat="${p.latitude}" lon="${p.longitude}"><time>${p.recordedAt.toISOString()}</time></trkpt>`
        );
      }
      lines.push('</trkseg></trk></gpx>');

      const xml = lines.join('');
      res.setHeader('Content-Type', 'application/gpx+xml');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="route-${route.id}.gpx"`
      );
      return res.status(200).send(xml);
    } catch (err) {
      console.error('Ошибка генерации файла GPX:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка генерации файла GPX',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /tracking/routes:
 *   get:
 *     tags: [Tracking]
 *     summary: Получить маршруты текущего пользователя за период
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Начало периода (ISO)
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Конец периода (ISO)
 *       - in: query
 *         name: limit
 *         schema: { type: string }
 *         description: Количество маршрутов на странице (по умолчанию 20)
 *       - in: query
 *         name: offset
 *         schema: { type: string }
 *         description: Смещение для пагинации (по умолчанию 0)
 *       - in: query
 *         name: maxPoints
 *         schema: { type: string }
 *         description: Максимальное количество точек в маршруте для отображения на карте
 *     responses:
 *       200:
 *         description: Список маршрутов
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         routes:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/TrackingRouteSummary'
 *       400:
 *         description: Ошибка валидации параметров
 *       401:
 *         description: Не авторизован
 */
router.get(
  '/routes',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{}, GetUserRoutesResponse, {}, GetUserRoutesQuery>,
    res: express.Response<GetUserRoutesResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { from, to, limit = '20', offset = '0' } = req.query;

      const fromDate = parseDate(from);
      const toDate = parseDate(to);

      if (from && !fromDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра from',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (to && !toDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра to',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const limitNum = parseInt(limit || '20', 10);
      const offsetNum = parseInt(offset || '0', 10);

      if (isNaN(limitNum) || isNaN(offsetNum)) {
        return res.status(400).json(
          errorResponse(
            'limit и offset должны быть целыми числами',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const where: any = { userId };
      if (fromDate || toDate) {
        where.startedAt = {};
        if (fromDate) where.startedAt.gte = fromDate;
        if (toDate) where.startedAt.lte = toDate;
      }

      const [routes, total] = await prisma.$transaction([
        prisma.userRoute.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          skip: offsetNum,
          take: limitNum,
          include: { _count: { select: { points: true } } },
        }),
        prisma.userRoute.count({ where }),
      ]);

      return res.json(
        successResponse(
          {
            routes: routes.map((r) => ({
              id: r.id,
              status: r.status,
              startedAt: r.startedAt.toISOString(),
              endedAt: r.endedAt ? r.endedAt.toISOString() : null,
              pointsCount: r._count.points,
            })),
          },
          'Маршруты успешно получены',
          { total, limit: limitNum, offset: offsetNum }
        )
      );
    } catch (err) {
      console.error('Ошибка получения маршрутов:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения маршрутов',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /tracking/routes/{routeId}/points:
 *   get:
 *     tags: [Tracking]
 *     summary: Получить точки конкретного маршрута
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: routeId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Начало периода (ISO)
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Конец периода (ISO)
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           enum: [MOVE, STOP]
 *         description: Фильтр по типу события
 *       - in: query
 *         name: limit
 *         schema: { type: string }
 *         description: Количество точек на странице (по умолчанию 500)
 *       - in: query
 *         name: offset
 *         schema: { type: string }
 *         description: Смещение для пагинации (по умолчанию 0)
 *       - in: query
 *         name: maxAccuracy
 *         schema: { type: string }
 *         description: Максимально допустимая погрешность в метрах (по умолчанию 100)
 *       - in: query
 *         name: maxPoints
 *         schema: { type: string }
 *         description: Максимальное количество точек в ответе (даунсэмплинг на сервере)
 *     responses:
 *       200:
 *         description: Список точек маршрута
 *       400:
 *         description: Ошибка валидации параметров
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Маршрут не найден или не принадлежит пользователю
 */
router.get(
  '/routes/:routeId/points',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{ routeId: string }, GetRoutePointsResponse, {}, GetRoutePointsQuery>,
    res: express.Response<GetRoutePointsResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { routeId } = req.params;
      const idNum = parseInt(routeId, 10);
      if (isNaN(idNum)) {
        return res.status(400).json(
          errorResponse(
            'routeId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const {
        from,
        to,
        eventType,
        limit = '500',
        offset = '0',
        maxAccuracy,
        maxPoints,
      } = req.query as GetRoutePointsQuery & {
        maxAccuracy?: string;
        maxPoints?: string;
      };

      const fromDate = parseDate(from);
      const toDate = parseDate(to);

      if (from && !fromDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра from',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (to && !toDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра to',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (eventType && eventType !== 'MOVE' && eventType !== 'STOP') {
        return res.status(400).json(
          errorResponse(
            'eventType должен быть MOVE или STOP',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const limitNum = parseInt(limit || '500', 10);
      const offsetNum = parseInt(offset || '0', 10);

      if (isNaN(limitNum) || isNaN(offsetNum)) {
        return res.status(400).json(
          errorResponse(
            'limit и offset должны быть целыми числами',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const route = await prisma.userRoute.findFirst({
        where: { id: idNum, userId },
      });

      if (!route) {
        return res.status(404).json(
          errorResponse(
            'Маршрут не найден или не принадлежит пользователю',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const where: any = { routeId: idNum, userId };
      if (fromDate || toDate) {
        where.recordedAt = {};
        if (fromDate) where.recordedAt.gte = fromDate;
        if (toDate) where.recordedAt.lte = toDate;
      }
      if (eventType) {
        where.eventType = eventType;
      }

      const [pointsRaw, total] = await prisma.$transaction([
        prisma.routePoint.findMany({
          where,
          orderBy: { recordedAt: 'asc' },
          skip: offsetNum,
          take: limitNum,
        }),
        prisma.routePoint.count({ where }),
      ]);

      let points = pointsRaw;
      const maxAccuracyNum = maxAccuracy ? parseFloat(maxAccuracy) : DEFAULT_MAX_ACCURACY_METERS;
      if (!isNaN(maxAccuracyNum)) {
        points = points.filter(
          (p) =>
            p.accuracy === null ||
            p.accuracy === undefined ||
            p.accuracy <= maxAccuracyNum
        );
      }

      const pointsDto: RoutePointDto[] = points.map((p) => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        recordedAt: p.recordedAt.toISOString(),
        recordedTimeZone: p.recordedTimeZone ?? null,
        recordedTimezoneOffsetMinutes: p.recordedTimezoneOffsetMinutes ?? null,
        eventType: p.eventType,
        accuracy: p.accuracy,
        speed: p.speed,
        heading: p.heading,
        stayDurationSeconds: p.stayDurationSeconds,
        sequence: p.sequence ?? null,
      }));

      // optional downsampling for map rendering (work on DTOs)
      const maxPointsNum = maxPoints ? parseInt(maxPoints, 10) : undefined;
      let pointsForResponse: RoutePointDto[] = pointsDto;
      if (
        maxPointsNum &&
        !isNaN(maxPointsNum) &&
        maxPointsNum > 0 &&
        pointsDto.length > maxPointsNum
      ) {
        const step = Math.ceil(pointsDto.length / maxPointsNum);
        const sampled: RoutePointDto[] = [];
        for (let i = 0; i < pointsDto.length; i += step) {
          sampled.push(pointsDto[i]);
        }
        if (
          sampled[sampled.length - 1].id !==
          pointsDto[pointsDto.length - 1].id
        ) {
          sampled.push(pointsDto[pointsDto.length - 1]);
        }
        pointsForResponse = sampled;
      }

      return res.json(
        successResponse(
          {
            route: {
              id: route.id,
              status: route.status,
              startedAt: route.startedAt.toISOString(),
              endedAt: route.endedAt
                ? route.endedAt.toISOString()
                : null,
            },
            points: pointsForResponse,
          },
          'Точки маршрута успешно получены',
          { total, limit: limitNum, offset: offsetNum }
        )
      );
    } catch (err) {
      console.error('Ошибка получения точек маршрута:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения точек маршрута',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /tracking/routes/{routeId}/summary:
 *   get:
 *     tags: [Tracking]
 *     summary: Получить сводку по маршруту
 *     description: Считает расстояние, длительность движения/остановок и скорость по маршруту.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: routeId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Сводная информация по маршруту
 *       400:
 *         description: Ошибка валидации параметров
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Маршрут не найден или не принадлежит пользователю
 */
router.get(
  '/routes/:routeId/summary',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{ routeId: string }>,
    res: express.Response
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { routeId } = req.params;
      const idNum = parseInt(routeId, 10);
      if (isNaN(idNum)) {
        return res.status(400).json(
          errorResponse(
            'routeId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const route = await prisma.userRoute.findFirst({
        where: { id: idNum, userId },
      });

      if (!route) {
        return res.status(404).json(
          errorResponse(
            'Маршрут не найден или не принадлежит пользователю',
            ErrorCodes.NOT_FOUND
          )
        );
      }

      const points = await prisma.routePoint.findMany({
        where: { routeId: idNum, userId },
        orderBy: { recordedAt: 'asc' },
      });

      if (points.length < 2) {
        return res.json(
          successResponse(
            {
              route: {
                id: route.id,
                status: route.status,
                startedAt: route.startedAt.toISOString(),
                endedAt: route.endedAt
                  ? route.endedAt.toISOString()
                  : null,
              },
              totalDistanceMeters: 0,
              movingDurationSeconds: 0,
              stoppedDurationSeconds: 0,
              maxSpeedMetersPerSecond: null,
              averageSpeedMetersPerSecond: null,
              pointsCount: points.length,
              stopsCount: points.filter((p) => p.eventType === 'STOP').length,
            },
            'Сводка по маршруту получена'
          )
        );
      }

      let totalDistanceMeters = 0;
      let movingDurationSeconds = 0;
      let stoppedDurationSeconds = 0;
      let maxSpeed = 0;

      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const dt =
          (curr.recordedAt.getTime() - prev.recordedAt.getTime()) / 1000;
        if (dt <= 0) continue;

        const dist = haversineDistanceMeters(
          prev.latitude,
          prev.longitude,
          curr.latitude,
          curr.longitude
        );
        totalDistanceMeters += dist;

        const segmentSpeed = dist / dt;
        if (segmentSpeed > maxSpeed) {
          maxSpeed = segmentSpeed;
        }

        if (prev.eventType === 'STOP' && curr.eventType === 'STOP') {
          stoppedDurationSeconds += dt;
        } else {
          movingDurationSeconds += dt;
        }
      }

      const totalDurationSeconds =
        movingDurationSeconds + stoppedDurationSeconds;
      const avgSpeed =
        totalDurationSeconds > 0
          ? totalDistanceMeters / totalDurationSeconds
          : null;

      return res.json(
        successResponse(
          {
            route: {
              id: route.id,
              status: route.status,
              startedAt: route.startedAt.toISOString(),
              endedAt: route.endedAt
                ? route.endedAt.toISOString()
                : null,
            },
            totalDistanceMeters,
            movingDurationSeconds,
            stoppedDurationSeconds,
            maxSpeedMetersPerSecond: maxSpeed || null,
            averageSpeedMetersPerSecond: avgSpeed,
            pointsCount: points.length,
            stopsCount: points.filter((p) => p.eventType === 'STOP').length,
          },
          'Сводка по маршруту получена'
        )
      );
    } catch (err) {
      console.error('Ошибка получения сводки по маршруту:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения сводки по маршруту',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * @openapi
 * /tracking/stats/daily:
 *   get:
 *     tags: [Tracking]
 *     summary: Ежедневная статистика по маршрутам пользователя
 *     description: >
 *       Возвращает суммарное расстояние и время в движении/остановках по дням
 *       для текущего пользователя.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Начало периода (по умолчанию 7 дней назад)
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Конец периода (по умолчанию сегодня)
 *     responses:
 *       200:
 *         description: Ежедневная статистика по трекингу
 *       400:
 *         description: Ошибка валидации параметров
 *       401:
 *         description: Не авторизован
 */
router.get(
  '/stats/daily',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{}, GetDailyTrackingStatsResponse, {}, GetDailyTrackingStatsQuery>,
    res: express.Response<GetDailyTrackingStatsResponse>
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { from, to } = req.query;

      let fromDate = from ? parseDate(from) : undefined;
      let toDate = to ? parseDate(to) : undefined;

      if (from && !fromDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра from',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (to && !toDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра to',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      if (!fromDate && !toDate) {
        const now = new Date();
        toDate = now;
        fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (!fromDate && toDate) {
        fromDate = new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (fromDate && !toDate) {
        toDate = new Date();
      }

      const points = await prisma.routePoint.findMany({
        where: {
          userId,
          recordedAt: {
            gte: fromDate!,
            lte: toDate!,
          },
        },
        orderBy: [{ routeId: 'asc' }, { recordedAt: 'asc' }],
      });

      type DayAgg = {
        totalDistanceMeters: number;
        movingDurationSeconds: number;
        stoppedDurationSeconds: number;
        routeIds: Set<number>;
      };

      const byDay = new Map<string, DayAgg>();

      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];

        if (prev.routeId !== curr.routeId) continue;

        const dt =
          (curr.recordedAt.getTime() - prev.recordedAt.getTime()) / 1000;
        if (dt <= 0) continue;

        const dist = haversineDistanceMeters(
          prev.latitude,
          prev.longitude,
          curr.latitude,
          curr.longitude
        );

        const dayKey = prev.recordedAt.toISOString().slice(0, 10);
        let agg = byDay.get(dayKey);
        if (!agg) {
          agg = {
            totalDistanceMeters: 0,
            movingDurationSeconds: 0,
            stoppedDurationSeconds: 0,
            routeIds: new Set<number>(),
          };
          byDay.set(dayKey, agg);
        }

        agg.totalDistanceMeters += dist;
        if (prev.eventType === 'STOP' && curr.eventType === 'STOP') {
          agg.stoppedDurationSeconds += dt;
        } else {
          agg.movingDurationSeconds += dt;
        }
        agg.routeIds.add(prev.routeId);
      }

      const stats = Array.from(byDay.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, agg]) => ({
          date,
          totalDistanceMeters: agg.totalDistanceMeters,
          movingDurationSeconds: agg.movingDurationSeconds,
          stoppedDurationSeconds: agg.stoppedDurationSeconds,
          routesCount: agg.routeIds.size,
        }));

      return res.json(
        successResponse(
          { stats },
          'Статистика трекинга по дням успешно получена'
        )
      );
    } catch (err) {
      console.error('Ошибка получения статистики по трекингу:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения статистики по трекингу',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * Получить маршруты и точки выбранного пользователя за период (для владельца или админа/менеджера)
 */
router.get(
  '/admin/users/:userId/routes-with-points',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{ userId: string }, GetUserRoutesWithPointsResponse, {}, GetUserRoutesWithPointsQuery>,
    res: express.Response<GetUserRoutesWithPointsResponse>
  ) => {
    try {
      const requesterId = req.user?.userId;
      if (!requesterId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const userIdNum = parseInt(req.params.userId, 10);
      if (isNaN(userIdNum)) {
        return res.status(400).json(
          errorResponse(
            'userId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const role = (req.user?.role || '').toLowerCase();
      const canViewOthers =
        role.includes('admin') || role.includes('manager');
      if (!canViewOthers && requesterId !== userIdNum) {
        return res.status(403).json(
          errorResponse(
            'Недостаточно прав для просмотра маршрутов этого пользователя',
            ErrorCodes.FORBIDDEN
          )
        );
      }

      const { from, to, maxAccuracy, maxPoints } = req.query;
      const fromDate = parseDate(from);
      const toDate = parseDate(to);
      if (from && !fromDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра from',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (to && !toDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра to',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const pointsWhere: any = { userId: userIdNum };
      if (fromDate || toDate) {
        pointsWhere.recordedAt = {};
        if (fromDate) pointsWhere.recordedAt.gte = fromDate;
        if (toDate) pointsWhere.recordedAt.lte = toDate;
      }

      const rawPoints = await prisma.routePoint.findMany({
        where: pointsWhere,
        orderBy: [{ routeId: 'asc' }, { recordedAt: 'asc' }],
      });

      const maxAccuracyNum = maxAccuracy ? parseFloat(maxAccuracy) : DEFAULT_MAX_ACCURACY_METERS;
      const filtered = rawPoints.filter(
        (p) =>
          p.accuracy === null ||
          p.accuracy === undefined ||
          (isNaN(maxAccuracyNum) ? true : p.accuracy <= maxAccuracyNum)
      );

      const points: RoutePointDto[] = filtered.map((p) => ({
        id: p.id,
        routeId: p.routeId,
        latitude: p.latitude,
        longitude: p.longitude,
        recordedAt: p.recordedAt.toISOString(),
        recordedTimeZone: p.recordedTimeZone ?? null,
        recordedTimezoneOffsetMinutes: p.recordedTimezoneOffsetMinutes ?? null,
        eventType: p.eventType,
        accuracy: p.accuracy,
        speed: p.speed,
        heading: p.heading,
        stayDurationSeconds: p.stayDurationSeconds,
        sequence: p.sequence ?? null,
      }));

      const routeIds = Array.from(
        new Set(points.map((p) => p.routeId).filter((id): id is number => Boolean(id)))
      );

      const routes = routeIds.length
        ? await prisma.userRoute.findMany({
            where: { id: { in: routeIds }, userId: userIdNum },
            orderBy: { startedAt: 'desc' },
          })
        : [];

      const maxPointsNum = maxPoints ? parseInt(maxPoints, 10) : undefined;
      const grouped = new Map<number, RoutePointDto[]>();
      for (const pt of points) {
        if (!pt.routeId) continue;
        const arr = grouped.get(pt.routeId) ?? [];
        arr.push(pt);
        grouped.set(pt.routeId, arr);
      }

      // downsample per route if requested
      const downsample = (list: RoutePointDto[]): RoutePointDto[] => {
        if (
          !maxPointsNum ||
          isNaN(maxPointsNum) ||
          maxPointsNum <= 0 ||
          list.length <= maxPointsNum
        ) {
          return list;
        }
        const step = Math.ceil(list.length / maxPointsNum);
        const sampled: RoutePointDto[] = [];
        for (let i = 0; i < list.length; i += step) {
          sampled.push(list[i]);
        }
        if (sampled[sampled.length - 1]?.id !== list[list.length - 1]?.id) {
          sampled.push(list[list.length - 1]);
        }
        return sampled;
      };

      const responseRoutes = routes.map((r) => {
        const pts = (grouped.get(r.id) ?? []).sort((a, b) =>
          a.recordedAt.localeCompare(b.recordedAt)
        );
        return {
          id: r.id,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.endedAt ? r.endedAt.toISOString() : null,
          points: downsample(pts),
        };
      });

      return res.json(
        successResponse(
          { user: { id: userIdNum }, routes: responseRoutes },
          'Маршруты пользователя с точками получены'
        )
      );
    } catch (err) {
      console.error('Ошибка получения маршрутов пользователя:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения маршрутов пользователя',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

/**
 * Получить сырые точки пользователя за период (без маршрутов)
 */
router.get(
  '/users/:userId/points',
  authenticateToken,
  checkUserStatus,
  authorizeServiceAccess('tracking'),
  async (
    req: AuthRequest<{ userId: string }, GetUserPointsResponse, {}, GetUserPointsQuery>,
    res: express.Response<GetUserPointsResponse>
  ) => {
    try {
      const requesterId = req.user?.userId;
      if (!requesterId) {
        return res
          .status(401)
          .json(errorResponse('Пользователь не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const userIdNum = parseInt(req.params.userId, 10);
      if (isNaN(userIdNum)) {
        return res.status(400).json(
          errorResponse(
            'userId должен быть целым числом',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const role = (req.user?.role || '').toLowerCase();
      const canViewOthers = role.includes('admin') || role.includes('manager');
      if (!canViewOthers && requesterId !== userIdNum) {
        return res.status(403).json(
          errorResponse(
            'Недостаточно прав для просмотра точек этого пользователя',
            ErrorCodes.FORBIDDEN
          )
        );
      }

      const { from, to, eventType, maxAccuracy, maxPoints } = req.query;
      const fromDate = parseDate(from);
      const toDate = parseDate(to);
      if (from && !fromDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра from',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }
      if (to && !toDate) {
        return res.status(400).json(
          errorResponse(
            'Некорректное значение параметра to',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const where: any = { userId: userIdNum };
      if (fromDate || toDate) {
        where.recordedAt = {};
        if (fromDate) where.recordedAt.gte = fromDate;
        if (toDate) where.recordedAt.lte = toDate;
      }
      if (eventType === 'MOVE' || eventType === 'STOP') {
        where.eventType = eventType;
      }

      const maxAccuracyNum = maxAccuracy ? parseFloat(maxAccuracy) : DEFAULT_MAX_ACCURACY_METERS;
      if (!isNaN(maxAccuracyNum)) {
        where.OR = [
          { accuracy: null },
          { accuracy: { lte: maxAccuracyNum } },
        ];
      }

      const rawPoints = await prisma.routePoint.findMany({
        where,
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      });

      const mapped: RoutePointDto[] = rawPoints.map((p) => ({
        id: p.id,
        routeId: p.routeId || undefined,
        latitude: p.latitude,
        longitude: p.longitude,
        recordedAt: p.recordedAt.toISOString(),
        recordedTimeZone: p.recordedTimeZone ?? null,
        recordedTimezoneOffsetMinutes: p.recordedTimezoneOffsetMinutes ?? null,
        eventType: p.eventType,
        accuracy: p.accuracy,
        speed: p.speed,
        heading: p.heading,
        stayDurationSeconds: p.stayDurationSeconds,
        sequence: p.sequence ?? null,
      }));

      const maxPointsNum = maxPoints ? parseInt(maxPoints, 10) : undefined;
      let points = mapped;
      if (
        maxPointsNum &&
        !isNaN(maxPointsNum) &&
        maxPointsNum > 0 &&
        mapped.length > maxPointsNum
      ) {
        const step = Math.ceil(mapped.length / maxPointsNum);
        const sampled: RoutePointDto[] = [];
        for (let i = 0; i < mapped.length; i += step) {
          sampled.push(mapped[i]);
        }
        if (sampled[sampled.length - 1]?.id !== mapped[mapped.length - 1]?.id) {
          sampled.push(mapped[mapped.length - 1]);
        }
        points = sampled;
      }

      return res.json(
        successResponse(
          { user: { id: userIdNum }, points },
          'Точки пользователя за период получены'
        )
      );
    } catch (err) {
      console.error('Ошибка получения точек пользователя:', err);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения точек пользователя',
          ErrorCodes.INTERNAL_ERROR,
          process.env.NODE_ENV === 'development' ? err : undefined
        )
      );
    }
  }
);

export default router;

