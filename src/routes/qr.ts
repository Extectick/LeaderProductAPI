import express from 'express';
import multer from 'multer';
import { Parser } from 'json2csv';
import {
  Prisma,
  PrismaClient,
  AppealStatus,
  AppealPriority,
  AttachmentType,
} from '@prisma/client';
import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
import {
  successResponse,
  errorResponse,
  ErrorCodes,
} from '../utils/apiResponse';

import {
  QRCreateRequest,
  QRCreateResponse,
  QRUpdateRequest,
  QRUpdateResponse,
  QRGetAllRequest,
  QRGetAllResponse,
  QRGetByIdResponse,
  QRAnalyticsResponse,
  QRStatsResponse,
  QRRestoreResponse,
  QRAnalyticsQueryRequest,
  QRAnalyticsQueryResponse
} from 'types/qrTypes';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { customAlphabet } from 'nanoid';
import geoip from 'geoip-lite';
import {
  assertQrType,
  generateQRCode,
  normalizeAndValidate,
} from '../services/qrService';
import { Server as SocketIOServer } from 'socket.io';

const validator = require('validator');
const UAParser = require('ua-parser-js');

const router = express.Router();
const prisma = new PrismaClient();
const generateShortId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  8
);

/**
 * Определение типа вложения на основе MIME.
 */
function detectAttachmentType(mime: string): AttachmentType {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'FILE';
}

