"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const client_1 = require("@prisma/client");
const client_2 = __importDefault(require("../prisma/client"));
const auth_1 = require("../middleware/auth");
const serviceAccess_1 = require("../middleware/serviceAccess");
const apiResponse_1 = require("../utils/apiResponse");
const cache_1 = require("../utils/cache");
const node_crypto_1 = require("node:crypto");
const checkUserStatus_1 = require("../middleware/checkUserStatus");
const geoip_lite_1 = __importDefault(require("geoip-lite"));
const qrService_1 = require("../services/qrService");
const validator = require('validator');
const UAParser = require('ua-parser-js');
const router = express_1.default.Router();
const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const generateShortId = () => {
    const bytes = (0, node_crypto_1.randomBytes)(8);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
        out += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
    }
    return out;
};
/**
 * Определение типа вложения на основе MIME.
 */
function detectAttachmentType(mime) {
    if (mime.startsWith('image/'))
        return 'IMAGE';
    if (mime.startsWith('audio/'))
        return 'AUDIO';
    return 'FILE';
}
/**
 * @openapi
 * /qr:
 *   post:
 *     tags: [QR]
 *     summary: Создать новый QR-код
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "create_qr" ]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               qrData:
 *                 oneOf:
 *                   - { type: string }
 *                   - { type: object, additionalProperties: true }
 *               description:
 *                 type: string
 *                 nullable: true
 *               qrType:
 *                 type: string
 *                 enum: [PHONE,LINK,EMAIL,TEXT,WHATSAPP,TELEGRAM,CONTACT]
 *               attachments:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       201:
 *         description: Создано
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/QRItem'
 *       400:
 *         description: Валидационная ошибка
 *         content:
 *           application/json: { schema: { $ref: '#/components/schemas/ApiError' } }
 *       401:
 *         description: Не авторизован
 *       500:
 *         description: Внутренняя ошибка
 */
