import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, authorizeRoles, AuthRequest } from '../middleware/auth';
import { errorResponse, successResponse, ErrorCodes } from '../utils/apiResponse';
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
  QRRestoreResponse
} from '../types/routes';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { customAlphabet } from 'nanoid';
import geoip from 'geoip-lite';
import { assertQrType, generateQRCode, normalizeAndValidate } from '../services/qrService';

const validator = require('validator');
const UAParser = require('ua-parser-js');



const router = express.Router();
const prisma = new PrismaClient();
const generateShortId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 8);

// Создание нового QR-кода
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest & { body: QRCreateRequest }, res: express.Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { qrData: rawQrData, description, qrType } = req.body;

      if (rawQrData === undefined || rawQrData === null) {
        return res.status(400).json(errorResponse('Поле qrData обязательно', ErrorCodes.VALIDATION_ERROR));
      }

      try {
        assertQrType(qrType);
      } catch (e) {
        return res.status(400).json(errorResponse((e as Error).message, ErrorCodes.VALIDATION_ERROR));
      }

      let normalizedQRData: string;
      try {
        normalizedQRData = normalizeAndValidate(qrType, rawQrData);
      } catch (e) {
        return res.status(400).json(errorResponse((e as Error).message, ErrorCodes.VALIDATION_ERROR));
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


router.patch(
  '/:id',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest & { body: QRUpdateRequest; params: { id: string } }, res: express.Response) => {
    try {
      const { id } = req.params;
      const { status, description, qrData: rawQrData, qrType } = req.body;
      const userId = req.user?.userId;
      const userRole = req.user?.role;

      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      // ничего не пришло — нечего обновлять
      if (
        status === undefined &&
        description === undefined &&
        rawQrData === undefined &&
        qrType === undefined
      ) {
        return res.status(400).json(errorResponse('Нет полей для обновления', ErrorCodes.VALIDATION_ERROR));
      }

      const existingQR = await prisma.qRList.findUnique({
        where: { id },
        select: { id: true, qrData: true, qrType: true, createdById: true, status: true, description: true }
      });

      if (!existingQR) {
        return res.status(404).json(errorResponse('QR код не найден', ErrorCodes.NOT_FOUND));
      }

      const isAdmin = userRole === 'ADMIN';
      const isOwner = existingQR.createdById === userId;
      if (!isOwner && !isAdmin) {
        return res.status(403).json(errorResponse('Нет прав для обновления', ErrorCodes.FORBIDDEN));
      }

      if (status !== undefined && !['ACTIVE','PAUSED','DELETED'].includes(status)) {
        return res.status(400).json(errorResponse('Некорректный статус', ErrorCodes.VALIDATION_ERROR));
      }

      // Определяем целевой тип и исходные данные
      let targetType = existingQR.qrType as QRUpdateRequest['qrType'];
      if (qrType !== undefined) {
        try {
          assertQrType(qrType);
          targetType = qrType;
        } catch (e) {
          return res.status(400).json(errorResponse((e as Error).message, ErrorCodes.VALIDATION_ERROR));
        }
      }

      // Данные для нормализации: либо пришли в PATCH, либо берём существующие
      const sourceData = rawQrData !== undefined ? rawQrData : existingQR.qrData;

      // Если меняется тип или сами данные — пересобираем normalized
      let nextQrData: string | undefined;
      if (qrType !== undefined || rawQrData !== undefined) {
        try {
          nextQrData = normalizeAndValidate(targetType!, sourceData);
        } catch (e) {
          return res.status(400).json(errorResponse((e as Error).message, ErrorCodes.VALIDATION_ERROR));
        }
      }

      // Собираем патч-модель. В PATCH важно включать только то, что реально меняем
      const dataToUpdate: any = { updatedAt: new Date() };

      if (status !== undefined) dataToUpdate.status = status;
      if (description !== undefined) dataToUpdate.description = description; // допускает null для очистки
      if (qrType !== undefined) dataToUpdate.qrType = targetType;
      if (nextQrData !== undefined) dataToUpdate.qrData = nextQrData;

      const updatedQR = await prisma.qRList.update({
        where: { id },
        data: dataToUpdate,
        select: {
          id: true,
          qrData: true,
          qrType: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true
        }
      });

      return res.status(200).json(successResponse(updatedQR));
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

router.get('/', authenticateToken, checkUserStatus, async (req: AuthRequest & { query: QRGetAllRequest }, res: express.Response<QRGetAllResponse>) => {
  try {
    const { createdById, status, limit = '10', offset = '0' } = req.query;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN'; // Предполагаем наличие роли ADMIN

    if (!userId) {
      return res.status(401).json(
        errorResponse("Не авторизован", ErrorCodes.UNAUTHORIZED)
      );
    }

    // Подготовка условий фильтрации
    const where: any = {};

    // Для не-админов показываем только свои QR коды
    if (!isAdmin) {
      where.createdById = userId;
    } 
    // Для админов - фильтр по byUserId если указан
    else if (createdById) {
      const createdByIdNum = parseInt(createdById as string);
      if (isNaN(createdByIdNum)) {
        return res.status(400).json(
          errorResponse("Некорректный ID пользователя", ErrorCodes.VALIDATION_ERROR)
        );
      }
      where.createdById = createdByIdNum;
    }

    // Фильтр по статусу если указан
    if (status && ['ACTIVE', 'PAUSED', 'DELETED'].includes(status as string)) {
      where.status = status;
    }

    // Получаем список с пагинацией
    const limitNum = parseInt(limit as string) || 10;
    const offsetNum = parseInt(offset as string) || 0;
    
    if (isNaN(limitNum)) {
      return res.status(400).json(
        errorResponse("Некорректное значение limit", ErrorCodes.VALIDATION_ERROR)
      );
    }
    
    if (isNaN(offsetNum)) {
      return res.status(400).json(
        errorResponse("Некорректное значение offset", ErrorCodes.VALIDATION_ERROR)
      );
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
            lastName: true
          }
        }
      }
    });

    // Получаем общее количество для пагинации
    const totalCount = await prisma.qRList.count({ where });

    return res.status(200).json(
      successResponse({
        data: qrList,
        meta: {
          total: totalCount,
          limit: limitNum.toString(),
          offset: offsetNum.toString()
        }
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
});

// Получение детальной информации о QR коде
router.get('/:id', authenticateToken, checkUserStatus, async (
  req: AuthRequest<{id: string}, any, any, {
    simple?: string;
    width?: string;
    darkColor?: string;
    lightColor?: string;
    margin?: string;
    errorCorrection?: string;
  }>,
  res: express.Response<QRGetByIdResponse>
) => {
  try {
    const { id } = req.params;
    const { 
      simple, 
      width = '300',
      darkColor = '000000',
      lightColor = 'ffffff',
      margin = '1',
      errorCorrection = 'M'
    } = req.query;
    
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    if (!userId) {
      return res.status(401).json(
        errorResponse("Не авторизован", ErrorCodes.UNAUTHORIZED)
      );
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
      return res.status(404).json(
        errorResponse("QR код не найден", ErrorCodes.NOT_FOUND)
      );
    }

    if (!isAdmin && qr.createdById !== userId) {
      return res.status(403).json(
        errorResponse("Нет прав доступа", ErrorCodes.FORBIDDEN)
      );
    }

    // Генерация QR с параметрами или без
    const options = {
      width: parseInt(width as string),
      color: {
        dark: `#${darkColor}`,
        light: `#${lightColor}`
      },
      margin: parseInt(margin as string),
      errorCorrectionLevel: errorCorrection as 'L'|'M'|'Q'|'H'
    };

    const domen = process.env.DOMEN_URL || "http://192.168.30.54:3000/"
    const urlQR = domen + "qr/" + qr.id + "/scan";
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
          qrImage
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
        qrImage
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
});

// Получение аналитики по сканированиям
router.get('/:id/analytics', authenticateToken, checkUserStatus, async (req: AuthRequest & { params: { id: string } }, res: express.Response<QRAnalyticsResponse>) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    if (!userId) {
      return res.status(401).json(
        errorResponse("Не авторизован", ErrorCodes.UNAUTHORIZED)
      );
    }

    // Проверка существования QR кода и прав доступа
    const qr = await prisma.qRList.findUnique({
      where: { id },
      select: { createdById: true }
    });

    if (!qr) {
      return res.status(404).json(
        errorResponse("QR код не найден", ErrorCodes.NOT_FOUND)
      );
    }

    if (!isAdmin && qr.createdById !== userId) {
      return res.status(403).json(
        errorResponse("Нет прав доступа", ErrorCodes.FORBIDDEN)
      );
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

    return res.status(200).json(
      successResponse(analytics.map(a => ({
        device: a.device || 'unknown',
        browser: a.browser || 'unknown',
        location: a.location || 'unknown',
        count: a._count.device
      })))
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
});

// Удаление QR кода (soft delete)
router.delete('/:id', authenticateToken, checkUserStatus, async (req: AuthRequest & { params: { id: string } }, res: express.Response) => {
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

  } catch (error) {
    console.error('Ошибка удаления QR кода:', error);
    return res.status(500).json({ 
      message: 'Ошибка удаления QR кода',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

// Экспорт QR кодов
router.get('/export', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
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

  } catch (error) {
    console.error('Ошибка экспорта QR кодов:', error);
    return res.status(500).json({ 
      message: 'Ошибка экспорта QR кодов',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});


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

// Публичный маршрут сканирования QR
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
    const browser = `${result.browser.name || 'unknown'} ${
      result.browser.version || ''
    }`.trim();

    const qr = await prisma.qRList.findFirst({
      where: { id, status: 'ACTIVE' },
    });
    if (!qr) return res.status(404).json({ message: 'QR код не найден или неактивен' });

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
        
        // Validate phone number format
        if (!validator.isMobilePhone(phone, 'any', { strictMode: true })) {
          return res.status(400).json({ 
            message: 'Неверный формат номера телефона',
            phone: phone
          });
        }

        // URL encode phone number
        const encodedPhone = encodeURIComponent(phone);
        
        // Check device type
        const userAgent = req.headers['user-agent'] || '';
        const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent);
        
        if (isMobile) {
          // For mobile devices - redirect to tel: link
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
          // For desktop - redirect to WhatsApp
          const whatsappNumber = phone.replace(/[^\d+]/g, '');
          return res.redirect(`https://wa.me/${whatsappNumber}`);
        }
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
        const url =
          qr.qrData.startsWith('http://') || qr.qrData.startsWith('https://')
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
        } catch (error) {
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
  } catch (error) {
    console.error('Ошибка трекинга сканирования:', error);
    return res.status(500).json({
      message: 'Ошибка трекинга сканирования',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка',
    });
  }
});


// Общая статистика
router.get('/stats', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
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

  } catch (error) {
    console.error('Ошибка получения статистики:', error);
    return res.status(500).json({ 
      message: 'Ошибка получения статистики',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

// Восстановление удаленного QR кода
router.put('/:id/restore', authenticateToken, checkUserStatus, async (req: AuthRequest & { params: { id: string } }, res: express.Response<QRRestoreResponse>) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    if (!userId) {
      return res.status(401).json(
        errorResponse("Не авторизован", ErrorCodes.UNAUTHORIZED)
      );
    }

    const qr = await prisma.qRList.findUnique({
      where: { id }
    });

    if (!qr) {
      return res.status(404).json(
        errorResponse("QR код не найден", ErrorCodes.NOT_FOUND)
      );
    }

    if (!isAdmin && qr.createdById !== userId) {
      return res.status(403).json(
        errorResponse("Нет прав для восстановления", ErrorCodes.FORBIDDEN)
      );
    }

    if (qr.status !== 'DELETED') {
      return res.status(400).json(
        errorResponse("QR код не был удален", ErrorCodes.VALIDATION_ERROR)
      );
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

    return res.status(200).json(
      successResponse(restoredQR)
    );

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
});

export default router;
