import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../prisma/client';
import { sendVerificationEmail } from '../services/mailService';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import {
  PasswordResetRequestRequest,
  PasswordResetRequestResponse,
  PasswordResetSubmitRequest,
  PasswordResetSubmitResponse,
  PasswordResetVerifyResponse
} from '../types/routes';

const router = Router();

const PASSWORD_RESET_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час

/**
 * @openapi
 * tags:
 *   - name: Password Reset
 *     description: Сброс пароля по email с кодом подтверждения
 */

// Генерация кода — 6 цифр
function generateResetCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * @openapi
 * /password-reset/request:
 *   post:
 *     tags: [Password Reset]
 *     summary: Запрос кода для сброса пароля
 *     description: Отправляет на email 6-значный код для сброса пароля. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *             required: [email]
 *     responses:
 *       200:
 *         description: Запрос принят (даже если пользователь не существует)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Некорректный запрос (нет email)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/password-reset/request', async (req: Request<{}, {}, PasswordResetRequestRequest>, res: Response<PasswordResetRequestResponse>) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json(
      errorResponse('Требуется email', ErrorCodes.VALIDATION_ERROR)
    );

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Чтобы не давать подсказки, возвращаем 200 всегда
      return res.json(successResponse(null));
    }

    // Генерируем код
    const code = generateResetCode();

    // Создаём запись в PasswordReset
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        code,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_EXPIRATION_MS),
        used: false,
      },
    });

    // Отправляем email с кодом
    await sendVerificationEmail(email, code);

    res.json(successResponse(null));
  } catch (error) {
    console.error('Ошибка запроса сброса пароля:', error);
    res.status(500).json(
      errorResponse('Ошибка запроса сброса пароля', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

/**
 * @openapi
 * /password-reset/verify:
 *   post:
 *     tags: [Password Reset]
 *     summary: Проверка кода сброса пароля
 *     description: Валидирует присланный по email код сброса. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string, example: "123456" }
 *             required: [email, code]
 *     responses:
 *       200:
 *         description: Код корректный и не просрочен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Неверные email/код или код просрочен/использован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/password-reset/verify', async (req: Request<{}, {}, { email: string; code: string }>, res: Response<PasswordResetVerifyResponse>) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json(
      errorResponse('Требуется email и код', ErrorCodes.VALIDATION_ERROR)
    );

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json(
      errorResponse('Неверные email или код', ErrorCodes.VALIDATION_ERROR)
    );

    const resetRequest = await prisma.passwordReset.findFirst({
      where: {
        userId: user.id,
        code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetRequest) {
      return res.status(400).json(
        errorResponse('Неверный или просроченный код', ErrorCodes.VALIDATION_ERROR)
      );
    }

    res.json(successResponse(null));
  } catch (error) {
    console.error('Ошибка проверки кода сброса пароля:', error);
    res.status(500).json(
      errorResponse('Ошибка проверки кода', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

/**
 * @openapi
 * /password-reset/change:
 *   post:
 *     tags: [Password Reset]
 *     summary: Смена пароля по коду
 *     description: Проверяет код и задаёт новый пароль для пользователя. Эндпоинт публичный.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string, example: "123456" }
 *               newPassword: { type: string, minLength: 6 }
 *             required: [email, code, newPassword]
 *     responses:
 *       200:
 *         description: Пароль успешно изменён
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
 *                         message:
 *                           type: string
 *                           example: Пароль успешно изменён
 *       400:
 *         description: Некорректные данные или неверный/просроченный код
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/password-reset/change', async (req: Request<{}, {}, PasswordResetSubmitRequest>, res: Response<PasswordResetSubmitResponse>) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json(
        errorResponse('Требуются email, код и новый пароль', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (newPassword.length < 6) {
      return res.status(400).json(
        errorResponse('Пароль должен быть не менее 6 символов', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json(
      errorResponse('Неверные email или код', ErrorCodes.VALIDATION_ERROR)
    );

    const resetRequest = await prisma.passwordReset.findFirst({
      where: {
        userId: user.id,
        code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetRequest) {
      return res.status(400).json(
        errorResponse('Неверный или просроченный код', ErrorCodes.VALIDATION_ERROR)
      );
    }

    // Хэшируем новый пароль
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Обновляем пароль пользователя
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Отмечаем код сброса как использованный
    await prisma.passwordReset.update({
      where: { id: resetRequest.id },
      data: { used: true },
    });

    res.json(
      successResponse({ message: 'Пароль успешно изменён' })
    );
  } catch (error) {
    console.error('Ошибка изменения пароля:', error);
    res.status(500).json(
      errorResponse('Ошибка изменения пароля', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

export default router;
