import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();
const prisma = new PrismaClient();

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
const accessTokenLife = '15m';
const refreshTokenLife = '14d';
// Максимальное количество попыток для входа и после блокировка + 1 количество
const MAX_FAILED_LOGIN_ATTEMPTS = 19;

// Helper to generate tokens
function generateAccessToken(user: any) {
  return jwt.sign(
    { userId: user.id, role: user.role.name, permissions: user.role.permissions.map((p: any) => p.name) },
    accessTokenSecret,
    { expiresIn: accessTokenLife }
  );
}

function generateRefreshToken(user: any) {
  return jwt.sign(
    { userId: user.id },
    refreshTokenSecret,
    { expiresIn: refreshTokenLife }
  );
}

// Register endpoint (simplified, email verification to be implemented)
import { sendVerificationEmail } from '../services/mailService';
import crypto from 'crypto';

const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 25 * 1000; // 25 seconds
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour
const ACCOUNT_DELETION_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Helper function to generate cryptographically secure 6-digit code
function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Helper function to send verification code email with resend interval check
async function sendVerificationCodeEmail(userId: number, email: string) {
  const existingVerification = await prisma.emailVerification.findFirst({
    where: { userId, used: false },
    orderBy: { createdAt: 'desc' },
  });

  if (existingVerification) {
    const now = new Date();
    // @ts-ignore
    if (existingVerification.lastSentAt && now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS) {
      throw new Error('Verification code was sent recently. Please wait before requesting a new code.');
    }
    // Update lastSentAt and resend the same code
    await prisma.emailVerification.update({
      where: { id: existingVerification.id },
      data: {
        // @ts-ignore
        lastSentAt: new Date(),
      },
    });
    await sendVerificationEmail(email, existingVerification.code);
    return;
  }

  // No existing code, create a new one
  const code = generateVerificationCode();
  await prisma.emailVerification.create({
    data: {
      userId,
      code,
      expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION_MS),
      used: false,
      // @ts-ignore
      attemptsCount: 0,
      // @ts-ignore
      lastSentAt: new Date(),
    },
  });
  await sendVerificationEmail(email, code);
}

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) return res.status(400).json({ message: 'Требуется email и пароль' });

    // Validate email format (simple regex)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ message: 'Неверный формат email' });

    // Validate password length (min 6 chars)
    if (password.length < 6) return res.status(400).json({ message: 'Пароль должен быть не менее 6 символов' });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (!existingUser.isActive) {
        // User exists but is not active, resend verification code
        await sendVerificationCodeEmail(existingUser.id, email);
        return res.status(200).json({ message: 'Пользователь уже зарегистрирован, но не активирован. Код подтверждения отправлен повторно.' });
      }
      return res.status(409).json({ message: 'Пользователь уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        isActive: false, // will be activated after email verification
        role: { connect: { name: 'user' } },
      },
    });

    await sendVerificationCodeEmail(user.id, email);

    res.status(201).json({ message: 'Пользователь зарегистрирован. Пожалуйста, подтвердите email.' });
  } catch (error: any) {
    if (error.message && error.message.includes('recently')) {
      return res.status(429).json({ message: error.message });
    }
    res.status(500).json({ message: 'Ошибка регистрации', error });
  }
});

// Login endpoint
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Требуется email и пароль' });

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { 
        role: { include: { permissions: true } },
        loginAttempts: {
          orderBy: { createdAt: 'desc' },
          take: 5
        },
        clientProfile: true,
        supplierProfile: true,
        employeeProfile: true
      },
    });
    
    if (!user) {
      console.error(`Пользователь с email ${email} не найден`);
      return res.status(401).json({ message: 'Неверные учетные данные' });
    }

    // Проверка блокировки основного пользователя
    if (user.profileStatus === 'BLOCKED') {
      console.error(`Пользователь с email ${email} заблокирован`);
      return res.status(403).json({ message: 'Ваш аккаунт заблокирован. Обратитесь в поддержку.' });
    }

    // Проверка активации аккаунта
    if (!user.isActive) {
      console.error(`Пользователь с email ${email} не активирован`);
      return res.status(403).json({ message: 'Аккаунт не активирован. Пожалуйста, подтвердите email.' });
    }

    // Проверка блокировки профиля в зависимости от типа профиля
    let activeProfileStatus;
    switch (user.currentProfileType) {
      case 'CLIENT':
        activeProfileStatus = user.clientProfile?.status;
        break;
      case 'SUPPLIER':
        activeProfileStatus = user.supplierProfile?.status;
        break;
      case 'EMPLOYEE':
        activeProfileStatus = user.employeeProfile?.status;
        break;
      default:
        // Если тип профиля не установлен, считаем его активным
        activeProfileStatus = 'ACTIVE';
    }

    if (activeProfileStatus === 'BLOCKED') {
      console.error(`Профиль пользователя с email ${email} заблокирован`);
      return res.status(403).json({ message: 'Ваш профиль заблокирован. Обратитесь в поддержку.' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      console.error(`Неверный пароль для пользователя с email ${email}`);
      
      // Записываем неудачную попытку входа
      await prisma.loginAttempt.create({
        data: {
          userId: user.id,
          success: false,
          ip: req.ip
        }
      });
      
      // Проверяем количество неудачных попыток
      const failedAttempts = user.loginAttempts.filter(a => !a.success).length;
      if (failedAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) { // 5 попыток (текущая + 4 предыдущих)
        await prisma.user.update({
          where: { id: user.id },
          data: { profileStatus: 'BLOCKED' }
        });
        
        // Записываем в аудит-лог
        await prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'OTHER',
            targetType: 'USER',
            targetId: user.id,
            details: 'Автоматическая блокировка из-за множества неудачных попыток входа'
          }
        });
        
        return res.status(403).json({ message: 'Слишком много неудачных попыток. Ваш аккаунт заблокирован.' });
      }
      
      return res.status(401).json({ message: 'Неверные учетные данные' });
    }

    // Если пароль верный, создаем токены
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Записываем успешную попытку входа
    await prisma.loginAttempt.create({
      data: {
        userId: user.id,
        success: true,
        ip: req.ip
      }
    });

    // Записываем в аудит-лог
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        targetType: 'USER',
        targetId: user.id,
        details: 'Успешный вход в систему'
      }
    });

    // Store refresh token in DB
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 дней
      },
    });

    res.json({ accessToken, refreshToken });
  } catch (error) {
    console.error('Ошибка при входе:', error);
    res.status(500).json({ message: 'Ошибка входа', error });
  }
});

