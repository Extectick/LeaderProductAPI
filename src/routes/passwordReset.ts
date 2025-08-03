import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { sendVerificationEmail } from '../services/mailService';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';

const router = Router();
const prisma = new PrismaClient();

const PASSWORD_RESET_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час

// Генерация кода — 6 цифр
function generateResetCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

router.post('/password-reset/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json(
      errorResponse('Требуется email', ErrorCodes.VALIDATION_ERROR)
    );

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Чтобы не давать подсказки, возвращаем 200 всегда
      return res.json({ message: 'Если email зарегистрирован, код отправлен' });
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

    res.json(
      successResponse(null, 'Если email зарегистрирован, код отправлен')
    );
  } catch (error) {
    console.error('Ошибка запроса сброса пароля:', error);
    res.status(500).json({ message: 'Ошибка запроса сброса пароля' });
  }
});

router.post('/password-reset/verify', async (req, res) => {
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

    res.json(
      successResponse(null, 'Код подтверждён')
    );
  } catch (error) {
    console.error('Ошибка проверки кода сброса пароля:', error);
    res.status(500).json(
      errorResponse('Ошибка проверки кода', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

router.post('/password-reset/change', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json(
        errorResponse('Требуются email, код и новый пароль', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Пароль должен быть не менее 6 символов' });
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
      successResponse(null, 'Пароль успешно изменён')
    );
  } catch (error) {
    console.error('Ошибка изменения пароля:', error);
    res.status(500).json(
      errorResponse('Ошибка изменения пароля', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

export default router;
