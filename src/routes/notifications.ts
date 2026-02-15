// src/routes/notifications.ts
import express from 'express';
import { z } from 'zod';
import prisma from '../prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';

const router = express.Router();

// ---- Схема валидации настроек ----

const UpdateSettingsSchema = z.object({
  inAppNotificationsEnabled:    z.boolean().optional(),
  telegramNotificationsEnabled: z.boolean().optional(),
  pushNewMessage:               z.boolean().optional(),
  pushStatusChanged:            z.boolean().optional(),
  pushDeadlineChanged:          z.boolean().optional(),
  telegramNewAppeal:            z.boolean().optional(),
  telegramStatusChanged:        z.boolean().optional(),
  telegramDeadlineChanged:      z.boolean().optional(),
  telegramUnreadReminder:       z.boolean().optional(),
  telegramClosureReminder:      z.boolean().optional(),
  telegramNewMessage:           z.boolean().optional(),
});

// Дефолтные настройки (если строки нет в БД)
const DEFAULT_SETTINGS = {
  inAppNotificationsEnabled:    true,
  telegramNotificationsEnabled: true,
  pushNewMessage:               true,
  pushStatusChanged:            true,
  pushDeadlineChanged:          true,
  telegramNewAppeal:            true,
  telegramStatusChanged:        true,
  telegramDeadlineChanged:      true,
  telegramUnreadReminder:       true,
  telegramClosureReminder:      true,
  telegramNewMessage:           true,
};

// ---- GET /notifications/settings ----
router.get(
  '/settings',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.userId;
      const row = await prisma.userNotificationSettings.findUnique({ where: { userId } });
      const settings = row ?? { userId, ...DEFAULT_SETTINGS };
      return res.json(successResponse({ settings }, 'OK'));
    } catch (err: any) {
      console.error('[notifications] GET /settings error:', err?.message);
      return res.status(500).json(errorResponse('Внутренняя ошибка', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// ---- PATCH /notifications/settings ----
router.patch(
  '/settings',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.userId;
      const parsed = UpdateSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(
          errorResponse('Ошибка валидации', ErrorCodes.VALIDATION_ERROR, parsed.error.flatten())
        );
      }
      if (!Object.keys(parsed.data).length) {
        return res.status(400).json(
          errorResponse('Не передано ни одного поля', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const settings = await prisma.userNotificationSettings.upsert({
        where:  { userId },
        create: { userId, ...DEFAULT_SETTINGS, ...parsed.data },
        update: parsed.data,
      });

      return res.json(successResponse({ settings }, 'Настройки сохранены'));
    } catch (err: any) {
      console.error('[notifications] PATCH /settings error:', err?.message);
      return res.status(500).json(errorResponse('Внутренняя ошибка', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// ---- GET /notifications/appeals/:appealId/mute ----
router.get(
  '/appeals/:appealId/mute',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest<{ appealId: string }>, res) => {
    try {
      const userId   = req.user!.userId;
      const appealId = Number(req.params.appealId);
      if (!Number.isInteger(appealId) || appealId <= 0) {
        return res.status(400).json(errorResponse('Некорректный appealId', ErrorCodes.VALIDATION_ERROR));
      }

      const mute = await prisma.appealMute.findUnique({
        where: { userId_appealId: { userId, appealId } },
      });

      return res.json(successResponse({ muted: mute !== null }, 'OK'));
    } catch (err: any) {
      console.error('[notifications] GET /appeals/:id/mute error:', err?.message);
      return res.status(500).json(errorResponse('Внутренняя ошибка', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// ---- POST /notifications/appeals/:appealId/mute ----
router.post(
  '/appeals/:appealId/mute',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest<{ appealId: string }>, res) => {
    try {
      const userId   = req.user!.userId;
      const appealId = Number(req.params.appealId);
      if (!Number.isInteger(appealId) || appealId <= 0) {
        return res.status(400).json(errorResponse('Некорректный appealId', ErrorCodes.VALIDATION_ERROR));
      }

      const appeal = await prisma.appeal.findUnique({
        where: { id: appealId },
        select: { id: true },
      });
      if (!appeal) {
        return res.status(404).json(errorResponse('Обращение не найдено', ErrorCodes.NOT_FOUND));
      }

      await prisma.appealMute.upsert({
        where:  { userId_appealId: { userId, appealId } },
        create: { userId, appealId },
        update: {},
      });

      return res.json(successResponse({ muted: true }, 'Уведомления отключены'));
    } catch (err: any) {
      console.error('[notifications] POST /appeals/:id/mute error:', err?.message);
      return res.status(500).json(errorResponse('Внутренняя ошибка', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

// ---- DELETE /notifications/appeals/:appealId/mute ----
router.delete(
  '/appeals/:appealId/mute',
  authenticateToken,
  checkUserStatus,
  async (req: AuthRequest<{ appealId: string }>, res) => {
    try {
      const userId   = req.user!.userId;
      const appealId = Number(req.params.appealId);
      if (!Number.isInteger(appealId) || appealId <= 0) {
        return res.status(400).json(errorResponse('Некорректный appealId', ErrorCodes.VALIDATION_ERROR));
      }

      await prisma.appealMute.deleteMany({ where: { userId, appealId } });

      return res.json(successResponse({ muted: false }, 'Уведомления включены'));
    } catch (err: any) {
      console.error('[notifications] DELETE /appeals/:id/mute error:', err?.message);
      return res.status(500).json(errorResponse('Внутренняя ошибка', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
