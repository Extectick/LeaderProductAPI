import express from 'express';
import { PrismaClient, ProfileType, ProfileStatus } from '@prisma/client';
import { authenticateToken, authorizeRoles, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { auditLog, authorizeDepartmentManager } from '../middleware/audit';
import { customAlphabet } from 'nanoid';

const router = express.Router();
const prisma = new PrismaClient();
const generateShortId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 8);

// Generate qr code
router.post('/', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const { qrData, description } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "Не авторизован" });
    }

    if (!qrData) {
      return res.status(400).json({ message: "Поле qrData обязательно" });
    }

    const generatedId = generateShortId();

    const newQR = await prisma.qRList.create({
      data: {
        id: generatedId,
        qrData,
        description: description || null,
        createdById: userId,
        status: 'ACTIVE' // Устанавливаем статус по умолчанию
      },
      select: {
        id: true,
        qrData: true,
        description: true,
        status: true,
        createdAt: true
      }
    });

    return res.status(201).json(newQR);

  } catch (error) {
    console.error('Ошибка создания QR кода:', error);
    return res.status(500).json({ 
      message: 'Ошибка создания QR кода',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});


router.patch('/:id', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, description } = req.body;
    const userId = req.user?.userId;
    const userRole = req.user?.role;

    if (!userId) {
      return res.status(401).json({ message: "Не авторизован" });
    }

    // Проверяем существование QR кода
    const existingQR = await prisma.qRList.findUnique({
      where: { id }
    });

    if (!existingQR) {
      return res.status(404).json({ message: "QR код не найден" });
    }

    // Проверяем права (создатель или админ)
    const isAdmin = userRole === 'ADMIN'; // Предполагаем, что есть такая роль
    const isOwner = existingQR.createdById === userId;
    
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Нет прав для обновления" });
    }

    // Валидация статуса
    if (status && !['ACTIVE', 'PAUSED', 'DELETED'].includes(status)) {
      return res.status(400).json({ message: "Некорректный статус" });
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

    return res.status(200).json(updatedQR);

  } catch (error) {
    console.error('Ошибка обновления QR кода:', error);
    return res.status(500).json({ 
      message: 'Ошибка обновления QR кода',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

router.get('/', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const { createdById, status, limit = 10, offset = 0 } = req.query;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN'; // Предполагаем наличие роли ADMIN

    if (!userId) {
      return res.status(401).json({ message: "Не авторизован" });
    }

    // Подготовка условий фильтрации
    const where: any = {};

    // Для не-админов показываем только свои QR коды
    if (!isAdmin) {
      where.createdById = userId;
    } 
    // Для админов - фильтр по byUserId если указан
    else if (createdById) {
      where.createdById = parseInt(createdById as string);
    }

    // Фильтр по статусу если указан
    if (status && ['ACTIVE', 'PAUSED', 'DELETED'].includes(status as string)) {
      where.status = status;
    }

    // Получаем список с пагинацией
    const qrList = await prisma.qRList.findMany({
      where,
      skip: parseInt(offset as string),
      take: parseInt(limit as string),
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

    return res.status(200).json({
      data: qrList,
      meta: {
        total: totalCount,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string)
      }
    });

  } catch (error) {
    console.error('Ошибка получения списка QR кодов:', error);
    return res.status(500).json({ 
      message: 'Ошибка получения списка QR кодов',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

// Получение детальной информации о QR коде
router.get('/:id', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    if (!userId) {
      return res.status(401).json({ message: "Не авторизован" });
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
        },
        analytics: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    if (!qr) {
      return res.status(404).json({ message: "QR код не найден" });
    }

    // Проверка прав доступа
    if (!isAdmin && qr.createdById !== userId) {
      return res.status(403).json({ message: "Нет прав доступа" });
    }

    return res.status(200).json(qr);

  } catch (error) {
    console.error('Ошибка получения QR кода:', error);
    return res.status(500).json({ 
      message: 'Ошибка получения QR кода',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

// Получение аналитики по сканированиям
router.get('/:id/analytics', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'ADMIN';

    if (!userId) {
      return res.status(401).json({ message: "Не авторизован" });
    }

    // Проверка существования QR кода и прав доступа
    const qr = await prisma.qRList.findUnique({
      where: { id },
      select: { createdById: true }
    });

    if (!qr) {
      return res.status(404).json({ message: "QR код не найден" });
    }

    if (!isAdmin && qr.createdById !== userId) {
      return res.status(403).json({ message: "Нет прав доступа" });
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

    return res.status(200).json(analytics);

  } catch (error) {
    console.error('Ошибка получения аналитики:', error);
    return res.status(500).json({ 
      message: 'Ошибка получения аналитики',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

// Удаление QR кода (soft delete)
router.delete('/:id', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
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

// Трекинг сканирований (публичный эндпоинт)
router.post('/:id/scan', async (req, res) => {
  try {
    const { id } = req.params;
    const { device, browser } = req.body;
    const ip = req.ip;
    
    // Определяем геолокацию по IP (в реальной реализации нужно использовать сервис геолокации)
    const location = ip === '::1' ? 'localhost' : ip;

    // Проверяем существование QR кода
    const qrExists = await prisma.qRList.count({
      where: { 
        id,
        status: 'ACTIVE' // Только активные QR коды
      }
    });

    if (!qrExists) {
      return res.status(404).json({ message: "QR код не найден или неактивен" });
    }

    // Фиксируем сканирование
    await prisma.qRAnalytic.create({
      data: {
        qrListId: id,
        ip,
        location,
        device: device || 'Unknown',
        browser: browser || 'Unknown',
        scanDuration: 0 // В реальной реализации можно передавать время сканирования
      }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Ошибка трекинга сканирования:', error);
    return res.status(500).json({ 
      message: 'Ошибка трекинга сканирования',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
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
router.put('/:id/restore', authenticateToken, checkUserStatus, async (req: AuthRequest, res) => {
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
      return res.status(403).json({ message: "Нет прав для восстановления" });
    }

    if (qr.status !== 'DELETED') {
      return res.status(400).json({ message: "QR код не был удален" });
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

    return res.status(200).json(restoredQR);

  } catch (error) {
    console.error('Ошибка восстановления QR кода:', error);
    return res.status(500).json({ 
      message: 'Ошибка восстановления QR кода',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    });
  }
});

export default router;