// Создание нового QR-кода
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['create_qr']),
  multer({ dest: 'uploads/' }).array('attachments'),
  async (
    req: AuthRequest<{}, QRCreateResponse, QRCreateRequest>,
    res
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json(
          errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED)
        );
      }

      const { qrData: rawQrData, description, qrType } = req.body;
      if (rawQrData === undefined || rawQrData === null) {
        return res.status(400).json(
          errorResponse('Поле qrData обязательно', ErrorCodes.VALIDATION_ERROR)
        );
      }

      // Проверяем тип QR
      try {
        assertQrType(qrType);
      } catch (e) {
        return res
          .status(400)
          .json(
            errorResponse(
              (e as Error).message,
              ErrorCodes.VALIDATION_ERROR
            )
          );
      }

      // Нормализуем данные
      let normalizedQRData: string;
      try {
        normalizedQRData = normalizeAndValidate(qrType, rawQrData);
      } catch (e) {
        return res
          .status(400)
          .json(
            errorResponse(
              (e as Error).message,
              ErrorCodes.VALIDATION_ERROR
            )
          );
      }

      const generatedId = generateShortId();
      const newQR = await prisma.qRList.create({
        data: {
          id: generatedId,
          qrData: normalizedQRData,
          description: description ?? null,
          qrType,
          createdById: userId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          qrData: true,
          qrType: true,
          description: true,
          status: true,
          createdAt: true,
        },
      });

      return res.status(201).json(successResponse(newQR));
    } catch (error) {
      console.error('Ошибка создания QR кода:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка создания QR кода',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Обновление QR-кода (изменение статуса, описания, данных)
router.put(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['update_qr']),
  async (
    req: AuthRequest<{ id: string }, QRUpdateResponse, QRUpdateRequest>,
    res
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const qr = await prisma.qRList.findUnique({ where: { id } });
      if (!qr) {
        return res
          .status(404)
          .json(errorResponse('QR код не найден', ErrorCodes.NOT_FOUND));
      }

      if (!isAdmin && qr.createdById !== userId) {
        return res
          .status(403)
          .json(errorResponse('Нет прав для редактирования', ErrorCodes.FORBIDDEN));
      }

      const { status, description, qrData, qrType } = req.body;

      let newQrData: string | undefined = undefined;
      let newQrType: typeof qr.qrType | undefined = undefined;

      if (qrType) {
        try {
          assertQrType(qrType);
        } catch (e) {
          return res
            .status(400)
            .json(
              errorResponse(
                (e as Error).message,
                ErrorCodes.VALIDATION_ERROR
              )
            );
        }
        newQrType = qrType;
      }

      if (qrData !== undefined) {
        // Если приходит qrData, нормализуем его, используя либо новый, либо старый тип
        try {
          newQrData = normalizeAndValidate(
            newQrType ?? qr.qrType,
            qrData
          );
        } catch (e) {
          return res
            .status(400)
            .json(
              errorResponse(
                (e as Error).message,
                ErrorCodes.VALIDATION_ERROR
              )
            );
        }
      }

      const updated = await prisma.qRList.update({
        where: { id },
        data: {
          status: status ?? undefined,
          description: description ?? undefined,
          qrType: newQrType ?? undefined,
          qrData: newQrData ?? undefined,
        },
        select: {
          id: true,
          qrData: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res
        .status(200)
        .json(successResponse(updated, 'QR код обновлён'));
    } catch (error) {
      console.error('Ошибка обновления QR кода:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка обновления QR кода',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Универсальная аналитика
router.get(
  '/analytics',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr_analytics']),
  async (
    req: AuthRequest<{}, QRAnalyticsQueryResponse, {}, QRAnalyticsQueryRequest>,
    res
  ) => {
    try {
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';
      if (!userId)
        return res.status(401).json(
          errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED)
        );

      const {
        ids,
        from,
        to,
        tz = 'Europe/Warsaw',
        bucket,
        groupBy,
        top,
        device,
        browser,
        location,
        include = 'totals,series,breakdown',
      } = req.query;

      const includeSet = new Set(
        (include || '').split(',').map((s) => s.trim()).filter(Boolean)
      );

      const idList = (ids ? ids.split(',') : [])
        .map((s) => s.trim())
        .filter(Boolean);

      const FIELD_MAP = {
        device: 'device',
        browser: 'browser',
        location: 'location',
        qrId: 'qrListId',
      } as const;
      type UiField = keyof typeof FIELD_MAP;

      const groupByList = (groupBy ? groupBy.split(',') : [])
        .map((s) => s.trim())
        .filter((s): s is UiField => s in FIELD_MAP);

      const by = groupByList.map((g) => FIELD_MAP[g]) as Prisma.QRAnalyticScalarFieldEnum[];

      const topN = Math.min(
        Math.max(parseInt((top as string) || '10', 10) || 10, 1),
        100
      );

      const toDate = to ? new Date(to as string) : new Date();
      const fromDate = from
        ? new Date(from as string)
        : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

      const filterDevices = device
        ? (device as string).split(',').map((s) => s.trim())
        : undefined;
      const filterBrowsers = browser
        ? (browser as string).split(',').map((s) => s.trim())
        : undefined;
      const filterLocations = location
        ? (location as string).split(',').map((s) => s.trim())
        : undefined;

      const whereBase: any = {
        createdAt: { gte: fromDate, lte: toDate },
      };

      if (idList.length) whereBase.qrListId = { in: idList };
      if (filterDevices?.length) whereBase.device = { in: filterDevices };
      if (filterBrowsers?.length) whereBase.browser = { in: filterBrowsers };
      if (filterLocations?.length)
        whereBase.location = { in: filterLocations };
      if (!isAdmin) whereBase.qrList = { createdById: userId };

      // totals
      let totals: any;
      if (includeSet.has('totals')) {
        const scans = await prisma.qRAnalytic.count({ where: whereBase });

        const uniqueIPs = (
          await prisma.qRAnalytic.groupBy({
            by: ['ip'],
            where: whereBase,
            _count: { _all: true },
          })
        ).length;

        const uniqueDevices = (
          await prisma.qRAnalytic.groupBy({
            by: ['device', 'browser'],
            where: whereBase,
            _count: { _all: true },
          })
        ).length;

        totals = { scans, uniqueIPs, uniqueDevices };
      }

      // series
      let series: Array<{ ts: string; scans: number }> | undefined;
      if (includeSet.has('series') && bucket) {
        const allowedBuckets = {
          hour: 'hour',
          day: 'day',
          week: 'week',
          month: 'month',
        } as const;
        const gran =
          allowedBuckets[bucket as keyof typeof allowedBuckets];
        if (!gran)
          return res
            .status(400)
            .json(errorResponse('Некорректный bucket', ErrorCodes.VALIDATION_ERROR));

        let whereSQL = Prisma.sql`a."createdAt" BETWEEN ${fromDate} AND ${toDate}`;
        if (idList.length)
          whereSQL = Prisma.sql`${whereSQL} AND a."qrListId" IN (${Prisma.join(
            idList
          )})`;
        if (filterDevices?.length)
          whereSQL = Prisma.sql`${whereSQL} AND a."device" IN (${Prisma.join(
            filterDevices
          )})`;
        if (filterBrowsers?.length)
          whereSQL = Prisma.sql`${whereSQL} AND a."browser" IN (${Prisma.join(
            filterBrowsers
          )})`;
        if (filterLocations?.length)
          whereSQL = Prisma.sql`${whereSQL} AND a."location" IN (${Prisma.join(
            filterLocations
          )})`;

        let ownerJoin = Prisma.sql``;
        if (!isAdmin) {
          ownerJoin = Prisma.sql`JOIN "QRList" q ON q."id" = a."qrListId" AND q."createdById" = ${userId}`;
        }

        const rows = await prisma.$queryRaw<Array<{ ts: Date; scans: bigint }>>(
          Prisma.sql`
            SELECT date_trunc(${Prisma.raw(`'${gran}'`)}, timezone(${tz}, a."createdAt")) AS ts,
                   COUNT(*)::bigint AS scans
            FROM "QRAnalytic" a
            ${ownerJoin}
            WHERE ${whereSQL}
            GROUP BY 1
            ORDER BY 1
          `
        );

        series = rows.map((r) => ({
          ts: r.ts.toISOString(),
          scans: Number(r.scans),
        }));
      }

      // breakdown
      let breakdown:
        | {
            by: string[];
            rows: Array<{ key: Record<string, string>; scans: number }>;
          }
        | undefined;
      if (includeSet.has('breakdown') && by.length) {
        const rows = await prisma.qRAnalytic.groupBy({
          by,
          where: whereBase,
          _count: { _all: true },
          orderBy: { _count: { id: 'desc' } },
          take: topN,
        });

        breakdown = {
          by: groupByList,
          rows: rows.map((r: any) => ({
            key: Object.fromEntries(
              groupByList.map((g) => {
                const field = FIELD_MAP[g];
                return [g, r[field] ?? 'unknown'];
              })
            ),
            scans: r._count._all,
          })),
        };
      }

      return res.status(200).json(
        successResponse({
          meta: {
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            tz,
            ids: idList,
          },
          ...(totals ? { totals } : {}),
          ...(series ? { series } : {}),
          ...(breakdown ? { breakdown } : {}),
        })
      );
    } catch (error) {
      console.error('Ошибка универсальной аналитики:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения аналитики',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Сырые события (лог сканов)
router.get(
  '/analytics/scans',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr_analytics']),
  async (
    req: AuthRequest<
      {},
      any,
      any,
      {
        ids?: string;
        from?: string;
        to?: string;
        limit?: string;
        offset?: string;
        device?: string;
        browser?: string;
        location?: string;
      }
    >,
    res
  ) => {
    const userId = req.user!.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    const idList = (req.query.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const toDate = req.query.to ? new Date(req.query.to) : new Date();
    const fromDate = req.query.from
      ? new Date(req.query.from)
      : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || '50', 10) || 50, 1),
      1000
    );
    const offset = Math.max(
      parseInt(req.query.offset || '0', 10) || 0,
      0
    );

    const where: any = {
      createdAt: { gte: fromDate, lte: toDate },
    };
    if (idList.length) where.qrListId = { in: idList };
    if (req.query.device)
      where.device = { in: req.query.device.split(',') };
    if (req.query.browser)
      where.browser = { in: req.query.browser.split(',') };
    if (req.query.location)
      where.location = { in: req.query.location.split(',') };
    if (!isAdmin) where.qrList = { createdById: userId };

    const [rows, total] = await prisma.$transaction([
      prisma.qRAnalytic.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          qrListId: true,
          createdAt: true,
          ip: true,
          device: true,
          browser: true,
          location: true,
          scanDuration: true,
        },
      }),
      prisma.qRAnalytic.count({ where }),
    ]);

    res
      .status(200)
      .json(successResponse({ data: rows, meta: { total, limit, offset } }));
  }
);

// Список QR (пагинация/фильтры)
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr']),
  async (
    req: AuthRequest<{}, QRGetAllResponse, {}, QRGetAllRequest>,
    res
  ) => {
    try {
      const { createdById, status, limit = '10', offset = '0' } =
        req.query;
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res.status(401).json(
          errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED)
        );
      }

      const where: any = {};

      if (!isAdmin) {
        where.createdById = userId;
      } else if (createdById) {
        const createdByIdNum = parseInt(createdById as string);
        if (isNaN(createdByIdNum)) {
          return res.status(400).json(
            errorResponse('Некорректный ID пользователя', ErrorCodes.VALIDATION_ERROR)
          );
        }
        where.createdById = createdByIdNum;
      }

      if (
        status &&
        ['ACTIVE', 'PAUSED', 'DELETED'].includes(status as string)
      ) {
        where.status = status;
      }

      const limitNum = parseInt(limit as string) || 10;
      const offsetNum = parseInt(offset as string) || 0;

      if (isNaN(limitNum)) {
        return res
          .status(400)
          .json(errorResponse('Некорректное значение limit', ErrorCodes.VALIDATION_ERROR));
      }

      if (isNaN(offsetNum)) {
        return res
          .status(400)
          .json(errorResponse('Некорректное значение offset', ErrorCodes.VALIDATION_ERROR));
      }

      const qrList = await prisma.qRList.findMany({
        where,
        skip: offsetNum,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          qrType: true,
          qrData: true,
          description: true,
          status: true,
          createdAt: true,
          createdBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      const totalCount = await prisma.qRList.count({ where });

      return res.status(200).json(
        successResponse({
          data: qrList,
          meta: {
            total: totalCount,
            limit: limitNum.toString(),
            offset: offsetNum.toString(),
          },
        })
      );
    } catch (error) {
      console.error('Ошибка получения списка QR кодов:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения списка QR кодов',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Экспорт QR кодов
router.get(
  '/export',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['export_qr']),
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res.status(401).json({ message: 'Не авторизован' });
      }

      const where = isAdmin ? {} : { createdById: userId };

      const qrList = await prisma.qRList.findMany({
        where,
        select: {
          id: true,
          qrData: true,
          description: true,
          status: true,
          createdAt: true,
          analytics: {
            select: {
              createdAt: true,
              device: true,
              browser: true,
              location: true,
            },
          },
        },
      });

      const headers = ['ID', 'QR Data', 'Status', 'Scan Count', 'Created At'];
      const csvRows: string[] = [];
      csvRows.push(headers.join(','));

      for (const qr of qrList) {
        const scanCount = qr.analytics.length;
        const row = [
          `"${qr.id}"`,
          `"${qr.qrData.replace(/"/g, '""')}"`,
          `"${qr.status}"`,
          String(scanCount),
          `"${qr.createdAt.toISOString()}"`,
        ];
        csvRows.push(row.join(','));
      }

      const csvData = csvRows.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=qr_export.csv');
      return res.status(200).send(csvData);
    } catch (error) {
      console.error('Ошибка экспорта QR кодов:', error);
      return res.status(500).json({
        message: 'Ошибка экспорта QR кодов',
        error: error instanceof Error ? error.message : 'Неизвестная ошибка',
      });
    }
  }
);

// Детальная информация о QR
router.get(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr']),
  async (
    req: AuthRequest<
      { id: string },
      QRGetByIdResponse,
      any,
      {
        simple?: string;
        width?: string;
        darkColor?: string;
        lightColor?: string;
        margin?: string;
        errorCorrection?: string;
      }
    >,
    res
  ) => {
    try {
      const { id } = req.params;
      const {
        simple,
        width = '300',
        darkColor = '000000',
        lightColor = 'ffffff',
        margin = '1',
        errorCorrection = 'M',
      } = req.query;

      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const qr = await prisma.qRList.findUnique({
        where: { id },
        include: {
          createdBy: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      if (!qr) {
        return res
          .status(404)
          .json(errorResponse('QR код не найден', ErrorCodes.NOT_FOUND));
      }

      if (!isAdmin && qr.createdById !== userId) {
        return res
          .status(403)
          .json(errorResponse('Нет прав доступа', ErrorCodes.FORBIDDEN));
      }

      const options = {
        width: parseInt(width as string),
        color: {
          dark: `#${darkColor}`,
          light: `#${lightColor}`,
        },
        margin: parseInt(margin as string),
        errorCorrectionLevel: errorCorrection as 'L' | 'M' | 'Q' | 'H',
      };

      const domen = process.env.DOMEN_URL || 'http://127.0.0.1:3000';
      const urlQR = domen + '/qr/' + qr.id + '/scan';
      const qrImage = await generateQRCode(urlQR, options);

      if (simple === 'true') {
        return res.status(200).json(
          successResponse({
            id: qr.id,
            qrData: qr.qrData,
            qrType: qr.qrType,
            description: qr.description,
            status: qr.status,
            createdAt: qr.createdAt,
            qrImage,
          })
        );
      }

      return res.status(200).json(
        successResponse({
          id: qr.id,
          qrData: qr.qrData,
          qrType: qr.qrType,
          description: qr.description,
          status: qr.status,
          createdAt: qr.createdAt,
          createdBy: qr.createdBy,
          qrImage,
        })
      );
    } catch (error) {
      console.error('Ошибка получения QR кода:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения QR кода',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Аналитика по конкретному QR (простая разбивка)
router.get(
  '/:id/analytics',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr_analytics']),
  async (
    req: AuthRequest<{ id: string }, QRAnalyticsResponse>,
    res
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const qr = await prisma.qRList.findUnique({
        where: { id },
        select: { createdById: true },
      });

      if (!qr) {
        return res
          .status(404)
          .json(errorResponse('QR код не найден', ErrorCodes.NOT_FOUND));
      }

      if (!isAdmin && qr.createdById !== userId) {
        return res
          .status(403)
          .json(errorResponse('Нет прав доступа', ErrorCodes.FORBIDDEN));
      }

      const analytics = await prisma.qRAnalytic.groupBy({
        by: ['device', 'browser', 'location'],
        where: { qrListId: id },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
      });

      return res.status(200).json(
        successResponse(
          analytics.map((a) => ({
            device: (a as any).device || 'unknown',
            browser: (a as any).browser || 'unknown',
            location: (a as any).location || 'unknown',
            count: (a as any)._count._all,
          }))
        )
      );
    } catch (error) {
      console.error('Ошибка получения аналитики:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка получения аналитики',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

// Удаление QR (soft delete)
router.delete(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['delete_qr']),
  async (
    req: AuthRequest<{ id: string }>,
    res
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res.status(401).json({ message: 'Не авторизован' });
      }

      const qr = await prisma.qRList.findUnique({ where: { id } });
      if (!qr)
        return res.status(404).json({ message: 'QR код не найден' });
      if (!isAdmin && qr.createdById !== userId) {
        return res.status(403).json({ message: 'Нет прав для удаления' });
      }

      await prisma.qRList.update({
        where: { id },
        data: { status: 'DELETED' },
      });

      return res.status(204).send();
    } catch (error) {
      console.error('Ошибка удаления QR кода:', error);
      return res.status(500).json({
        message: 'Ошибка удаления QR кода',
        error: error instanceof Error ? error.message : 'Неизвестная ошибка',
      });
    }
  }
);

// Публичный маршрут сканирования QR (без авторизации и прав)
function generateVCard(contact: Record<string, any>): string {
  const escapeValue = (value: string) =>
    value.replace(/\n/g, '\\n').replace(/,/g, '\\,');

  let vCard = 'BEGIN:VCARD\nVERSION:3.0\n';
  if (contact.name) vCard += `FN:${escapeValue(contact.name)}\n`;
  if (contact.phone) vCard += `TEL:${escapeValue(contact.phone)}\n`;
  if (contact.email) vCard += `EMAIL:${escapeValue(contact.email)}\n`;
  if (contact.org) vCard += `ORG:${escapeValue(contact.org)}\n`;
  if (contact.title) vCard += `TITLE:${escapeValue(contact.title)}\n`;
  if (contact.address) vCard += `ADR:${escapeValue(contact.address)}\n`;
  if (contact.url) vCard += `URL:${escapeValue(contact.url)}\n`;
  if (contact.note) vCard += `NOTE:${escapeValue(contact.note)}\n`;
  if (contact.birthday) vCard += `BDAY:${escapeValue(contact.birthday)}\n`;
  if (contact.fax) vCard += `FAX:${escapeValue(contact.fax)}\n`;
  if (contact.photo) vCard += `PHOTO:${escapeValue(contact.photo)}\n`;
  vCard += 'END:VCARD';
  return vCard;
}

router.get('/:id/scan', async (req, res) => {
  try {
    const { id } = req.params;

    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0] ||
      req.socket.remoteAddress ||
      req.ip;

    const geo = geoip.lookup(ip || '');
    const location = geo
      ? `${geo.city || 'Unknown City'}, ${geo.country || 'Unknown Country'}`
      : 'Unknown';

    const userAgent = req.headers['user-agent'] || '';
    const parser = new UAParser();
    parser.setUA(userAgent);
    const result = parser.getResult();

    const device = result.device.type || 'desktop';
    const browser = `${result.browser.name || 'unknown'} ${result.browser.version || ''}`.trim();

    const qr = await prisma.qRList.findFirst({
      where: { id, status: 'ACTIVE' },
    });
    if (!qr)
      return res
        .status(404)
        .json({ message: 'QR код не найден или неактивен' });

    await prisma.qRAnalytic.create({
      data: {
        qrListId: id,
        ip,
        location,
        device,
        browser,
        scanDuration: 0,
      },
    });

    switch (qr.qrType) {
      case 'PHONE': {
        let phone = qr.qrData.trim();
        if (!phone.startsWith('+')) phone = `+${phone}`;

        if (!validator.isMobilePhone(phone, 'any', { strictMode: true })) {
          return res
            .status(400)
            .json({ message: 'Неверный формат номера телефона', phone });
        }

        const encodedPhone = encodeURIComponent(phone);
        const ua = req.headers['user-agent'] || '';
        const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);

        if (isMobile) {
          return res.send(`
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="utf-8">
                <title>Phone Redirect</title>
                <script>
                  window.location.href = 'tel:${encodedPhone}';
                  setTimeout(function() {
                    document.getElementById('manual-call').style.display = 'block';
                  }, 1000);
                </script>
              </head>
              <body>
                <h1>Redirecting to phone app...</h1>
                <div id="manual-call" style="display:none">
                  <p>If redirect doesn't work, please tap:</p>
                  <a href="tel:${encodedPhone}">Call ${phone}</a>
                </div>
              </body>
            </html>
          `);
        } else {
          const whatsappNumber = phone.replace(/[^\d+]/g, '');
          return res.redirect(`https://wa.me/${whatsappNumber}`);
        }
      }

      case 'EMAIL':
        return res.redirect(`mailto:${qr.qrData}`);

      case 'WHATSAPP': {
        let number = qr.qrData.replace(/\D/g, '');
        if (!number.startsWith('+')) number = `+${number}`;
        return res.redirect(`https://wa.me/${number}`);
      }

      case 'TELEGRAM': {
        let username = qr.qrData.trim();
        if (username.startsWith('@')) username = username.slice(1);
        return res.redirect(`https://t.me/${username}`);
      }

      case 'LINK': {
        const url =
          qr.qrData.startsWith('http://') || qr.qrData.startsWith('https://')
            ? qr.qrData
            : `https://${qr.qrData}`;
        return res.redirect(url);
      }

      case 'CONTACT': {
        try {
          const ua = req.headers['user-agent'] || '';
          const isIOS = /iPhone|iPad|iPod/i.test(ua);
          let vCard = qr.qrData.startsWith('BEGIN:VCARD')
            ? qr.qrData
            : generateVCard(JSON.parse(qr.qrData));

          const vCardData = encodeURIComponent(vCard);

          if (isIOS) {
            return res.redirect(
              `data:text/vcard;charset=utf-8,${vCardData}`
            );
          }

          res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline; filename="contact.vcf"');
          return res.send(vCard);
        } catch (error) {
          return res.status(400).json({
            message: 'Неверный формат контакта',
            details: error instanceof Error ? error.message : 'Ошибка обработки VCARD',
          });
        }
      }

      case 'TEXT':
      default:
        return res.send(
          `<html><body><h1>${qr.qrData}</h1></body></html>`
        );
    }
  } catch (error) {
    console.error('Ошибка трекинга сканирования:', error);
    return res.status(500).json({
      message: 'Ошибка трекинга сканирования',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка',
    });
  }
});

// Общая статистика
router.get(
  '/stats',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['view_qr_stats']),
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res.status(401).json({ message: 'Не авторизован' });
      }

      const where = isAdmin ? {} : { createdById: userId };

      const stats = await prisma.$transaction([
        prisma.qRList.count({ where }),
        prisma.qRList.count({ where: { ...where, status: 'ACTIVE' } }),
        prisma.qRList.count({ where: { ...where, status: 'PAUSED' } }),
        prisma.qRList.count({ where: { ...where, status: 'DELETED' } }),
        isAdmin
          ? prisma.qRAnalytic.count()
          : prisma.qRAnalytic.count({
              where: { qrList: { createdById: userId } },
            }),
      ]);

      return res.status(200).json({
        totalQRCodes: stats[0],
        activeQRCodes: stats[1],
        pausedQRCodes: stats[2],
        deletedQRCodes: stats[3],
        totalScans: stats[4],
      });
    } catch (error) {
      console.error('Ошибка получения статистики:', error);
      return res.status(500).json({
        message: 'Ошибка получения статистики',
        error: error instanceof Error ? error.message : 'Неизвестная ошибка',
      });
    }
  }
);

// Восстановление удаленного QR
router.put(
  '/:id/restore',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['restore_qr']),
  async (
    req: AuthRequest<{ id: string }, QRRestoreResponse>,
    res: express.Response<QRRestoreResponse>  // <-- вот тут
  ) => {
    try {
      const { id } = req.params;
      const userId = req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';

      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const qr = await prisma.qRList.findUnique({ where: { id } });
      if (!qr) {
        return res
          .status(404)
          .json(errorResponse('QR код не найден', ErrorCodes.NOT_FOUND));
      }

      if (!isAdmin && qr.createdById !== userId) {
        return res
          .status(403)
          .json(errorResponse('Нет прав для восстановления', ErrorCodes.FORBIDDEN));
      }

      if (qr.status !== 'DELETED') {
        return res
          .status(400)
          .json(errorResponse('QR код не был удален', ErrorCodes.VALIDATION_ERROR));
      }

      const restoredQR = await prisma.qRList.update({
        where: { id },
        data: { status: 'ACTIVE' },
        select: {
          id: true,
          status: true,
          qrData: true,
          description: true,
        },
      });

      return res
        .status(200)
        .json(successResponse(restoredQR, 'QR код восстановлен'));
    } catch (error) {
      console.error('Ошибка восстановления QR кода:', error);
      return res.status(500).json(
        errorResponse(
          'Ошибка восстановления QR кода',
          ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Неизвестная ошибка'
        )
      );
    }
  }
);

export default router;