// Создание нового QR-кода
router.post('/', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['create_qr']), (0, multer_1.default)({ dest: 'uploads/' }).array('attachments'), async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const { qrData: rawQrData, description, qrType } = req.body;
        if (rawQrData === undefined || rawQrData === null) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Поле qrData обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Проверяем тип QR
        try {
            (0, qrService_1.assertQrType)(qrType);
        }
        catch (e) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)(e.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Нормализуем данные
        let normalizedQRData;
        try {
            normalizedQRData = (0, qrService_1.normalizeAndValidate)(qrType, rawQrData);
        }
        catch (e) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)(e.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const generatedId = generateShortId();
        const newQR = await client_2.default.qRList.create({
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
        await (0, cache_1.cacheDelPrefix)(`qr:list:${userId}`);
        return res.status(201).json((0, apiResponse_1.successResponse)(newQR));
    }
    catch (error) {
        console.error('Ошибка создания QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/{id}:
 *   put:
 *     tags: [QR]
 *     summary: Обновить QR-код (статус/описание/данные)
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "update_qr" ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [ACTIVE,PAUSED,DELETED] }
 *               description: { type: string, nullable: true }
 *               qrData: {}
 *               qrType: { type: string, enum: [PHONE,LINK,EMAIL,TEXT,WHATSAPP,TELEGRAM,CONTACT] }
 *     responses:
 *       200:
 *         description: Обновлено
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/QRItem' }
 *       400:
 *         description: Ошибка валидации
 *       401:
 *         description: Не авторизован
 *       403:
 *         description: Нет прав
 *       404:
 *         description: Не найден
 */
// Обновление QR-кода (изменение статуса, описания, данных)
router.put('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['update_qr']), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res
                .status(401)
                .json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const qr = await client_2.default.qRList.findUnique({ where: { id } });
        if (!qr) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('QR код не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res
                .status(403)
                .json((0, apiResponse_1.errorResponse)('Нет прав для редактирования', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        const { status, description, qrData, qrType } = req.body;
        let newQrData = undefined;
        let newQrType = undefined;
        if (qrType) {
            try {
                (0, qrService_1.assertQrType)(qrType);
            }
            catch (e) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)(e.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            newQrType = qrType;
        }
        if (qrData !== undefined) {
            // Если приходит qrData, нормализуем его, используя либо новый, либо старый тип
            try {
                newQrData = (0, qrService_1.normalizeAndValidate)(newQrType ?? qr.qrType, qrData);
            }
            catch (e) {
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)(e.message, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
        }
        const updated = await client_2.default.qRList.update({
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
        await (0, cache_1.cacheDelPrefix)(`qr:${id}`);
        await (0, cache_1.cacheDelPrefix)(`qr:list:${qr.createdById}`);
        return res
            .status(200)
            .json((0, apiResponse_1.successResponse)(updated, 'QR код обновлён'));
    }
    catch (error) {
        console.error('Ошибка обновления QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/analytics:
 *   get:
 *     tags: [QR]
 *     summary: Универсальная аналитика по QR
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr_analytics" ]
 *     parameters:
 *       - in: query
 *         name: ids
 *         schema: { type: string }
 *         description: "Список id через запятую"
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: tz
 *         schema: { type: string, example: "Europe/Warsaw" }
 *       - in: query
 *         name: bucket
 *         schema: { type: string, enum: [hour,day,week,month] }
 *       - in: query
 *         name: groupBy
 *         schema: { type: string, example: "device,browser,location,qrId" }
 *       - in: query
 *         name: top
 *         schema: { type: string, example: "10" }
 *       - in: query
 *         name: device
 *         schema: { type: string, example: "mobile,desktop" }
 *       - in: query
 *         name: browser
 *         schema: { type: string, example: "Chrome,Firefox" }
 *       - in: query
 *         name: location
 *         schema: { type: string, example: "Warsaw,PL" }
 *       - in: query
 *         name: include
 *         schema: { type: string, example: "totals,series,breakdown" }
 *     responses:
 *       200:
 *         description: Ок
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
 *                         meta:
 *                           type: object
 *                           properties:
 *                             from: { type: string, format: date-time }
 *                             to: { type: string, format: date-time }
 *                             tz: { type: string }
 *                             ids: { type: array, items: { type: string } }
 *                         totals:
 *                           $ref: '#/components/schemas/QRTotals'
 *                         series:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/QRSeriesPoint' }
 *                         breakdown:
 *                           type: object
 *                           properties:
 *                             by:
 *                               type: array
 *                               items: { type: string }
 *                             rows:
 *                               type: array
 *                               items:
 *                                 $ref: '#/components/schemas/QRBreakdownRow'
 *       400:
 *         description: Ошибка параметров
 *       401:
 *         description: Не авторизован
 */
// Универсальная аналитика
router.get('/analytics', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr_analytics']), async (req, res) => {
    try {
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId)
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        const { ids, from, to, tz = 'Europe/Warsaw', bucket, groupBy, top, device, browser, location, include = 'totals,series,breakdown', } = req.query;
        const includeSet = new Set((include || '').split(',').map((s) => s.trim()).filter(Boolean));
        const idList = (ids ? ids.split(',') : [])
            .map((s) => s.trim())
            .filter(Boolean);
        const FIELD_MAP = {
            device: 'device',
            browser: 'browser',
            location: 'location',
            qrId: 'qrListId',
        };
        const groupByList = (groupBy ? groupBy.split(',') : [])
            .map((s) => s.trim())
            .filter((s) => s in FIELD_MAP);
        const by = groupByList.map((g) => FIELD_MAP[g]);
        const topN = Math.min(Math.max(parseInt(top || '10', 10) || 10, 1), 100);
        const toDate = to ? new Date(to) : new Date();
        const fromDate = from
            ? new Date(from)
            : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        const filterDevices = device
            ? device.split(',').map((s) => s.trim())
            : undefined;
        const filterBrowsers = browser
            ? browser.split(',').map((s) => s.trim())
            : undefined;
        const filterLocations = location
            ? location.split(',').map((s) => s.trim())
            : undefined;
        const whereBase = {
            createdAt: { gte: fromDate, lte: toDate },
        };
        if (idList.length)
            whereBase.qrListId = { in: idList };
        if (filterDevices?.length)
            whereBase.device = { in: filterDevices };
        if (filterBrowsers?.length)
            whereBase.browser = { in: filterBrowsers };
        if (filterLocations?.length)
            whereBase.location = { in: filterLocations };
        if (!isAdmin)
            whereBase.qrList = { createdById: userId };
        // totals
        let totals;
        if (includeSet.has('totals')) {
            const scans = await client_2.default.qRAnalytic.count({ where: whereBase });
            const uniqueIPs = (await client_2.default.qRAnalytic.groupBy({
                by: ['ip'],
                where: whereBase,
                _count: { _all: true },
            })).length;
            const uniqueDevices = (await client_2.default.qRAnalytic.groupBy({
                by: ['device', 'browser'],
                where: whereBase,
                _count: { _all: true },
            })).length;
            totals = { scans, uniqueIPs, uniqueDevices };
        }
        // series
        let series;
        if (includeSet.has('series') && bucket) {
            const allowedBuckets = {
                hour: 'hour',
                day: 'day',
                week: 'week',
                month: 'month',
            };
            const gran = allowedBuckets[bucket];
            if (!gran)
                return res
                    .status(400)
                    .json((0, apiResponse_1.errorResponse)('Некорректный bucket', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            let whereSQL = client_1.Prisma.sql `a."createdAt" BETWEEN ${fromDate} AND ${toDate}`;
            if (idList.length)
                whereSQL = client_1.Prisma.sql `${whereSQL} AND a."qrListId" IN (${client_1.Prisma.join(idList)})`;
            if (filterDevices?.length)
                whereSQL = client_1.Prisma.sql `${whereSQL} AND a."device" IN (${client_1.Prisma.join(filterDevices)})`;
            if (filterBrowsers?.length)
                whereSQL = client_1.Prisma.sql `${whereSQL} AND a."browser" IN (${client_1.Prisma.join(filterBrowsers)})`;
            if (filterLocations?.length)
                whereSQL = client_1.Prisma.sql `${whereSQL} AND a."location" IN (${client_1.Prisma.join(filterLocations)})`;
            let ownerJoin = client_1.Prisma.sql ``;
            if (!isAdmin) {
                ownerJoin = client_1.Prisma.sql `JOIN "QRList" q ON q."id" = a."qrListId" AND q."createdById" = ${userId}`;
            }
            const rows = await client_2.default.$queryRaw(client_1.Prisma.sql `
            SELECT date_trunc(${client_1.Prisma.raw(`'${gran}'`)}, timezone(${tz}, a."createdAt")) AS ts,
                   COUNT(*)::bigint AS scans
            FROM "QRAnalytic" a
            ${ownerJoin}
            WHERE ${whereSQL}
            GROUP BY 1
            ORDER BY 1
          `);
            series = rows.map((r) => ({
                ts: r.ts.toISOString(),
                scans: Number(r.scans),
            }));
        }
        // breakdown
        let breakdown;
        if (includeSet.has('breakdown') && by.length) {
            const rows = await client_2.default.qRAnalytic.groupBy({
                by,
                where: whereBase,
                _count: { _all: true },
                orderBy: { _count: { id: 'desc' } },
                take: topN,
            });
            breakdown = {
                by: groupByList,
                rows: rows.map((r) => ({
                    key: Object.fromEntries(groupByList.map((g) => {
                        const field = FIELD_MAP[g];
                        return [g, r[field] ?? 'unknown'];
                    })),
                    scans: r._count._all,
                })),
            };
        }
        return res.status(200).json((0, apiResponse_1.successResponse)({
            meta: {
                from: fromDate.toISOString(),
                to: toDate.toISOString(),
                tz,
                ids: idList,
            },
            ...(totals ? { totals } : {}),
            ...(series ? { series } : {}),
            ...(breakdown ? { breakdown } : {}),
        }));
    }
    catch (error) {
        console.error('Ошибка универсальной аналитики:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения аналитики', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/analytics/scans:
 *   get:
 *     tags: [QR]
 *     summary: Лог сканирований (сырые события)
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr_analytics" ]
 *     parameters:
 *       - in: query
 *         name: ids
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: string, example: "50" }
 *       - in: query
 *         name: offset
 *         schema: { type: string, example: "0" }
 *       - in: query
 *         name: device
 *         schema: { type: string }
 *       - in: query
 *         name: browser
 *         schema: { type: string }
 *       - in: query
 *         name: location
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ок
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
 *                         data:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/QRScanEvent' }
 *                         meta:
 *                           type: object
 *                           properties:
 *                             total: { type: integer }
 *                             limit: { type: integer }
 *                             offset: { type: integer }
 *       401:
 *         description: Не авторизован
 */
// Сырые события (лог сканов)
router.get('/analytics/scans', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr_analytics']), async (req, res) => {
    const userId = req.user.userId;
    const isAdmin = req.user?.role === 'ADMIN';
    const idList = (req.query.ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const toDate = req.query.to ? new Date(req.query.to) : new Date();
    const fromDate = req.query.from
        ? new Date(req.query.from)
        : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const where = {
        createdAt: { gte: fromDate, lte: toDate },
    };
    if (idList.length)
        where.qrListId = { in: idList };
    if (req.query.device)
        where.device = { in: req.query.device.split(',') };
    if (req.query.browser)
        where.browser = { in: req.query.browser.split(',') };
    if (req.query.location)
        where.location = { in: req.query.location.split(',') };
    if (!isAdmin)
        where.qrList = { createdById: userId };
    const [rows, total] = await client_2.default.$transaction([
        client_2.default.qRAnalytic.findMany({
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
        client_2.default.qRAnalytic.count({ where }),
    ]);
    res
        .status(200)
        .json((0, apiResponse_1.successResponse)({ data: rows, meta: { total, limit, offset } }));
});
/**
 * @openapi
 * /qr:
 *   get:
 *     tags: [QR]
 *     summary: Список QR (пагинация/фильтры)
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr" ]
 *     parameters:
 *       - in: query
 *         name: createdById
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE,PAUSED,DELETED] }
 *       - in: query
 *         name: limit
 *         schema: { type: string, example: "10" }
 *       - in: query
 *         name: offset
 *         schema: { type: string, example: "0" }
 *     responses:
 *       200:
 *         description: Ок
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
 *                         data:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/QRListItem' }
 *                         meta:
 *                           type: object
 *                           properties:
 *                             total: { type: integer }
 *                             limit: { type: string }
 *                             offset: { type: string }
 *       401:
 *         description: Не авторизован
 */
// Список QR (пагинация/фильтры)
router.get('/', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr']), async (req, res) => {
    try {
        const { createdById, status, limit = '10', offset = '0' } = req.query;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const where = {};
        if (!isAdmin) {
            where.createdById = userId;
        }
        else if (createdById) {
            const createdByIdNum = parseInt(createdById);
            if (isNaN(createdByIdNum)) {
                return res.status(400).json((0, apiResponse_1.errorResponse)('Некорректный ID пользователя', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            where.createdById = createdByIdNum;
        }
        if (status &&
            ['ACTIVE', 'PAUSED', 'DELETED'].includes(status)) {
            where.status = status;
        }
        const limitNum = parseInt(limit) || 10;
        const offsetNum = parseInt(offset) || 0;
        if (isNaN(limitNum)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректное значение limit', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (isNaN(offsetNum)) {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('Некорректное значение offset', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const cacheKey = `qr:list:${userId}:${createdById || ''}:${status || ''}:${limitNum}:${offsetNum}`;
        const cached = await (0, cache_1.cacheGet)(cacheKey);
        if (cached) {
            return res.status(200).json((0, apiResponse_1.successResponse)(cached));
        }
        const qrList = await client_2.default.qRList.findMany({
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
        const totalCount = await client_2.default.qRList.count({ where });
        const responseData = {
            data: qrList,
            meta: {
                total: totalCount,
                limit: limitNum.toString(),
                offset: offsetNum.toString(),
            },
        };
        await (0, cache_1.cacheSet)(cacheKey, responseData, 60);
        return res.status(200).json((0, apiResponse_1.successResponse)(responseData));
    }
    catch (error) {
        console.error('Ошибка получения списка QR кодов:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка QR кодов', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/export:
 *   get:
 *     tags: [QR]
 *     summary: Экспорт списка QR в CSV
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "export_qr" ]
 *     responses:
 *       200:
 *         description: CSV файл
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Не авторизован
 */
// Экспорт QR кодов
router.get('/export', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['export_qr']), async (req, res) => {
    try {
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: 'Не авторизован' });
        }
        const where = isAdmin ? {} : { createdById: userId };
        const qrList = await client_2.default.qRList.findMany({
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
        const csvRows = [];
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
    }
    catch (error) {
        console.error('Ошибка экспорта QR кодов:', error);
        return res.status(500).json({
            message: 'Ошибка экспорта QR кодов',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка',
        });
    }
});
/**
 * @openapi
 * /qr/{id}:
 *   get:
 *     tags: [QR]
 *     summary: Детальная информация о QR (+генерация PNG как dataURL)
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr" ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: simple
 *         schema: { type: string, enum: ["true","false"] }
 *       - in: query
 *         name: width
 *         schema: { type: string, example: "300" }
 *       - in: query
 *         name: darkColor
 *         schema: { type: string, example: "000000" }
 *       - in: query
 *         name: lightColor
 *         schema: { type: string, example: "ffffff" }
 *       - in: query
 *         name: margin
 *         schema: { type: string, example: "1" }
 *       - in: query
 *         name: errorCorrection
 *         schema: { type: string, enum: [L,M,Q,H], example: "M" }
 *     responses:
 *       200:
 *         description: Ок
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       allOf:
 *                         - $ref: '#/components/schemas/QRListItem'
 *                         - type: object
 *                           properties:
 *                             qrImage: { type: string, description: "data:image/png;base64,..." }
 *       401:
 *         description: Не авторизован
 *       403:
 *         description: Нет прав
 *       404:
 *         description: Не найден
 */
// Детальная информация о QR
router.get('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr']), async (req, res) => {
    try {
        const { id } = req.params;
        const { simple, width = '300', darkColor = '000000', lightColor = 'ffffff', margin = '1', errorCorrection = 'M', } = req.query;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res
                .status(401)
                .json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const cacheKey = `qr:${id}:${simple || ''}:${width}:${darkColor}:${lightColor}:${margin}:${errorCorrection}`;
        const cached = await (0, cache_1.cacheGet)(cacheKey);
        if (cached) {
            return res.status(200).json((0, apiResponse_1.successResponse)(cached));
        }
        const qr = await client_2.default.qRList.findUnique({
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
                .json((0, apiResponse_1.errorResponse)('QR код не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res
                .status(403)
                .json((0, apiResponse_1.errorResponse)('Нет прав доступа', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        const options = {
            width: parseInt(width),
            color: {
                dark: `#${darkColor}`,
                light: `#${lightColor}`,
            },
            margin: parseInt(margin),
            errorCorrectionLevel: errorCorrection,
        };
        const domen = process.env.DOMEN_URL || 'http://127.0.0.1:3000';
        const urlQR = domen + '/qr/' + qr.id + '/scan';
        const qrImage = await (0, qrService_1.generateQRCode)(urlQR, options);
        let responseData;
        if (simple === 'true') {
            responseData = {
                id: qr.id,
                qrData: qr.qrData,
                qrType: qr.qrType,
                description: qr.description,
                status: qr.status,
                createdAt: qr.createdAt,
                qrImage,
            };
        }
        else {
            responseData = {
                id: qr.id,
                qrData: qr.qrData,
                qrType: qr.qrType,
                description: qr.description,
                status: qr.status,
                createdAt: qr.createdAt,
                createdBy: qr.createdBy,
                qrImage,
            };
        }
        await (0, cache_1.cacheSet)(cacheKey, responseData, 60);
        return res.status(200).json((0, apiResponse_1.successResponse)(responseData));
    }
    catch (error) {
        console.error('Ошибка получения QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/{id}/analytics:
 *   get:
 *     tags: [QR]
 *     summary: Разбивка по устройствам/браузерам/локациям
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr_analytics" ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ок
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           device: { type: string }
 *                           browser: { type: string }
 *                           location: { type: string }
 *                           count: { type: integer }
 *       401: { description: Не авторизован }
 *       403: { description: Нет прав }
 *       404: { description: Не найден }
 */
// Аналитика по конкретному QR (простая разбивка)
router.get('/:id/analytics', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr_analytics']), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res
                .status(401)
                .json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const qr = await client_2.default.qRList.findUnique({
            where: { id },
            select: { createdById: true },
        });
        if (!qr) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('QR код не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res
                .status(403)
                .json((0, apiResponse_1.errorResponse)('Нет прав доступа', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        const analytics = await client_2.default.qRAnalytic.groupBy({
            by: ['device', 'browser', 'location'],
            where: { qrListId: id },
            _count: { _all: true },
            orderBy: { _count: { id: 'desc' } },
        });
        return res.status(200).json((0, apiResponse_1.successResponse)(analytics.map((a) => ({
            device: a.device || 'unknown',
            browser: a.browser || 'unknown',
            location: a.location || 'unknown',
            count: a._count._all,
        }))));
    }
    catch (error) {
        console.error('Ошибка получения аналитики:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения аналитики', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
/**
 * @openapi
 * /qr/{id}:
 *   delete:
 *     tags: [QR]
 *     summary: Удалить (soft) QR-код
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "delete_qr" ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Удалено
 *       401:
 *         description: Не авторизован
 *       403:
 *         description: Нет прав
 *       404:
 *         description: Не найден
 */
// Удаление QR (soft delete)
router.delete('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['delete_qr']), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: 'Не авторизован' });
        }
        const qr = await client_2.default.qRList.findUnique({ where: { id } });
        if (!qr)
            return res.status(404).json({ message: 'QR код не найден' });
        if (!isAdmin && qr.createdById !== userId) {
            return res.status(403).json({ message: 'Нет прав для удаления' });
        }
        await client_2.default.qRList.update({
            where: { id },
            data: { status: 'DELETED' },
        });
        await (0, cache_1.cacheDelPrefix)(`qr:${id}`);
        await (0, cache_1.cacheDelPrefix)(`qr:list:${qr.createdById}`);
        return res.status(204).send();
    }
    catch (error) {
        console.error('Ошибка удаления QR кода:', error);
        return res.status(500).json({
            message: 'Ошибка удаления QR кода',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка',
        });
    }
});
// Публичный маршрут сканирования QR (без авторизации и прав)
function generateVCard(contact) {
    const escapeValue = (value) => value.replace(/\n/g, '\\n').replace(/,/g, '\\,');
    let vCard = 'BEGIN:VCARD\nVERSION:3.0\n';
    if (contact.name)
        vCard += `FN:${escapeValue(contact.name)}\n`;
    if (contact.phone)
        vCard += `TEL:${escapeValue(contact.phone)}\n`;
    if (contact.email)
        vCard += `EMAIL:${escapeValue(contact.email)}\n`;
    if (contact.org)
        vCard += `ORG:${escapeValue(contact.org)}\n`;
    if (contact.title)
        vCard += `TITLE:${escapeValue(contact.title)}\n`;
    if (contact.address)
        vCard += `ADR:${escapeValue(contact.address)}\n`;
    if (contact.url)
        vCard += `URL:${escapeValue(contact.url)}\n`;
    if (contact.note)
        vCard += `NOTE:${escapeValue(contact.note)}\n`;
    if (contact.birthday)
        vCard += `BDAY:${escapeValue(contact.birthday)}\n`;
    if (contact.fax)
        vCard += `FAX:${escapeValue(contact.fax)}\n`;
    if (contact.photo)
        vCard += `PHOTO:${escapeValue(contact.photo)}\n`;
    vCard += 'END:VCARD';
    return vCard;
}
/**
 * @openapi
 * /qr/{id}/scan:
 *   get:
 *     tags: [QR]
 *     summary: Публичное сканирование QR (редиректы/контент)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Текст/VCARD/HTML
 *       302:
 *         description: Редирект на внешний ресурс (mailto:/tel:/https://...)
 *       404:
 *         description: QR не найден или неактивен
 */
router.get('/:id/scan', async (req, res) => {
    try {
        const { id } = req.params;
        const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] ||
            req.socket.remoteAddress ||
            req.ip;
        const geo = geoip_lite_1.default.lookup(ip || '');
        const location = geo
            ? `${geo.city || 'Unknown City'}, ${geo.country || 'Unknown Country'}`
            : 'Unknown';
        const userAgent = req.headers['user-agent'] || '';
        const parser = new UAParser();
        parser.setUA(userAgent);
        const result = parser.getResult();
        const device = result.device.type || 'desktop';
        const browser = `${result.browser.name || 'unknown'} ${result.browser.version || ''}`.trim();
        const qr = await client_2.default.qRList.findFirst({
            where: { id, status: 'ACTIVE' },
        });
        if (!qr)
            return res
                .status(404)
                .json({ message: 'QR код не найден или неактивен' });
        await client_2.default.qRAnalytic.create({
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
                if (!phone.startsWith('+'))
                    phone = `+${phone}`;
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
                }
                else {
                    const whatsappNumber = phone.replace(/[^\d+]/g, '');
                    return res.redirect(`https://wa.me/${whatsappNumber}`);
                }
            }
            case 'EMAIL':
                return res.redirect(`mailto:${qr.qrData}`);
            case 'WHATSAPP': {
                let number = qr.qrData.replace(/\D/g, '');
                if (!number.startsWith('+'))
                    number = `+${number}`;
                return res.redirect(`https://wa.me/${number}`);
            }
            case 'TELEGRAM': {
                let username = qr.qrData.trim();
                if (username.startsWith('@'))
                    username = username.slice(1);
                return res.redirect(`https://t.me/${username}`);
            }
            case 'LINK': {
                const url = qr.qrData.startsWith('http://') || qr.qrData.startsWith('https://')
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
                        return res.redirect(`data:text/vcard;charset=utf-8,${vCardData}`);
                    }
                    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
                    res.setHeader('Content-Disposition', 'inline; filename="contact.vcf"');
                    return res.send(vCard);
                }
                catch (error) {
                    return res.status(400).json({
                        message: 'Неверный формат контакта',
                        details: error instanceof Error ? error.message : 'Ошибка обработки VCARD',
                    });
                }
            }
            case 'TEXT':
            default:
                return res.send(`<html><body><h1>${qr.qrData}</h1></body></html>`);
        }
    }
    catch (error) {
        console.error('Ошибка трекинга сканирования:', error);
        return res.status(500).json({
            message: 'Ошибка трекинга сканирования',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка',
        });
    }
});
/**
 * @openapi
 * /qr/stats:
 *   get:
 *     tags: [QR]
 *     summary: Общая статистика по QR-кодам
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "view_qr_stats" ]
 *     responses:
 *       200:
 *         description: Ок
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalQRCodes: { type: integer }
 *                 activeQRCodes: { type: integer }
 *                 pausedQRCodes: { type: integer }
 *                 deletedQRCodes: { type: integer }
 *                 totalScans: { type: integer }
 *       401:
 *         description: Не авторизован
 */
// Общая статистика
router.get('/stats', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['view_qr_stats']), async (req, res) => {
    try {
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: 'Не авторизован' });
        }
        const where = isAdmin ? {} : { createdById: userId };
        const stats = await client_2.default.$transaction([
            client_2.default.qRList.count({ where }),
            client_2.default.qRList.count({ where: { ...where, status: 'ACTIVE' } }),
            client_2.default.qRList.count({ where: { ...where, status: 'PAUSED' } }),
            client_2.default.qRList.count({ where: { ...where, status: 'DELETED' } }),
            isAdmin
                ? client_2.default.qRAnalytic.count()
                : client_2.default.qRAnalytic.count({
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
    }
    catch (error) {
        console.error('Ошибка получения статистики:', error);
        return res.status(500).json({
            message: 'Ошибка получения статистики',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка',
        });
    }
});
/**
 * @openapi
 * /qr/{id}/restore:
 *   put:
 *     tags: [QR]
 *     summary: Восстановить удалённый QR-код
 *     description: Меняет статус удалённого QR с `DELETED` на `ACTIVE`.
 *     security:
 *       - bearerAuth: []
 *     x-permissions: [ "restore_qr" ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Идентификатор QR-кода
 *     responses:
 *       200:
 *         description: QR-код успешно восстановлен
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/QRRestoreData'
 *       400:
 *         description: QR не в статусе DELETED
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       403:
 *         description: Нет прав на восстановление
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: QR не найден
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка сервера
 */
// Восстановление удаленного QR
router.put('/:id/restore', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, (0, serviceAccess_1.authorizeServiceAccess)('qrcodes'), (0, auth_1.authorizePermissions)(['restore_qr']), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res
                .status(401)
                .json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const qr = await client_2.default.qRList.findUnique({ where: { id } });
        if (!qr) {
            return res
                .status(404)
                .json((0, apiResponse_1.errorResponse)('QR код не найден', apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res
                .status(403)
                .json((0, apiResponse_1.errorResponse)('Нет прав для восстановления', apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (qr.status !== 'DELETED') {
            return res
                .status(400)
                .json((0, apiResponse_1.errorResponse)('QR код не был удален', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const restoredQR = await client_2.default.qRList.update({
            where: { id },
            data: { status: 'ACTIVE' },
            select: {
                id: true,
                status: true,
                qrData: true,
                description: true,
            },
        });
        await (0, cache_1.cacheDelPrefix)(`qr:${id}`);
        await (0, cache_1.cacheDelPrefix)(`qr:list:${qr.createdById}`);
        return res
            .status(200)
            .json((0, apiResponse_1.successResponse)(restoredQR, 'QR код восстановлен'));
    }
    catch (error) {
        console.error('Ошибка восстановления QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка восстановления QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
exports.default = router;
