import express from 'express';
import prisma from '../prisma/client';
import {
  authenticateToken,
  AuthRequest,
} from '../middleware/auth';
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
} from '../types/routes';

const router = express.Router();

const MAX_POINTS_BATCH = 500;
const DEFAULT_MAX_ACCURACY_METERS = 100;

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
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
 *               routeId:
 *                 type: integer
 *                 description: ID существующего маршрута (опционально)
 *               startNewRoute:
 *                 type: boolean
 *                 description: Создать новый маршрут для переданных точек
 *               endRoute:
 *                 type: boolean
 *                 description: Завершить маршрут (поставить endedAt и статус COMPLETED)
 *               points:
 *                 type: array
 *                 description: Массив точек маршрута
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
router.post(
  '/points',
  authenticateToken,
  checkUserStatus,
  rateLimit({ windowSec: 60, limit: 600 }),
  async (
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

      const { routeId, startNewRoute, endRoute, points } = req.body || {};

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

      if (routeId && startNewRoute) {
        return res.status(400).json(
          errorResponse(
            'Нельзя одновременно передавать routeId и startNewRoute',
            ErrorCodes.VALIDATION_ERROR
          )
        );
      }

      const parsedPoints: {
        latitude: number;
        longitude: number;
        recordedAt: Date;
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
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAt: recordedAtDate,
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

      const minTs =
        parsedPoints.reduce(
          (min, p) =>
            p.recordedAt < min ? p.recordedAt : min,
          parsedPoints[0].recordedAt
        );
      const maxTs =
        parsedPoints.reduce(
          (max, p) =>
            p.recordedAt > max ? p.recordedAt : max,
          parsedPoints[0].recordedAt
        );

      let targetRouteId: number | undefined;
      let routeStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

      await prisma.$transaction(async (tx) => {
        if (routeId) {
          const existing = await tx.userRoute.findFirst({
            where: { id: routeId, userId },
          });
          if (!existing) {
            throw errorResponse(
              'Маршрут не найден или не принадлежит пользователю',
              ErrorCodes.NOT_FOUND
            );
          }
          targetRouteId = existing.id;
          routeStatus = existing.status;
        } else if (startNewRoute) {
          const created = await tx.userRoute.create({
            data: {
              userId,
              startedAt: minTs,
              status: endRoute ? 'COMPLETED' : 'ACTIVE',
              endedAt: endRoute ? maxTs : null,
            },
          });
          targetRouteId = created.id;
          routeStatus = created.status;
        } else {
          // Используем последний активный маршрут пользователя или создаём новый
          let active = await tx.userRoute.findFirst({
            where: { userId, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
          });
          if (!active) {
            active = await tx.userRoute.create({
              data: {
                userId,
                startedAt: minTs,
                status: 'ACTIVE',
              },
            });
          }
          targetRouteId = active.id;
          routeStatus = active.status;
        }

        const existingPointsCount = await tx.routePoint.count({
          where: { routeId: targetRouteId },
        });

        const data = parsedPoints.map((p, idx) => ({
          routeId: targetRouteId!,
          userId,
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAt: p.recordedAt,
          eventType: p.eventType,
          accuracy: p.accuracy,
          speed: p.speed,
          heading: p.heading,
          stayDurationSeconds: p.stayDurationSeconds,
          sequence: existingPointsCount + idx + 1,
        }));

        await tx.routePoint.createMany({ data });

        if (endRoute && targetRouteId) {
          const updated = await tx.userRoute.update({
            where: { id: targetRouteId },
            data: {
              status: 'COMPLETED',
              endedAt: maxTs,
            },
          });
          routeStatus = updated.status;
        }
      });

      return res.json(
        successResponse(
          {
            routeId: targetRouteId!,
            createdPoints: parsedPoints.length,
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

export default router;
