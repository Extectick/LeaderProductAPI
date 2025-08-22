import express from 'express';
import bcrypt from 'bcryptjs';
import jwt, { VerifyErrors } from 'jsonwebtoken';
import { PrismaClient, User, Role, Permission } from '@prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { sendVerificationEmail } from '../services/mailService';
import passwordResetRouter from './passwordReset';
import crypto, { randomUUID } from 'crypto';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import {
  AuthRegisterRequest,
  AuthRegisterResponse,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthVerifyRequest,
  AuthVerifyResponse,
  AuthTokenRequest,
  AuthTokenResponse,
  AuthLogoutRequest,
  AuthLogoutResponse
} from '../types/routes';
import { getProfile } from '../services/userService';

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Аутентификация и управление токенами
 *
 * # Примечание:
 * # - Все ответы используют унифицированные обёртки ApiSuccess/ApiError.
 * # - Для /auth/logout требуется bearer JWT.
 */

router.use(passwordResetRouter);

const prisma = new PrismaClient();

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
const accessTokenLife = '15m';
const refreshTokenLife = '14d';
const MAX_FAILED_LOGIN_ATTEMPTS = 19;
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 25 * 1000; // 25 секунд
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час

// Тип для User с ролью и правами
type UserWithRolePermissions = User & {
  role: Role & {
    permissions: {
      permission: Permission;
    }[];
  };
  loginAttempts?: { success: boolean }[];
  clientProfile?: any;
  supplierProfile?: any;
  employeeProfile?: any;
  name?: string;
};

function generateAccessToken(user: UserWithRolePermissions) {
  const payload = {
    userId: user.id,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.permission.name),
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, accessTokenSecret, {
    expiresIn: accessTokenLife,
    algorithm: 'HS256',
  });
}

function generateRefreshToken(user: UserWithRolePermissions) {
  const payload = {
    userId: user.id,
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, refreshTokenSecret, {
    expiresIn: refreshTokenLife,
    algorithm: 'HS256',
  });
}

function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function sendVerificationCodeEmail(userId: number, email: string) {
  const existingVerification = await prisma.emailVerification.findFirst({
    where: { userId, used: false },
    orderBy: { createdAt: 'desc' },
  });

  if (existingVerification) {
    const now = new Date();
    if (
      existingVerification.lastSentAt &&
      now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS
    ) {
      throw new Error(
        'Verification code was sent recently. Please wait before requesting a new code.'
      );
    }
    await prisma.emailVerification.update({
      where: { id: existingVerification.id },
      data: { lastSentAt: new Date() },
    });
    await sendVerificationEmail(email, existingVerification.code);
    return;
  }

  const code = generateVerificationCode();
  await prisma.emailVerification.create({
    data: {
      userId,
      code,
      expiresAt: new Date(Date.now() + VERIFICATION_CODE_EXPIRATION_MS),
      used: false,
      attemptsCount: 0,
      lastSentAt: new Date(),
    },
  });
  await sendVerificationEmail(email, code);
}

function generateSecureRandomToken(length = 64) {
  return crypto.randomBytes(length).toString('hex'); // 128-символьный строковый токен
}

