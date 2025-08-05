"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const apiResponse_1 = require("../utils/apiResponse");
const checkUserStatus_1 = require("../middleware/checkUserStatus");
const nanoid_1 = require("nanoid");
const geoip_lite_1 = __importDefault(require("geoip-lite"));
const validateQRData_1 = require("../utils/validateQRData");
const qrService_1 = require("../services/qrService");
const validator = require('validator');
const UAParser = require('ua-parser-js');
const router = express_1.default.Router();
const prisma = new client_1.PrismaClient();
const generateShortId = (0, nanoid_1.customAlphabet)('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 8);
// Создание нового QR-кода
router.post('/', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        let { qrData: rawQrData, description, qrType } = req.body;
        const userId = req.user?.userId;
        if (!userId)
            return res.status(401).json((0, apiResponse_1.errorResponse)('Не авторизован', apiResponse_1.ErrorCodes.UNAUTHORIZED));
        if (rawQrData === undefined || rawQrData === null) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Поле qrData обязательно', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Приводим qrData к строке
        let qrData;
        if (typeof rawQrData === 'object') {
            qrData = JSON.stringify(rawQrData);
        }
        else {
            qrData = rawQrData.toString();
        }
        const allowedTypes = ['PHONE', 'LINK', 'EMAIL', 'TEXT', 'WHATSAPP', 'TELEGRAM', 'CONTACT'];
        if (!qrType || !allowedTypes.includes(qrType)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный тип qrType', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        let normalizedQRData = qrData;
        // Обработка CONTACT типа
        if (qrType === 'CONTACT') {
            // Если qrData уже в формате VCARD
            if (typeof qrData === 'string' && qrData.startsWith('BEGIN:VCARD')) {
                normalizedQRData = qrData;
            }
            // Если qrData - объект или JSON строка
            else {
                try {
                    const contactData = typeof qrData === 'string' ? JSON.parse(qrData) : qrData;
                    normalizedQRData = generateVCard(contactData);
                }
                catch (error) {
                    return res.status(400).json((0, apiResponse_1.errorResponse)('Неверный формат контактных данных', apiResponse_1.ErrorCodes.VALIDATION_ERROR, error instanceof Error ? error.message : 'Ошибка парсинга'));
                }
            }
        }
        else {
            // Обработка других типов
            // Если qrData — объект, сериализуем в JSON-строку
            if (typeof qrData === 'object') {
                normalizedQRData = JSON.stringify(qrData);
            }
            else if (typeof qrData !== 'string') {
                return res.status(400).json((0, apiResponse_1.errorResponse)('qrData должен быть строкой или объектом', apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            // Валидация qrData (строки)
            const validationError = (0, validateQRData_1.validateQRData)(qrType, normalizedQRData);
            if (validationError) {
                return res.status(400).json((0, apiResponse_1.errorResponse)(validationError, apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
        }
        // Дальше для PHONE и WHATSAPP — нормализуем номер (начинается с + и max 12 символов)
        if (qrType === 'PHONE' || qrType === 'WHATSAPP') {
            // Убираем всё кроме цифр и плюс
            let cleaned = normalizedQRData.replace(/[^\d+]/g, '');
            if (!cleaned.startsWith('+')) {
                cleaned = '+' + cleaned.replace(/[^\d]/g, '');
            }
            normalizedQRData = cleaned.slice(0, 12);
        }
        // Для TELEGRAM — должно начинаться с @
        if (qrType === 'TELEGRAM') {
            if (!normalizedQRData.startsWith('@')) {
                normalizedQRData = '@' + normalizedQRData;
            }
        }
        const generatedId = generateShortId();
        const newQR = await prisma.qRList.create({
            data: {
                id: generatedId,
                qrData: normalizedQRData,
                description: description || null,
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
        return res.status(201).json((0, apiResponse_1.successResponse)(newQR));
    }
    catch (error) {
        console.error('Ошибка создания QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка создания QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
router.patch('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, description } = req.body;
        const userId = req.user?.userId;
        const userRole = req.user?.role;
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)("Не авторизован", apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        // Проверяем существование QR кода
        const existingQR = await prisma.qRList.findUnique({
            where: { id }
        });
        if (!existingQR) {
            return res.status(404).json((0, apiResponse_1.errorResponse)("QR код не найден", apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        // Проверяем права (создатель или админ)
        const isAdmin = userRole === 'ADMIN'; // Предполагаем, что есть такая роль
        const isOwner = existingQR.createdById === userId;
        if (!isOwner && !isAdmin) {
            return res.status(403).json((0, apiResponse_1.errorResponse)("Нет прав для обновления", apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        // Валидация статуса
        if (status && !['ACTIVE', 'PAUSED', 'DELETED'].includes(status)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)("Некорректный статус", apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const updatedQR = await prisma.qRList.update({
            where: { id },
            data: {
                ...(status && { status }),
                ...(description && { description }),
                updatedAt: new Date() // Обновляем метку времени
            },
            select: {
                id: true,
                qrData: true,
                description: true,
                status: true,
                createdAt: true,
                updatedAt: true
            }
        });
        return res.status(200).json((0, apiResponse_1.successResponse)(updatedQR));
    }
    catch (error) {
        console.error('Ошибка обновления QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка обновления QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
router.get('/', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { createdById, status, limit = '10', offset = '0' } = req.query;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN'; // Предполагаем наличие роли ADMIN
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)("Не авторизован", apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        // Подготовка условий фильтрации
        const where = {};
        // Для не-админов показываем только свои QR коды
        if (!isAdmin) {
            where.createdById = userId;
        }
        // Для админов - фильтр по byUserId если указан
        else if (createdById) {
            const createdByIdNum = parseInt(createdById);
            if (isNaN(createdByIdNum)) {
                return res.status(400).json((0, apiResponse_1.errorResponse)("Некорректный ID пользователя", apiResponse_1.ErrorCodes.VALIDATION_ERROR));
            }
            where.createdById = createdByIdNum;
        }
        // Фильтр по статусу если указан
        if (status && ['ACTIVE', 'PAUSED', 'DELETED'].includes(status)) {
            where.status = status;
        }
        // Получаем список с пагинацией
        const limitNum = parseInt(limit) || 10;
        const offsetNum = parseInt(offset) || 0;
        if (isNaN(limitNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)("Некорректное значение limit", apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        if (isNaN(offsetNum)) {
            return res.status(400).json((0, apiResponse_1.errorResponse)("Некорректное значение offset", apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        const qrList = await prisma.qRList.findMany({
            where,
            skip: offsetNum,
            take: limitNum,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                qrData: true,
                description: true,
                status: true,
                createdAt: true,
                createdBy: {
                    select: {
                        id: true,
                        email: true
                    }
                }
            }
        });
        // Получаем общее количество для пагинации
        const totalCount = await prisma.qRList.count({ where });
        return res.status(200).json((0, apiResponse_1.successResponse)({
            data: qrList,
            meta: {
                total: totalCount,
                limit: limitNum.toString(),
                offset: offsetNum.toString()
            }
        }));
    }
    catch (error) {
        console.error('Ошибка получения списка QR кодов:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения списка QR кодов', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
// Получение детальной информации о QR коде
router.get('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const { simple, width = '300', darkColor = '000000', lightColor = 'ffffff', margin = '1', errorCorrection = 'M' } = req.query;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)("Не авторизован", apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const qr = await prisma.qRList.findUnique({
            where: { id },
            include: {
                createdBy: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true
                    }
                }
            }
        });
        if (!qr) {
            return res.status(404).json((0, apiResponse_1.errorResponse)("QR код не найден", apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res.status(403).json((0, apiResponse_1.errorResponse)("Нет прав доступа", apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        // Генерация QR с параметрами или без
        const options = {
            width: parseInt(width),
            color: {
                dark: `#${darkColor}`,
                light: `#${lightColor}`
            },
            margin: parseInt(margin),
            errorCorrectionLevel: errorCorrection
        };
        const domen = process.env.DOMEN_URL || "http://192.168.30.54:3000/";
        const urlQR = domen + "qr/" + qr.id + "/scan";
        const qrImage = await (0, qrService_1.generateQRCode)(urlQR, options);
        if (simple === 'true') {
            return res.status(200).json((0, apiResponse_1.successResponse)({
                id: qr.id,
                qrData: qr.qrData,
                qrType: qr.qrType,
                description: qr.description,
                status: qr.status,
                createdAt: qr.createdAt,
                qrImage
            }));
        }
        return res.status(200).json((0, apiResponse_1.successResponse)({
            id: qr.id,
            qrData: qr.qrData,
            qrType: qr.qrType,
            description: qr.description,
            status: qr.status,
            createdAt: qr.createdAt,
            createdBy: qr.createdBy,
            qrImage
        }));
    }
    catch (error) {
        console.error('Ошибка получения QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
// Получение аналитики по сканированиям
router.get('/:id/analytics', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)("Не авторизован", apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        // Проверка существования QR кода и прав доступа
        const qr = await prisma.qRList.findUnique({
            where: { id },
            select: { createdById: true }
        });
        if (!qr) {
            return res.status(404).json((0, apiResponse_1.errorResponse)("QR код не найден", apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res.status(403).json((0, apiResponse_1.errorResponse)("Нет прав доступа", apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        // Агрегация данных по сканированиям
        const analytics = await prisma.qRAnalytic.groupBy({
            by: ['device', 'browser', 'location'],
            where: { qrListId: id },
            _count: {
                device: true,
                browser: true,
                location: true
            },
            orderBy: {
                _count: {
                    device: 'desc'
                }
            }
        });
        return res.status(200).json((0, apiResponse_1.successResponse)(analytics.map(a => ({
            device: a.device || 'unknown',
            browser: a.browser || 'unknown',
            location: a.location || 'unknown',
            count: a._count.device
        }))));
    }
    catch (error) {
        console.error('Ошибка получения аналитики:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка получения аналитики', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
// Удаление QR кода (soft delete)
router.delete('/:id', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: "Не авторизован" });
        }
        const qr = await prisma.qRList.findUnique({
            where: { id }
        });
        if (!qr) {
            return res.status(404).json({ message: "QR код не найден" });
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res.status(403).json({ message: "Нет прав для удаления" });
        }
        // Мягкое удаление через изменение статуса
        await prisma.qRList.update({
            where: { id },
            data: { status: 'DELETED' }
        });
        return res.status(204).send();
    }
    catch (error) {
        console.error('Ошибка удаления QR кода:', error);
        return res.status(500).json({
            message: 'Ошибка удаления QR кода',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        });
    }
});
// Экспорт QR кодов
router.get('/export', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: "Не авторизован" });
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
                        location: true
                    }
                }
            }
        });
        // Формируем CSV с заголовками и экранированием значений
        const headers = ['ID', 'QR Data', 'Status', 'Scan Count', 'Created At'];
        const csvRows = [];
        // Добавляем заголовки
        csvRows.push(headers.join(','));
        // Добавляем данные
        for (const qr of qrList) {
            const scanCount = qr.analytics.length;
            const row = [
                `"${qr.id}"`,
                `"${qr.qrData.replace(/"/g, '""')}"`,
                `"${qr.status}"`,
                scanCount,
                `"${qr.createdAt.toISOString()}"`
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
            error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        });
    }
});
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
// Публичный маршрут сканирования QR
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
        const qr = await prisma.qRList.findFirst({
            where: { id, status: 'ACTIVE' },
        });
        if (!qr)
            return res.status(404).json({ message: 'QR код не найден или неактивен' });
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
        // Универсальная обработка по типу
        switch (qr.qrType) {
            case 'PHONE': {
                let phone = qr.qrData.trim();
                if (!phone.startsWith('+')) {
                    phone = `+${phone}`;
                }
                return res.redirect(`tel:${phone}`);
            }
            case 'EMAIL':
                return res.redirect(`mailto:${qr.qrData}`);
            case 'WHATSAPP': {
                let number = qr.qrData.replace(/\D/g, '');
                if (!number.startsWith('+')) {
                    number = `+${number}`;
                }
                return res.redirect(`https://wa.me/${number}`);
            }
            case 'TELEGRAM': {
                let username = qr.qrData.trim();
                if (username.startsWith('@')) {
                    username = username.slice(1);
                }
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
                    const userAgent = req.headers['user-agent'] || '';
                    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
                    let vCard = qr.qrData.startsWith('BEGIN:VCARD')
                        ? qr.qrData
                        : generateVCard(JSON.parse(qr.qrData));
                    const vCardData = encodeURIComponent(vCard);
                    if (isIOS) {
                        // Для iOS используем специальный формат ссылки
                        return res.redirect(`data:text/vcard;charset=utf-8,${vCardData}`);
                    }
                    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
                    res.setHeader('Content-Disposition', 'inline; filename="contact.vcf"');
                    return res.send(vCard);
                }
                catch (error) {
                    return res.status(400).json({
                        message: 'Неверный формат контакта',
                        details: error instanceof Error ? error.message : 'Ошибка обработки VCARD'
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
// Общая статистика
router.get('/stats', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json({ message: "Не авторизован" });
        }
        const where = isAdmin ? {} : { createdById: userId };
        // Получаем общую статистику
        const stats = await prisma.$transaction([
            prisma.qRList.count({ where }),
            prisma.qRList.count({ where: { ...where, status: 'ACTIVE' } }),
            prisma.qRList.count({ where: { ...where, status: 'PAUSED' } }),
            prisma.qRList.count({ where: { ...where, status: 'DELETED' } }),
            isAdmin
                ? prisma.qRAnalytic.count()
                : prisma.qRAnalytic.count({
                    where: {
                        qrList: {
                            createdById: userId
                        }
                    }
                })
        ]);
        return res.status(200).json({
            totalQRCodes: stats[0],
            activeQRCodes: stats[1],
            pausedQRCodes: stats[2],
            deletedQRCodes: stats[3],
            totalScans: stats[4]
        });
    }
    catch (error) {
        console.error('Ошибка получения статистики:', error);
        return res.status(500).json({
            message: 'Ошибка получения статистики',
            error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        });
    }
});
// Восстановление удаленного QR кода
router.put('/:id/restore', auth_1.authenticateToken, checkUserStatus_1.checkUserStatus, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.userId;
        const isAdmin = req.user?.role === 'ADMIN';
        if (!userId) {
            return res.status(401).json((0, apiResponse_1.errorResponse)("Не авторизован", apiResponse_1.ErrorCodes.UNAUTHORIZED));
        }
        const qr = await prisma.qRList.findUnique({
            where: { id }
        });
        if (!qr) {
            return res.status(404).json((0, apiResponse_1.errorResponse)("QR код не найден", apiResponse_1.ErrorCodes.NOT_FOUND));
        }
        if (!isAdmin && qr.createdById !== userId) {
            return res.status(403).json((0, apiResponse_1.errorResponse)("Нет прав для восстановления", apiResponse_1.ErrorCodes.FORBIDDEN));
        }
        if (qr.status !== 'DELETED') {
            return res.status(400).json((0, apiResponse_1.errorResponse)("QR код не был удален", apiResponse_1.ErrorCodes.VALIDATION_ERROR));
        }
        // Восстанавливаем QR код (устанавливаем статус ACTIVE)
        const restoredQR = await prisma.qRList.update({
            where: { id },
            data: { status: 'ACTIVE' },
            select: {
                id: true,
                status: true,
                qrData: true,
                description: true
            }
        });
        return res.status(200).json((0, apiResponse_1.successResponse)(restoredQR));
    }
    catch (error) {
        console.error('Ошибка восстановления QR кода:', error);
        return res.status(500).json((0, apiResponse_1.errorResponse)('Ошибка восстановления QR кода', apiResponse_1.ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : 'Неизвестная ошибка'));
    }
});
exports.default = router;