// Token refresh endpoint
router.post('/token', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) return res.status(400).json({ message: 'Требуется refresh токен' });

  try {
    const storedToken = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!storedToken || storedToken.revoked || storedToken.expiresAt < new Date()) {
      console.error('Неверный или просроченный refresh токен');
      return res.status(403).json({ message: 'Неверный или просроченный refresh токен' });
    }

    jwt.verify(refreshToken, refreshTokenSecret, async (err: jwt.VerifyErrors | null, payload: any) => {
      if (err) {
        console.error('Неверный refresh токен');
        return res.status(403).json({ message: 'Неверный refresh токен' });
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { role: { include: { permissions: true } } },
      });
      if (!user) {
        console.error('Пользователь не найден');
        return res.status(403).json({ message: 'Пользователь не найден' });
      }

      const newAccessToken = generateAccessToken(user);
      const newRefreshToken = generateRefreshToken(user);

      // Revoke old refresh token and store new one
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revoked: true },
      });
      await prisma.refreshToken.create({
        data: {
          token: newRefreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    });
  } catch (error) {
    console.error('Ошибка при обновлении токена:', error);
    res.status(500).json({ message: 'Обновление токена не удалось', error });
  }
});

// Logout endpoint (revoke refresh token)
router.post('/logout', authenticateToken, async (req: AuthRequest, res) => {
  
  const { refreshToken } = req.body;
  // console.log(refreshToken)
  if (!refreshToken) return res.status(400).json({ message: 'Refresh token required' });

  try {
    await prisma.refreshToken.updateMany({
      where: { token: refreshToken, userId: req.user!.userId },
      data: { revoked: true },
    });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Logout failed', error });
  }
});

// Verify email and activate account endpoint
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;

  if (!email || !code) return res.status(400).json({ message: 'Требуется email и код' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  if (user.isActive) return res.status(400).json({ message: 'Аккаунт уже активирован' });

  const verification = await prisma.emailVerification.findFirst({
    where: { userId: user.id, code, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!verification) {
    // Increment attemptsCount if possible
    const lastVerification = await prisma.emailVerification.findFirst({
      where: { userId: user.id, used: false },
      orderBy: { createdAt: 'desc' },
    });
    if (lastVerification) {
      const newAttempts = (lastVerification.attemptsCount || 0) + 1;
      if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
        return res.status(429).json({ message: 'Превышено максимальное количество попыток подтверждения' });
      }
      await prisma.emailVerification.update({
        where: { id: lastVerification.id },
        data: { attemptsCount: newAttempts },
      });
    }
    return res.status(400).json({ message: 'Неверный или просроченный код подтверждения' });
  }

  // Mark verification as used and activate user
  await prisma.emailVerification.update({
    where: { id: verification.id },
    data: { used: true },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { isActive: true },
  });

  // Generate tokens for automatic login
  const userWithRole = await prisma.user.findUnique({
    where: { id: user.id },
    include: { role: { include: { permissions: true } } },
  });
  if (!userWithRole) return res.status(500).json({ message: 'Ошибка получения данных пользователя' });

  const accessToken = generateAccessToken(userWithRole);
  const refreshToken = generateRefreshToken(userWithRole);

  // Store refresh token in DB
  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 дней
    },
  });

  res.json({ message: 'Аккаунт подтвержден и активирован', accessToken, refreshToken });
} catch (error) {
  res.status(500).json({ message: 'Ошибка подтверждения', error });
}
});

export default router;