// Функция создания уникального refresh токена с повтором при коллизии
export async function createUniqueRefreshToken(userId: number): Promise<string> {
  const jti = randomUUID(); // Гарантирует уникальность
  const token = jwt.sign({ userId, jti }, refreshTokenSecret, { expiresIn: '30d' });

  await prisma.refreshToken.create({
    data: {
      token,
      userId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return token;
}

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Регистрация нового пользователя
 *     description: Создаёт пользователя и отправляет код подтверждения email.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 6 }
 *             required: [email, password]
 *     responses:
 *       201:
 *         description: Зарегистрирован, код отправлен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       200:
 *         description: Пользователь уже есть, но не активирован — код переотправлен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       409:
 *         description: Пользователь уже существует
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Слишком частые запросы кода подтверждения
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/register', async (req: express.Request<{}, {}, AuthRegisterRequest>, res: express.Response<AuthRegisterResponse>) => {
  try {
    const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json(
      errorResponse('Требуется email и пароль', ErrorCodes.VALIDATION_ERROR)
    );

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json(
        errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
      );

    if (password.length < 6)
      return res.status(400).json(
        errorResponse('Пароль должен быть не менее 6 символов', ErrorCodes.VALIDATION_ERROR)
      );

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (!existingUser.isActive) {
        await sendVerificationCodeEmail(existingUser.id, email);
        return res.status(200).json(
          successResponse(null, 
            'Пользователь уже зарегистрирован, но не активирован. Код подтверждения отправлен повторно.')
        );
      }
      return res.status(409).json(
        errorResponse('Пользователь уже существует', ErrorCodes.CONFLICT)
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        isActive: false,
        role: { connect: { name: 'user' } },
      },
    });

    await sendVerificationCodeEmail(user.id, email);

    res.status(201).json(
      successResponse(null, 'Пользователь зарегистрирован. Пожалуйста, подтвердите email.')
    );
  } catch (error: any) {
    if (error.message && error.message.includes('recently')) {
      return res.status(429).json(
        errorResponse(error.message, ErrorCodes.TOO_MANY_REQUESTS)
      );
    }
    console.error('Ошибка регистрации:', error);
    res.status(500).json(
      errorResponse('Ошибка регистрации', ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined)
    );
  }
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Вход пользователя
 *     description: Возвращает access и refresh токены, а также профиль пользователя.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *             required: [email, password]
 *     responses:
 *       200:
 *         description: Успешный вход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Неверные учётные данные
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       403:
 *         description: Аккаунт не активирован/заблокирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/login', async (req: express.Request<{}, {}, AuthLoginRequest>, res: express.Response<AuthLoginResponse>) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json(
      errorResponse('Требуется email и пароль', ErrorCodes.VALIDATION_ERROR)
    );

  try {
    const user = (await prisma.user.findUnique({
      where: { email },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
        loginAttempts: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        clientProfile: true,
        supplierProfile: true,
        employeeProfile: true,
      },
    })) as UserWithRolePermissions | null;

    if (!user)
      return res.status(401).json(
        errorResponse('Неверные учетные данные', ErrorCodes.UNAUTHORIZED)
      );

    if (user.profileStatus === 'BLOCKED') {
      return res.status(403).json(
        errorResponse('Ваш аккаунт заблокирован. Обратитесь в поддержку.', ErrorCodes.FORBIDDEN)
      );
    }

    if (!user.isActive || user.profileStatus === 'PENDING') {
      return res.status(403).json(
        errorResponse('Аккаунт не активирован. Пожалуйста, подтвердите email.', ErrorCodes.FORBIDDEN)
      );
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      await prisma.loginAttempt.create({
        data: { userId: user.id, success: false, ip: req.ip },
      });

      const failedAttemptsCount = (user.loginAttempts ?? []).filter((a) => !a.success).length;

      if (failedAttemptsCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
        await prisma.user.update({
          where: { id: user.id },
          data: { profileStatus: 'BLOCKED' },
        });

        await prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'OTHER',
            targetType: 'USER',
            targetId: user.id,
            details: 'Автоматическая блокировка из-за множества неудачных попыток входа',
          },
        });

      return res.status(403).json(
        errorResponse('Слишком много неудачных попыток. Ваш аккаунт заблокирован.', ErrorCodes.FORBIDDEN)
      );
      }

      return res.status(401).json(
        errorResponse('Неверные учетные данные', ErrorCodes.UNAUTHORIZED)
      );
    }

    const profileType = user.currentProfileType;
    const hasAnyProfile =
      user.clientProfile !== null ||
      user.supplierProfile !== null ||
      user.employeeProfile !== null;

    let activeProfile = null;
    if (profileType === 'CLIENT') activeProfile = user.clientProfile;
    else if (profileType === 'SUPPLIER') activeProfile = user.supplierProfile;
    else if (profileType === 'EMPLOYEE') activeProfile = user.employeeProfile;

    if (activeProfile?.status === 'BLOCKED') {
      return res.status(403).json(
        errorResponse('Слишком много неудачных попыток. Ваш аккаунт заблокирован.', ErrorCodes.FORBIDDEN)
      );
    }

    const accessToken = generateAccessToken(user);
    // Создаём refresh токен и сохраняем сразу
    const refreshToken = await createUniqueRefreshToken(user.id);

    await prisma.loginAttempt.create({
      data: { userId: user.id, success: true, ip: req.ip },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        targetType: 'USER',
        targetId: user.id,
        details: 'Успешный вход в систему',
      },
    });

    const profileResponse = hasAnyProfile
      ? {
          clientProfile: user.clientProfile,
          supplierProfile: user.supplierProfile,
          employeeProfile: user.employeeProfile,
          currentProfileType: profileType ?? null,
          profileData: activeProfile ?? null,
        }
      : null;
    const resProfile = await getProfile(user.id);
    res.json(successResponse({
      accessToken,
      refreshToken,
      profile: resProfile,
      message: "Вход успешный"
    }));
    
  } catch (error) {
    console.error('Ошибка при входе:', error);
    res.status(500).json(
      errorResponse('Ошибка входа', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

/**
 * @openapi
 * /auth/token:
 *   post:
 *     tags: [Auth]
 *     summary: Обновление пары токенов по refresh токену
 *     description: Принимает действительный refresh токен, отзывает его и выдаёт новую пару access/refresh.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *             required: [refreshToken]
 *     responses:
 *       200:
 *         description: Новые токены выданы
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Не передан refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       403:
 *         description: Неверный/просроченный/отозванный refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/token', async (req: express.Request<{}, {}, AuthTokenRequest>, res: express.Response<AuthTokenResponse>) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json(
      errorResponse('Требуется refresh токен', ErrorCodes.VALIDATION_ERROR)
    );
  }

  console.log('Получен refreshToken:', refreshToken);

  try {
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });

    if (!storedToken) {
      console.error('Refresh токен не найден в БД');
      return res.status(403).json(
        errorResponse('Неверный refresh токен', ErrorCodes.UNAUTHORIZED)
      );
    }

    if (storedToken.revoked || storedToken.expiresAt < new Date()) {
      console.error('Refresh токен отозван или просрочен');
      return res.status(403).json(
        errorResponse('Неверный или просроченный refresh токен', ErrorCodes.UNAUTHORIZED)
      );
    }

    jwt.verify(refreshToken, refreshTokenSecret, async (err: VerifyErrors | null, payload: any) => {
      if (err || !payload?.userId) {
        console.error('Неверный refresh токен:', err?.message || 'payload.userId отсутствует');
        return res.status(403).json(
          errorResponse('Неверный refresh токен', ErrorCodes.UNAUTHORIZED)
        );
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
        },
      });

    if (!user) {
        console.error('Пользователь не найден');
        return res.status(403).json(
          errorResponse('Пользователь не найден', ErrorCodes.UNAUTHORIZED)
        );
      }

      const userWithRole = user as unknown as UserWithRolePermissions;
      const newAccessToken = generateAccessToken(userWithRole);

      try {
        // Отзываем старый токен и создаём новый
        await prisma.$transaction(async (tx) => {
          await tx.refreshToken.update({
            where: { id: storedToken.id },
            data: { revoked: true },
          });

          await createUniqueRefreshToken(user.id); // важное: сюда передаём ID
        });

        // Получаем только что созданный токен
        const newRefreshToken = await prisma.refreshToken.findFirst({
          where: { userId: user.id, revoked: false },
          orderBy: { createdAt: 'desc' },
        });

        if (!newRefreshToken) {
          throw new Error('Не удалось получить новый refresh токен после создания');
        }

    res.json(successResponse({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken.token
    }));
      } catch (e) {
        console.error('Ошибка создания нового refresh токена:', e);
        res.status(500).json(
          errorResponse('Ошибка обновления токенов', ErrorCodes.INTERNAL_ERROR)
        );
      }
    });
  } catch (error) {
    console.error('Ошибка при обновлении токена:', error);
    res.status(500).json(
      errorResponse('Обновление токена не удалось', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Выход и отзыв refresh токена
 *     description: Требуется bearer JWT. Отзывает указанный refresh токен пользователя.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *             required: [refreshToken]
 *     responses:
 *       200:
 *         description: Успешный выход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Не передан refresh токен
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/logout', authenticateToken, async (req: AuthRequest & { body: AuthLogoutRequest }, res: express.Response<AuthLogoutResponse>) => {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return res.status(400).json(
      errorResponse('Refresh token required', ErrorCodes.VALIDATION_ERROR)
    );

  try {
    await prisma.refreshToken.updateMany({
      where: { token: refreshToken, userId: req.user!.userId },
      data: { revoked: true },
    });
    res.json(successResponse({ message: 'Logged out successfully' }));
  } catch (error) {
    console.error('Ошибка logout:', error);
    res.status(500).json(
      errorResponse('Logout failed', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

/**
 * @openapi
 * /auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Подтверждение аккаунта кодом из email
 *     description: Активирует учётную запись и возвращает пару access/refresh токенов.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string }
 *             required: [email, code]
 *     responses:
 *       200:
 *         description: Успешное подтверждение и вход
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Неверный/просроченный код или уже активирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       404:
 *         description: Пользователь не найден
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Превышено число попыток подтверждения
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/verify', async (req: express.Request<{}, {}, AuthVerifyRequest>, res: express.Response<AuthVerifyResponse>) => {
  try {
    const { email, code } = req.body;
    if (!email || !code)
      return res.status(400).json(
        errorResponse('Требуется email и код', ErrorCodes.VALIDATION_ERROR)
      );

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json(
      errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
    );
    if (user.isActive) return res.status(400).json(
      errorResponse('Аккаунт уже активирован', ErrorCodes.VALIDATION_ERROR)
    );

    const verification = await prisma.emailVerification.findFirst({
      where: { userId: user.id, code, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!verification) {
      const lastVerification = await prisma.emailVerification.findFirst({
        where: { userId: user.id, used: false },
        orderBy: { createdAt: 'desc' },
      });
      if (lastVerification) {
        const newAttempts = (lastVerification.attemptsCount || 0) + 1;
        if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
          return res.status(429).json(
            errorResponse('Превышено максимальное количество попыток подтверждения', ErrorCodes.TOO_MANY_REQUESTS)
          );
        }
        await prisma.emailVerification.update({
          where: { id: lastVerification.id },
          data: { attemptsCount: newAttempts },
        });
      }
      return res.status(400).json(
        errorResponse('Неверный или просроченный код подтверждения', ErrorCodes.VALIDATION_ERROR)
      );
    }

    await prisma.emailVerification.update({
      where: { id: verification.id },
      data: { used: true },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: true,
        profileStatus: 'ACTIVE',
      },
    });

    const userWithRole = await prisma.user.findUnique({
      where: { id: user.id },
      include: { 
        role: { 
          include: { 
            permissions: { 
              include: { permission: true } 
            } 
          } 
        },
        clientProfile: true,
        supplierProfile: true,
        employeeProfile: true
      },
    }) as UserWithRolePermissions;

    if (!userWithRole) {
      console.error('Ошибка получения данных пользователя после верификации');
      return res.status(500).json(
        errorResponse('Ошибка получения данных пользователя', ErrorCodes.INTERNAL_ERROR)
      );
    }

    const accessToken = generateAccessToken(userWithRole as UserWithRolePermissions);
    const refreshToken = await createUniqueRefreshToken(userWithRole.id);

    res.json(successResponse({
      accessToken,
      refreshToken,
      message: 'Аккаунт подтвержден и активирован'
    }));
  } catch (error) {
    console.error('Ошибка подтверждения:', error);
    res.status(500).json(
      errorResponse('Ошибка подтверждения', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

export default router;
