import express from 'express';
import bcrypt from 'bcryptjs';
import jwt, { VerifyErrors } from 'jsonwebtoken';
import { User, Role, Permission } from '@prisma/client';
import prisma from '../prisma/client';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { sendVerificationEmail } from '../services/mailService';
import crypto, { randomUUID } from 'crypto';
import { successResponse, errorResponse, ErrorCodes } from '../utils/apiResponse';
import {
  getTelegramContactPhone,
  issueTelegramSessionToken,
  maskEmail,
  maskPhone,
  normalizePhoneE164,
  parseTelegramSessionToken,
  setTelegramContactPhone,
  verifyTelegramInitData,
} from '../services/telegramAuthService';
import {
  getMaxContactPhone,
  issueMaxSessionToken,
  parseMaxSessionToken,
  setMaxContactPhone,
  verifyMaxInitData,
} from '../services/maxAuthService';
import {
  bindMaxToPhoneVerificationByStartToken,
  bindTelegramToPhoneVerificationByStartToken,
  verifyPhoneByMaxContact,
  verifyPhoneByTelegramContact,
} from '../services/phoneVerificationService';
import {
  bindMessengerQrAuthSessionByStartToken,
  cancelMessengerQrAuthSessionByClientToken,
  consumeMessengerQrAuthSession,
  getLatestActiveMessengerQrAuthSessionByMessengerUser,
  getMessengerQrAuthSessionByClientToken,
  markLatestMessengerQrAuthSessionFailed,
  markLatestMessengerQrAuthSessionVerified,
  startMessengerQrAuthSession,
  type MessengerQrAuthProviderValue,
} from '../services/messengerQrAuthSessionService';
import { getAuthMethodDescriptors } from '../services/authMethodRegistry';
import {
  registerTelegramUpdateHandler,
  sendPhoneContactRequestMessage,
  sendTelegramInfoMessage,
  sendTelegramWelcomeMessage,
} from '../services/telegramBotService';
import {
  registerMaxUpdateHandler,
  sendMaxInfoMessage,
  sendMaxPhoneContactRequestMessage,
  sendMaxWelcomeMessage,
} from '../services/maxBotService';
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
import { normalizePhoneToBigInt, toApiPhoneString } from '../utils/phone';

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


const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || 'yourrefreshtokensecret';
// временно уменьшенный TTL для access-токена (2 минуты) для отладки фона
const accessTokenLife = '30m';
const refreshTokenLife = '14d';
const MAX_FAILED_LOGIN_ATTEMPTS = 19;
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESEND_CODE_INTERVAL_MS = 25 * 1000; // 25 секунд
const VERIFICATION_CODE_EXPIRATION_MS = 60 * 60 * 1000; // 1 час
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const MAX_WEBHOOK_SECRET = process.env.MAX_WEBHOOK_SECRET || '';
const TELEGRAM_RATE_LIMIT = rateLimit({ windowSec: 60, limit: 60 });
const MAX_RATE_LIMIT = rateLimit({ windowSec: 60, limit: 60 });

type TelegramState = 'AUTHORIZED' | 'NEED_PHONE' | 'NEED_LINK' | 'READY';

type TelegramResolveResult = {
  state: TelegramState;
  userId?: number;
  conflictUserHint?: { maskedEmail: string | null; maskedPhone: string | null };
};

type MaxState = 'AUTHORIZED' | 'NEED_PHONE' | 'NEED_LINK' | 'READY';
type MaxResolveResult = {
  state: MaxState;
  userId?: number;
  conflictUserHint?: { maskedEmail: string | null; maskedPhone: string | null };
};

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

type TelegramSessionInfo = {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type MaxSessionInfo = {
  maxId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type QrAuthPublicState =
  | 'PENDING'
  | 'AWAITING_CONTACT'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'CONSUMED';

function tgLog(stage: string, payload?: Record<string, any>) {
  if (process.env.NODE_ENV === 'production') return;
  if (payload) console.log('[tg-auth]', stage, payload);
  else console.log('[tg-auth]', stage);
}

function maxLog(stage: string, payload?: Record<string, any>) {
  if (process.env.NODE_ENV === 'production') return;
  if (payload) console.log('[max-auth]', stage, payload);
  else console.log('[max-auth]', stage);
}

function isQrConfigError(message: string) {
  return (
    /TELEGRAM_QR_AUTH_NOT_CONFIGURED/i.test(message) ||
    /MAX_QR_AUTH_NOT_CONFIGURED/i.test(message)
  );
}

function isQrDeepLinkError(message: string) {
  return (
    /TELEGRAM_QR_DEEP_LINK_UNAVAILABLE/i.test(message) ||
    /MAX_QR_DEEP_LINK_UNAVAILABLE/i.test(message)
  );
}

function mapQrSessionState(status: string): Exclude<QrAuthPublicState, 'AUTHORIZED'> {
  if (status === 'AWAITING_CONTACT') return 'AWAITING_CONTACT';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'CONSUMED') return 'CONSUMED';
  return 'PENDING';
}

function parseTelegramQrStartTokenFromPayload(payloadRaw: string) {
  const payload = String(payloadRaw || '').trim();
  if (!payload.startsWith('auth_qr_')) return '';
  return payload.slice('auth_qr_'.length);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return EMAIL_REGEX.test(email);
}

function toTelegramBigInt(telegramId: string) {
  try {
    return BigInt(String(telegramId));
  } catch {
    throw new Error('Invalid telegramId');
  }
}

function toMaxBigInt(maxId: string) {
  try {
    return BigInt(String(maxId));
  } catch {
    throw new Error('Invalid maxId');
  }
}

function resolveAuthProviderAfterMessengerAttach(
  current: 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID'
): 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID' {
  switch (current) {
    case 'LOCAL':
    case 'TELEGRAM':
    case 'MAX':
    case 'HYBRID':
    default:
      return 'HYBRID';
  }
}

async function loadUserWithRolePermissions(userId: number): Promise<UserWithRolePermissions | null> {
  return (await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      clientProfile: true,
      supplierProfile: true,
      employeeProfile: true,
    },
  })) as UserWithRolePermissions | null;
}

async function resolveTelegramUserState(
  session: TelegramSessionInfo,
  phoneDigits11?: string | null
): Promise<TelegramResolveResult> {
  const telegramId = toTelegramBigInt(session.telegramId);
  const normalizedPhone = phoneDigits11 ? normalizePhoneToBigInt(phoneDigits11) : null;
  const userByTelegram = await prisma.user.findFirst({
    where: { telegramId },
    select: { id: true, phone: true, telegramUsername: true },
  });

  if (userByTelegram) {
    tgLog('linked_user_found', { userId: userByTelegram.id, telegramId: session.telegramId });
    const updateData: Record<string, any> = {};
    if (session.username !== userByTelegram.telegramUsername) {
      updateData.telegramUsername = session.username;
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({ where: { id: userByTelegram.id }, data: updateData });
    }

    if (!userByTelegram.phone && normalizedPhone) {
      const phoneOwner = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
        select: { id: true },
      });
      if (!phoneOwner || phoneOwner.id === userByTelegram.id) {
        await prisma.user.update({
          where: { id: userByTelegram.id },
          data: { phone: normalizedPhone, phoneVerifiedAt: new Date() },
        });
      } else {
        tgLog('phone_conflict_ignored_for_linked_user', {
          telegramUserId: userByTelegram.id,
          phoneOwnerId: phoneOwner.id,
        });
      }
    }

    return { state: 'READY', userId: userByTelegram.id };
  }

  if (!normalizedPhone) {
    tgLog('phone_missing', { telegramId: session.telegramId });
    return { state: 'NEED_PHONE' };
  }

  const userByPhone = await prisma.user.findFirst({
    where: { phone: normalizedPhone },
    select: { id: true, email: true, phone: true, telegramId: true, authProvider: true },
  });

  if (userByPhone) {
    if (!userByPhone.telegramId || userByPhone.telegramId === telegramId) {
      const nextProvider = resolveAuthProviderAfterMessengerAttach(
        userByPhone.authProvider as 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID'
      );
      await prisma.user.update({
        where: { id: userByPhone.id },
        data: {
          telegramId,
          telegramUsername: session.username,
          telegramLinkedAt: new Date(),
          phoneVerifiedAt: new Date(),
          authProvider: nextProvider,
        },
      });
      tgLog('auto_linked_by_phone', { telegramId: session.telegramId, userId: userByPhone.id });
      return { state: 'READY', userId: userByPhone.id };
    }

    tgLog('need_link_by_phone', { telegramId: session.telegramId, phoneOwnerId: userByPhone.id });
    return {
      state: 'NEED_LINK',
      conflictUserHint: {
        maskedEmail: maskEmail(userByPhone.email),
        maskedPhone: maskPhone(toApiPhoneString(userByPhone.phone)),
      },
    };
  }

  const created = await prisma.user.create({
    data: {
      email: null,
      passwordHash: null,
      isActive: true,
      role: { connect: { name: 'user' } },
      firstName: session.firstName ?? undefined,
      lastName: session.lastName ?? undefined,
      phone: normalizedPhone,
      phoneVerifiedAt: new Date(),
      telegramId,
      telegramUsername: session.username,
      telegramLinkedAt: new Date(),
      authProvider: 'TELEGRAM',
      profileStatus: 'ACTIVE',
      currentProfileType: null,
    },
    select: { id: true },
  });
  tgLog('created_telegram_user', { userId: created.id, telegramId: session.telegramId });

  return { state: 'READY', userId: created.id };
}

async function resolveMaxUserState(
  session: MaxSessionInfo,
  phoneDigits11?: string | null
): Promise<MaxResolveResult> {
  const maxId = toMaxBigInt(session.maxId);
  const normalizedPhone = phoneDigits11 ? normalizePhoneToBigInt(phoneDigits11) : null;
  const userByMax = await prisma.user.findFirst({
    where: { maxId },
    select: { id: true, phone: true, maxUsername: true },
  });

  if (userByMax) {
    maxLog('linked_user_found', { userId: userByMax.id, maxId: session.maxId });
    const updateData: Record<string, any> = {};
    if (session.username !== userByMax.maxUsername) {
      updateData.maxUsername = session.username;
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({ where: { id: userByMax.id }, data: updateData });
    }

    if (!userByMax.phone && normalizedPhone) {
      const phoneOwner = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
        select: { id: true },
      });
      if (!phoneOwner || phoneOwner.id === userByMax.id) {
        await prisma.user.update({
          where: { id: userByMax.id },
          data: { phone: normalizedPhone, phoneVerifiedAt: new Date() },
        });
      } else {
        maxLog('phone_conflict_ignored_for_linked_user', {
          maxUserId: userByMax.id,
          phoneOwnerId: phoneOwner.id,
        });
      }
    }

    return { state: 'READY', userId: userByMax.id };
  }

  if (!normalizedPhone) {
    maxLog('phone_missing', { maxId: session.maxId });
    return { state: 'NEED_PHONE' };
  }

  const userByPhone = await prisma.user.findFirst({
    where: { phone: normalizedPhone },
    select: { id: true, email: true, phone: true, maxId: true, authProvider: true },
  });

  if (userByPhone) {
    if (!userByPhone.maxId || userByPhone.maxId === maxId) {
      const nextProvider = resolveAuthProviderAfterMessengerAttach(
        userByPhone.authProvider as 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID'
      );
      await prisma.user.update({
        where: { id: userByPhone.id },
        data: {
          maxId,
          maxUsername: session.username,
          maxLinkedAt: new Date(),
          phoneVerifiedAt: new Date(),
          authProvider: nextProvider,
        },
      });
      maxLog('auto_linked_by_phone', { maxId: session.maxId, userId: userByPhone.id });
      return { state: 'READY', userId: userByPhone.id };
    }

    maxLog('need_link_by_phone', { maxId: session.maxId, phoneOwnerId: userByPhone.id });
    return {
      state: 'NEED_LINK',
      conflictUserHint: {
        maskedEmail: maskEmail(userByPhone.email),
        maskedPhone: maskPhone(toApiPhoneString(userByPhone.phone)),
      },
    };
  }

  const created = await prisma.user.create({
    data: {
      email: null,
      passwordHash: null,
      isActive: true,
      role: { connect: { name: 'user' } },
      firstName: session.firstName ?? undefined,
      lastName: session.lastName ?? undefined,
      phone: normalizedPhone,
      phoneVerifiedAt: new Date(),
      maxId,
      maxUsername: session.username,
      maxLinkedAt: new Date(),
      authProvider: 'MAX',
      profileStatus: 'ACTIVE',
      currentProfileType: null,
    },
    select: { id: true },
  });
  maxLog('created_max_user', { userId: created.id, maxId: session.maxId });

  return { state: 'READY', userId: created.id };
}

async function issueAuthTokensForUser(userId: number) {
  const user = await loadUserWithRolePermissions(userId);
  if (!user) {
    throw new Error('Пользователь не найден');
  }
  const accessToken = generateAccessToken(user);
  const refreshToken = await createUniqueRefreshToken(user.id);
  const profile = await getProfile(user.id);
  return { accessToken, refreshToken, profile };
}

function parseTelegramSession(tgSessionToken: string): TelegramSessionInfo {
  const parsed = parseTelegramSessionToken(tgSessionToken);
  return {
    telegramId: String(parsed.telegramId),
    username: parsed.username ?? null,
    firstName: parsed.firstName ?? null,
    lastName: parsed.lastName ?? null,
  };
}

function parseMaxSession(maxSessionToken: string): MaxSessionInfo {
  const parsed = parseMaxSessionToken(maxSessionToken);
  return {
    maxId: String(parsed.maxId),
    username: parsed.username ?? null,
    firstName: parsed.firstName ?? null,
    lastName: parsed.lastName ?? null,
  };
}

function qrProviderLabel(provider: MessengerQrAuthProviderValue) {
  return provider === 'MAX' ? 'MAX' : 'Telegram';
}

function qrConflictMessage(provider: MessengerQrAuthProviderValue) {
  return `Этот ${qrProviderLabel(provider)}-аккаунт связан с другим профилем. Войдите по email/паролю и привяжите ${qrProviderLabel(provider)} в профиле.`;
}

function qrGenericFailureMessage(provider: MessengerQrAuthProviderValue) {
  return `Не удалось подтвердить вход через ${qrProviderLabel(provider)}. Повторите попытку.`;
}

async function resolveTelegramQrSessionByContact(params: {
  telegramUserId: string;
  chatId?: string | null;
  username?: string | null;
  phoneRaw: string;
}) {
  const active = await getLatestActiveMessengerQrAuthSessionByMessengerUser({
    provider: 'TELEGRAM',
    messengerUserId: params.telegramUserId,
  });
  if (!active) {
    return { handled: false as const };
  }

  const normalizedPhone = normalizePhoneE164(params.phoneRaw);
  if (!normalizedPhone) {
    await markLatestMessengerQrAuthSessionFailed({
      provider: 'TELEGRAM',
      messengerUserId: params.telegramUserId,
      messengerUsername: params.username || null,
      failureReason: 'INVALID_PHONE',
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'INVALID_PHONE' };
  }

  try {
    const resolved = await resolveTelegramUserState(
      {
        telegramId: params.telegramUserId,
        username: params.username ?? null,
        firstName: null,
        lastName: null,
      },
      normalizedPhone
    );

    if (resolved.state === 'READY' && resolved.userId) {
      await markLatestMessengerQrAuthSessionVerified({
        provider: 'TELEGRAM',
        messengerUserId: params.telegramUserId,
        resolvedUserId: resolved.userId,
        messengerUsername: params.username ?? null,
      });
      return { handled: true as const, state: 'VERIFIED' as const };
    }

    if (resolved.state === 'NEED_LINK') {
      await markLatestMessengerQrAuthSessionFailed({
        provider: 'TELEGRAM',
        messengerUserId: params.telegramUserId,
        messengerUsername: params.username || null,
        failureReason: 'ACCOUNT_CONFLICT',
      });
      return { handled: true as const, state: 'FAILED' as const, failureReason: 'ACCOUNT_CONFLICT' };
    }

    await markLatestMessengerQrAuthSessionFailed({
      provider: 'TELEGRAM',
      messengerUserId: params.telegramUserId,
      messengerUsername: params.username || null,
      failureReason: 'USER_RESOLVE_FAILED',
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'USER_RESOLVE_FAILED' };
  } catch (error: any) {
    await markLatestMessengerQrAuthSessionFailed({
      provider: 'TELEGRAM',
      messengerUserId: params.telegramUserId,
      messengerUsername: params.username || null,
      failureReason: 'USER_RESOLVE_FAILED',
    });
    tgLog('qr_contact_resolve_failed', {
      telegramUserId: params.telegramUserId,
      message: String(error?.message || error),
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'USER_RESOLVE_FAILED' };
  }
}

async function resolveMaxQrSessionByContact(params: {
  maxUserId: string;
  chatId?: string | null;
  username?: string | null;
  phoneRaw: string;
}) {
  const active = await getLatestActiveMessengerQrAuthSessionByMessengerUser({
    provider: 'MAX',
    messengerUserId: params.maxUserId,
  });
  if (!active) {
    return { handled: false as const };
  }

  const normalizedPhone = normalizePhoneE164(params.phoneRaw);
  if (!normalizedPhone) {
    await markLatestMessengerQrAuthSessionFailed({
      provider: 'MAX',
      messengerUserId: params.maxUserId,
      messengerUsername: params.username || null,
      failureReason: 'INVALID_PHONE',
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'INVALID_PHONE' };
  }

  try {
    const resolved = await resolveMaxUserState(
      {
        maxId: params.maxUserId,
        username: params.username ?? null,
        firstName: null,
        lastName: null,
      },
      normalizedPhone
    );

    if (resolved.state === 'READY' && resolved.userId) {
      await markLatestMessengerQrAuthSessionVerified({
        provider: 'MAX',
        messengerUserId: params.maxUserId,
        resolvedUserId: resolved.userId,
        messengerUsername: params.username ?? null,
      });
      return { handled: true as const, state: 'VERIFIED' as const };
    }

    if (resolved.state === 'NEED_LINK') {
      await markLatestMessengerQrAuthSessionFailed({
        provider: 'MAX',
        messengerUserId: params.maxUserId,
        messengerUsername: params.username || null,
        failureReason: 'ACCOUNT_CONFLICT',
      });
      return { handled: true as const, state: 'FAILED' as const, failureReason: 'ACCOUNT_CONFLICT' };
    }

    await markLatestMessengerQrAuthSessionFailed({
      provider: 'MAX',
      messengerUserId: params.maxUserId,
      messengerUsername: params.username || null,
      failureReason: 'USER_RESOLVE_FAILED',
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'USER_RESOLVE_FAILED' };
  } catch (error: any) {
    await markLatestMessengerQrAuthSessionFailed({
      provider: 'MAX',
      messengerUserId: params.maxUserId,
      messengerUsername: params.username || null,
      failureReason: 'USER_RESOLVE_FAILED',
    });
    maxLog('qr_contact_resolve_failed', {
      maxUserId: params.maxUserId,
      message: String(error?.message || error),
    });
    return { handled: true as const, state: 'FAILED' as const, failureReason: 'USER_RESOLVE_FAILED' };
  }
}

async function handleQrAuthStatus(
  provider: MessengerQrAuthProviderValue,
  sessionToken: string,
  res: express.Response
) {
  const session = await getMessengerQrAuthSessionByClientToken(provider, sessionToken);
  if (!session) {
    return res.status(404).json(
      errorResponse('QR-сессия не найдена', ErrorCodes.NOT_FOUND)
    );
  }

  if (session.status === 'VERIFIED') {
    if (!session.resolvedUserId) {
      return res.status(401).json(
        errorResponse('Пользователь не определён для QR-сессии', ErrorCodes.UNAUTHORIZED)
      );
    }

    const authPayload = await issueAuthTokensForUser(session.resolvedUserId);
    await consumeMessengerQrAuthSession(session.id).catch(() => undefined);

    return res.json(
      successResponse({
        provider,
        state: 'AUTHORIZED',
        accessToken: authPayload.accessToken,
        refreshToken: authPayload.refreshToken,
        profile: authPayload.profile,
        message: `Вход через ${qrProviderLabel(provider)} успешен`,
      })
    );
  }

  return res.json(
    successResponse({
      provider,
      state: mapQrSessionState(session.status),
      failureReason: session.failureReason ?? null,
      message: undefined,
    })
  );
}

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
    if (existingVerification.attemptsCount >= MAX_VERIFICATION_ATTEMPTS) {
      await prisma.emailVerification.update({
        where: { id: existingVerification.id },
        data: { used: true },
      });
    } else if (existingVerification.expiresAt <= now) {
      await prisma.emailVerification.update({
        where: { id: existingVerification.id },
        data: { used: true },
      });
    } else {
      if (
        existingVerification.lastSentAt &&
        now.getTime() - existingVerification.lastSentAt.getTime() < RESEND_CODE_INTERVAL_MS
      ) {
        throw new Error(
          'Код уже был отправлен недавно. Пожалуйста, подождите перед повторным запросом.'
        );
      }
      await prisma.emailVerification.update({
        where: { id: existingVerification.id },
        data: {
          lastSentAt: now,
          expiresAt: new Date(now.getTime() + VERIFICATION_CODE_EXPIRATION_MS),
        },
      });
      await sendVerificationEmail(email, existingVerification.code, 'verification');
      return;
    }
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
  await sendVerificationEmail(email, code, 'verification');
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
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json(
        errorResponse('Требуется email и пароль', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json(
        errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (password.length < 6)
      return res.status(400).json(
        errorResponse('Пароль должен быть не менее 6 символов', ErrorCodes.VALIDATION_ERROR)
      );

    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (existingUser) {
      if (!existingUser.isActive) {
        if (!existingUser.email) {
          return res.status(409).json(
            errorResponse('Аккаунт зарегистрирован через Telegram. Войдите через Telegram.', ErrorCodes.CONFLICT)
          );
        }
        await sendVerificationCodeEmail(existingUser.id, existingUser.email);
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
        email: normalizedEmail,
        passwordHash,
        isActive: false,
        role: { connect: { name: 'user' } },
        firstName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      },
    });

    await sendVerificationCodeEmail(user.id, normalizedEmail);

    res.status(201).json(
      successResponse(null, 'Пользователь зарегистрирован. Пожалуйста, подтвердите email.')
    );
  } catch (error: any) {
    if (error.message && /recently|недавно/i.test(error.message)) {
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
 * /auth/resend:
 *   post:
 *     tags: [Auth]
 *     summary: Повторная отправка кода подтверждения
 *     description: Отправляет новый код подтверждения, если аккаунт ещё не активирован.
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
 *         description: Код отправлен повторно
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiSuccess' }
 *       400:
 *         description: Ошибка валидации или аккаунт уже активирован
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       429:
 *         description: Слишком частые запросы
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ApiError' }
 *       500:
 *         description: Внутренняя ошибка
 */
router.post('/resend', async (req: express.Request, res: express.Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) {
      return res.status(400).json(
        errorResponse('Требуется email', ErrorCodes.VALIDATION_ERROR)
      );
    }
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json(
        errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });
    if (!user) {
      return res.json(
        successResponse(null, 'Если аккаунт существует, код подтверждения отправлен.')
      );
    }
    if (user.isActive) {
      return res.status(400).json(
        errorResponse('Аккаунт уже активирован', ErrorCodes.VALIDATION_ERROR)
      );
    }
    if (!user.email) {
      return res.status(400).json(
        errorResponse('Для Telegram-аккаунта email не задан', ErrorCodes.VALIDATION_ERROR)
      );
    }

    await sendVerificationCodeEmail(user.id, normalizedEmail);
    return res.json(
      successResponse(null, 'Код подтверждения отправлен повторно.')
    );
  } catch (error: any) {
    if (error.message && /recently|недавно/i.test(error.message)) {
      return res.status(429).json(
        errorResponse(error.message, ErrorCodes.TOO_MANY_REQUESTS)
      );
    }
    console.error('Ошибка повторной отправки кода:', error);
    return res.status(500).json(
      errorResponse('Ошибка отправки кода подтверждения', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

router.get('/methods', async (_req: express.Request, res: express.Response) => {
  return res.json(successResponse({ methods: getAuthMethodDescriptors() }));
});

router.post('/telegram/qr/start', TELEGRAM_RATE_LIMIT, async (_req: express.Request, res: express.Response) => {
  try {
    const started = await startMessengerQrAuthSession('TELEGRAM');
    return res.json(successResponse(started));
  } catch (error: any) {
    const message = String(error?.message || 'Не удалось запустить QR-вход через Telegram');
    if (isQrConfigError(message) || isQrDeepLinkError(message)) {
      return res.status(503).json(
        errorResponse(
          'QR-вход через Telegram временно недоступен. Проверьте настройки TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME.',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
    return res.status(500).json(errorResponse(message, ErrorCodes.INTERNAL_ERROR));
  }
});

router.get('/telegram/qr/status', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const sessionToken = String((req.query?.sessionToken as string) || '').trim();
    if (!sessionToken) {
      return res.status(400).json(errorResponse('Требуется sessionToken', ErrorCodes.VALIDATION_ERROR));
    }
    return await handleQrAuthStatus('TELEGRAM', sessionToken, res);
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось проверить QR-сессию Telegram', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/telegram/qr/cancel', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const sessionToken = String(req.body?.sessionToken || '').trim();
    if (!sessionToken) {
      return res.status(400).json(errorResponse('Требуется sessionToken', ErrorCodes.VALIDATION_ERROR));
    }
    const result = await cancelMessengerQrAuthSessionByClientToken('TELEGRAM', sessionToken);
    if (!result.session) {
      return res.status(404).json(errorResponse('QR-сессия не найдена', ErrorCodes.NOT_FOUND));
    }
    return res.json(successResponse({ cancelled: result.cancelled }));
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось отменить QR-сессию Telegram', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/max/qr/start', MAX_RATE_LIMIT, async (_req: express.Request, res: express.Response) => {
  try {
    const started = await startMessengerQrAuthSession('MAX');
    return res.json(successResponse(started));
  } catch (error: any) {
    const message = String(error?.message || 'Не удалось запустить QR-вход через MAX');
    if (isQrConfigError(message) || isQrDeepLinkError(message)) {
      return res.status(503).json(
        errorResponse(
          'QR-вход через MAX временно недоступен. Проверьте настройки MAX_BOT_TOKEN и MAX_BOT_USERNAME.',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
    return res.status(500).json(errorResponse(message, ErrorCodes.INTERNAL_ERROR));
  }
});

router.get('/max/qr/status', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const sessionToken = String((req.query?.sessionToken as string) || '').trim();
    if (!sessionToken) {
      return res.status(400).json(errorResponse('Требуется sessionToken', ErrorCodes.VALIDATION_ERROR));
    }
    return await handleQrAuthStatus('MAX', sessionToken, res);
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось проверить QR-сессию MAX', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/max/qr/cancel', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const sessionToken = String(req.body?.sessionToken || '').trim();
    if (!sessionToken) {
      return res.status(400).json(errorResponse('Требуется sessionToken', ErrorCodes.VALIDATION_ERROR));
    }
    const result = await cancelMessengerQrAuthSessionByClientToken('MAX', sessionToken);
    if (!result.session) {
      return res.status(404).json(errorResponse('QR-сессия не найдена', ErrorCodes.NOT_FOUND));
    }
    return res.json(successResponse({ cancelled: result.cancelled }));
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось отменить QR-сессию MAX', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/telegram/init', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { initDataRaw } = req.body as { initDataRaw?: string };
    if (!initDataRaw || typeof initDataRaw !== 'string') {
      return res.status(400).json(
        errorResponse('Требуется initDataRaw', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const telegramUser = verifyTelegramInitData(initDataRaw);
    const tgSessionToken = issueTelegramSessionToken(telegramUser);
    const phoneFromBot = await getTelegramContactPhone(telegramUser.id);
    const resolved = await resolveTelegramUserState(
      {
        telegramId: telegramUser.id,
        username: telegramUser.username,
        firstName: telegramUser.firstName,
        lastName: telegramUser.lastName,
      },
      phoneFromBot
    );

    return res.json(
      successResponse({
        tgSessionToken,
        telegramUser: {
          id: telegramUser.id,
          username: telegramUser.username,
          firstName: telegramUser.firstName,
          lastName: telegramUser.lastName,
        },
        state: resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(
        error?.message || 'Не удалось проверить Telegram initData',
        ErrorCodes.UNAUTHORIZED
      )
    );
  }
});

router.post('/telegram/contact', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { tgSessionToken, phoneE164 } = req.body as { tgSessionToken?: string; phoneE164?: string };
    if (!tgSessionToken || !phoneE164) {
      return res.status(400).json(
        errorResponse('Требуются tgSessionToken и phoneE164', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseTelegramSession(tgSessionToken);
    const normalizedPhone = normalizePhoneE164(phoneE164);
    if (!normalizedPhone) {
      return res.status(400).json(
        errorResponse('Некорректный формат телефона', ErrorCodes.VALIDATION_ERROR)
      );
    }

    await setTelegramContactPhone(session.telegramId, normalizedPhone);
    const resolved = await resolveTelegramUserState(session, normalizedPhone);

    return res.json(
      successResponse({
        state: resolved.state === 'AUTHORIZED' ? 'NEED_PHONE' : resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось сохранить контакт', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.get('/telegram/contact-status', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const tgSessionToken = String((req.query?.tgSessionToken as string) || '').trim();
    if (!tgSessionToken) {
      return res.status(400).json(
        errorResponse('Требуется tgSessionToken', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseTelegramSession(tgSessionToken);
    const phoneFromBot = await getTelegramContactPhone(session.telegramId);
    const resolved = await resolveTelegramUserState(session, phoneFromBot);

    return res.json(
      successResponse({
        state: resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось проверить статус контакта', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/telegram/sign-in', TELEGRAM_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { tgSessionToken } = req.body as { tgSessionToken?: string };
    if (!tgSessionToken) {
      return res.status(400).json(
        errorResponse('Требуется tgSessionToken', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseTelegramSession(tgSessionToken);
    const telegramId = toTelegramBigInt(session.telegramId);
    const linkedUser = await prisma.user.findFirst({
      where: { telegramId },
      select: { id: true, profileStatus: true, telegramUsername: true },
    });

    if (!linkedUser) {
      return res.status(404).json(
        errorResponse('Telegram аккаунт не привязан', ErrorCodes.NOT_FOUND)
      );
    }

    if (linkedUser.profileStatus === 'BLOCKED') {
      return res.status(403).json(
        errorResponse('Ваш аккаунт заблокирован. Обратитесь в поддержку.', ErrorCodes.FORBIDDEN)
      );
    }

    if (session.username !== linkedUser.telegramUsername) {
      await prisma.user.update({
        where: { id: linkedUser.id },
        data: { telegramUsername: session.username },
      });
    }

    const authPayload = await issueAuthTokensForUser(linkedUser.id);
    return res.json(successResponse({ ...authPayload, message: 'Вход через Telegram успешен' }));
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось выполнить вход через Telegram', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post(
  '/telegram/link',
  TELEGRAM_RATE_LIMIT,
  authenticateToken,
  async (req: AuthRequest<{}, {}, { tgSessionToken?: string }>, res: express.Response) => {
    try {
      const userId = req.user?.userId;
      const tgSessionToken = String(req.body?.tgSessionToken || '').trim();
      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }
      if (!tgSessionToken) {
        return res.status(400).json(
          errorResponse('Требуется tgSessionToken', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const session = parseTelegramSession(tgSessionToken);
      const telegramId = toTelegramBigInt(session.telegramId);

      const owner = await prisma.user.findFirst({
        where: { telegramId },
        select: { id: true },
      });
      if (owner && owner.id !== Number(userId)) {
        return res.status(409).json(
          errorResponse('Этот Telegram аккаунт уже привязан к другому пользователю', ErrorCodes.CONFLICT)
        );
      }

      const current = await prisma.user.findUnique({
        where: { id: Number(userId) },
        select: { authProvider: true },
      });
      if (!current) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const nextProvider = resolveAuthProviderAfterMessengerAttach(
        current.authProvider as 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID'
      );

      await prisma.user.update({
        where: { id: Number(userId) },
        data: {
          telegramId,
          telegramUsername: session.username,
          telegramLinkedAt: new Date(),
          authProvider: nextProvider,
        },
      });

      const profile = await getProfile(Number(userId));
      return res.json(successResponse({ profile }, 'Telegram аккаунт успешно привязан'));
    } catch (error: any) {
      return res.status(401).json(
        errorResponse(error?.message || 'Не удалось привязать Telegram аккаунт', ErrorCodes.UNAUTHORIZED)
      );
    }
  }
);

router.post('/max/init', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { initDataRaw } = req.body as { initDataRaw?: string };
    if (!initDataRaw || typeof initDataRaw !== 'string') {
      return res.status(400).json(
        errorResponse('Требуется initDataRaw', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const maxUser = verifyMaxInitData(initDataRaw);
    const maxSessionToken = issueMaxSessionToken(maxUser);
    const phoneFromBot = await getMaxContactPhone(maxUser.id);
    const resolved = await resolveMaxUserState(
      {
        maxId: maxUser.id,
        username: maxUser.username,
        firstName: maxUser.firstName,
        lastName: maxUser.lastName,
      },
      phoneFromBot
    );

    return res.json(
      successResponse({
        maxSessionToken,
        maxUser: {
          id: maxUser.id,
          username: maxUser.username,
          firstName: maxUser.firstName,
          lastName: maxUser.lastName,
        },
        state: resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(
        error?.message || 'Не удалось проверить MAX initData',
        ErrorCodes.UNAUTHORIZED
      )
    );
  }
});

router.post('/max/contact', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { maxSessionToken, phoneE164 } = req.body as { maxSessionToken?: string; phoneE164?: string };
    if (!maxSessionToken || !phoneE164) {
      return res.status(400).json(
        errorResponse('Требуются maxSessionToken и phoneE164', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseMaxSession(maxSessionToken);
    const normalizedPhone = normalizePhoneE164(phoneE164);
    if (!normalizedPhone) {
      return res.status(400).json(
        errorResponse('Некорректный формат телефона', ErrorCodes.VALIDATION_ERROR)
      );
    }

    await setMaxContactPhone(session.maxId, normalizedPhone);
    const resolved = await resolveMaxUserState(session, normalizedPhone);

    return res.json(
      successResponse({
        state: resolved.state === 'AUTHORIZED' ? 'NEED_PHONE' : resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось сохранить контакт', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.get('/max/contact-status', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const maxSessionToken = String((req.query?.maxSessionToken as string) || '').trim();
    if (!maxSessionToken) {
      return res.status(400).json(
        errorResponse('Требуется maxSessionToken', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseMaxSession(maxSessionToken);
    const phoneFromBot = await getMaxContactPhone(session.maxId);
    const resolved = await resolveMaxUserState(session, phoneFromBot);

    return res.json(
      successResponse({
        state: resolved.state,
        conflictUserHint: resolved.conflictUserHint ?? null,
      })
    );
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось проверить статус контакта', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post('/max/sign-in', MAX_RATE_LIMIT, async (req: express.Request, res: express.Response) => {
  try {
    const { maxSessionToken } = req.body as { maxSessionToken?: string };
    if (!maxSessionToken) {
      return res.status(400).json(
        errorResponse('Требуется maxSessionToken', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const session = parseMaxSession(maxSessionToken);
    const maxId = toMaxBigInt(session.maxId);
    const linkedUser = await prisma.user.findFirst({
      where: { maxId },
      select: { id: true, profileStatus: true, maxUsername: true },
    });

    if (!linkedUser) {
      return res.status(404).json(
        errorResponse('MAX аккаунт не привязан', ErrorCodes.NOT_FOUND)
      );
    }

    if (linkedUser.profileStatus === 'BLOCKED') {
      return res.status(403).json(
        errorResponse('Ваш аккаунт заблокирован. Обратитесь в поддержку.', ErrorCodes.FORBIDDEN)
      );
    }

    if (session.username !== linkedUser.maxUsername) {
      await prisma.user.update({
        where: { id: linkedUser.id },
        data: { maxUsername: session.username },
      });
    }

    const authPayload = await issueAuthTokensForUser(linkedUser.id);
    return res.json(successResponse({ ...authPayload, message: 'Вход через MAX успешен' }));
  } catch (error: any) {
    return res.status(401).json(
      errorResponse(error?.message || 'Не удалось выполнить вход через MAX', ErrorCodes.UNAUTHORIZED)
    );
  }
});

router.post(
  '/max/link',
  MAX_RATE_LIMIT,
  authenticateToken,
  async (req: AuthRequest<{}, {}, { maxSessionToken?: string }>, res: express.Response) => {
    try {
      const userId = req.user?.userId;
      const maxSessionToken = String(req.body?.maxSessionToken || '').trim();
      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }
      if (!maxSessionToken) {
        return res.status(400).json(
          errorResponse('Требуется maxSessionToken', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const session = parseMaxSession(maxSessionToken);
      const maxId = toMaxBigInt(session.maxId);

      const owner = await prisma.user.findFirst({
        where: { maxId },
        select: { id: true },
      });
      if (owner && owner.id !== Number(userId)) {
        return res.status(409).json(
          errorResponse('Этот MAX аккаунт уже привязан к другому пользователю', ErrorCodes.CONFLICT)
        );
      }

      const current = await prisma.user.findUnique({
        where: { id: Number(userId) },
        select: { authProvider: true },
      });
      if (!current) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      const nextProvider = resolveAuthProviderAfterMessengerAttach(
        current.authProvider as 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID'
      );

      await prisma.user.update({
        where: { id: Number(userId) },
        data: {
          maxId,
          maxUsername: session.username,
          maxLinkedAt: new Date(),
          authProvider: nextProvider,
        },
      });

      const profile = await getProfile(Number(userId));
      return res.json(successResponse({ profile }, 'MAX аккаунт успешно привязан'));
    } catch (error: any) {
      return res.status(401).json(
        errorResponse(error?.message || 'Не удалось привязать MAX аккаунт', ErrorCodes.UNAUTHORIZED)
      );
    }
  }
);

router.post(
  '/credentials',
  TELEGRAM_RATE_LIMIT,
  authenticateToken,
  async (
    req: AuthRequest<{}, {}, { email?: string; password?: string }>,
    res: express.Response
  ) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json(errorResponse('Не авторизован', ErrorCodes.UNAUTHORIZED));
      }

      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json(
          errorResponse('Требуются email и пароль', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const normalizedEmail = normalizeEmail(email);
      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json(
          errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
        );
      }
      if (password.length < 6) {
        return res.status(400).json(
          errorResponse('Пароль должен быть не менее 6 символов', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const me = await prisma.user.findUnique({
        where: { id: Number(userId) },
        select: { id: true, email: true, telegramId: true, maxId: true, authProvider: true },
      });
      if (!me) {
        return res.status(404).json(errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND));
      }

      if (me.email && normalizeEmail(me.email) !== normalizedEmail) {
        return res.status(409).json(
          errorResponse('Email уже задан. Измените его в профиле.', ErrorCodes.CONFLICT)
        );
      }

      const conflict = await prisma.user.findFirst({
        where: {
          email: { equals: normalizedEmail, mode: 'insensitive' },
          id: { not: Number(userId) },
        },
        select: { id: true },
      });
      if (conflict) {
        return res.status(409).json(
          errorResponse('Этот email уже используется', ErrorCodes.CONFLICT)
        );
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const nextProvider = me.telegramId || me.maxId ? 'HYBRID' : me.authProvider;

      await prisma.user.update({
        where: { id: Number(userId) },
        data: {
          email: normalizedEmail,
          passwordHash,
          authProvider: nextProvider,
          isActive: false,
        },
      });

      await sendVerificationCodeEmail(Number(userId), normalizedEmail);
      return res.json(
        successResponse(
          null,
          'Учётные данные добавлены. Подтвердите email, чтобы включить вход по паролю.'
        )
      );
    } catch (error: any) {
      return res.status(500).json(
        errorResponse(
          error?.message || 'Не удалось добавить email и пароль',
          ErrorCodes.INTERNAL_ERROR
        )
      );
    }
  }
);

async function processTelegramPhoneVerificationUpdate(update: any) {
  const message = update?.message || update?.edited_message || null;
  const fromIdRaw = message?.from?.id ?? message?.contact?.user_id ?? null;
  const chatIdRaw = message?.chat?.id ?? null;
  const username = message?.from?.username ? String(message.from.username) : null;
  const textRaw = String(message?.text || '').trim();

  if (fromIdRaw && textRaw.startsWith('/start')) {
    const payload = textRaw.split(/\s+/, 2)[1] || '';
    const qrToken = parseTelegramQrStartTokenFromPayload(payload);
    const token = payload.startsWith('verify_phone_') ? payload.slice('verify_phone_'.length) : '';
    if (qrToken) {
      tgLog('qr_auth_start_received', {
        fromIdRaw: String(fromIdRaw),
        hasChatId: chatIdRaw !== null && chatIdRaw !== undefined,
      });
      const qrSession = await bindMessengerQrAuthSessionByStartToken({
        provider: 'TELEGRAM',
        startToken: qrToken,
        messengerUserId: String(fromIdRaw),
        messengerChatId: chatIdRaw !== null && chatIdRaw !== undefined ? String(chatIdRaw) : null,
        messengerUsername: username,
      });

      if (chatIdRaw !== null && chatIdRaw !== undefined) {
        const chatId = String(chatIdRaw);
        if (!qrSession) {
          await sendTelegramInfoMessage({
            chatId,
            text: 'QR-сессия входа недействительна или истекла. Запустите вход заново на сайте.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_start_invalid', error: String(e?.message || e) }));
        } else if (qrSession.status === 'AWAITING_CONTACT' || qrSession.status === 'PENDING') {
          await sendPhoneContactRequestMessage({
            chatId,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_start_pending', error: String(e?.message || e) }));
        } else if (qrSession.status === 'EXPIRED') {
          await sendTelegramInfoMessage({
            chatId,
            text: 'QR-сессия входа истекла. Запустите вход заново на сайте.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_start_expired', error: String(e?.message || e) }));
        } else {
          await sendTelegramInfoMessage({
            chatId,
            text: 'Эта QR-сессия уже завершена.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_start_finished', error: String(e?.message || e) }));
        }
      }
    } else if (token) {
      tgLog('phone_verify_start_received', { fromIdRaw: String(fromIdRaw), hasChatId: chatIdRaw !== null && chatIdRaw !== undefined });
      const session = await bindTelegramToPhoneVerificationByStartToken({
        token,
        telegramUserId: String(fromIdRaw),
        chatId: chatIdRaw !== null && chatIdRaw !== undefined ? String(chatIdRaw) : null,
        username,
      });
      tgLog('phone_verify_start_bound', {
        sessionId: session?.id ?? null,
        sessionStatus: session?.status ?? null,
      });

      if (chatIdRaw !== null && chatIdRaw !== undefined) {
        const chatId = String(chatIdRaw);
        if (!session) {
          await sendTelegramInfoMessage({
            chatId,
            text: 'Ссылка подтверждения недействительна. Запустите подтверждение номера заново в приложении.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'start_invalid', error: String(e?.message || e) }));
        } else if (session.status === 'PENDING') {
          await sendPhoneContactRequestMessage({
            chatId,
            requestedPhone: toApiPhoneString(session.requestedPhone),
          }).catch((e) => tgLog('bot_send_failed', { stage: 'start_pending', error: String(e?.message || e) }));
        } else if (session.status === 'EXPIRED') {
          await sendTelegramInfoMessage({
            chatId,
            text: 'Сессия подтверждения истекла. Запустите подтверждение заново в приложении.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'start_expired', error: String(e?.message || e) }));
        } else {
          await sendTelegramInfoMessage({
            chatId,
            text: 'Эта сессия подтверждения уже завершена.',
            removeKeyboard: true,
          }).catch((e) => tgLog('bot_send_failed', { stage: 'start_already_done', error: String(e?.message || e) }));
        }
      }
    } else if (chatIdRaw !== null && chatIdRaw !== undefined) {
      await sendTelegramWelcomeMessage({
        chatId: String(chatIdRaw),
        startParam: 'home',
      }).catch((e) => tgLog('bot_send_failed', { stage: 'start_welcome', error: String(e?.message || e) }));
    }
  }

  const phoneRaw = message?.contact?.phone_number ?? null;
  if (!fromIdRaw || !phoneRaw) {
    return;
  }

  const normalized = normalizePhoneE164(String(phoneRaw));
  if (!normalized) return;

  await setTelegramContactPhone(String(fromIdRaw), normalized);
  const qrResolved = await resolveTelegramQrSessionByContact({
    telegramUserId: String(fromIdRaw),
    chatId: chatIdRaw !== null && chatIdRaw !== undefined ? String(chatIdRaw) : null,
    username,
    phoneRaw: String(phoneRaw),
  });

  const verification = await verifyPhoneByTelegramContact({
    telegramUserId: String(fromIdRaw),
    phoneRaw: String(phoneRaw),
    username,
  });

  if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND' && !qrResolved.handled) {
    tgLog('contact_without_session', { telegramUserId: String(fromIdRaw) });
    return;
  }

  if (chatIdRaw !== null && chatIdRaw !== undefined) {
    const chatId = String(chatIdRaw);
    if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND' && qrResolved.handled) {
      if (qrResolved.state === 'VERIFIED') {
        await sendTelegramInfoMessage({
          chatId,
          text: 'Вход в веб-версию подтверждён. Вернитесь к компьютеру.',
          removeKeyboard: true,
        }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_verified', error: String(e?.message || e) }));
      } else if (qrResolved.failureReason === 'ACCOUNT_CONFLICT') {
        await sendTelegramInfoMessage({
          chatId,
          text: qrConflictMessage('TELEGRAM'),
          removeKeyboard: true,
        }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_account_conflict', error: String(e?.message || e) }));
      } else if (qrResolved.state === 'FAILED') {
        await sendTelegramInfoMessage({
          chatId,
          text: qrGenericFailureMessage('TELEGRAM'),
        }).catch((e) => tgLog('bot_send_failed', { stage: 'qr_failed', error: String(e?.message || e) }));
      }
    } else if (verification.ok) {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Номер телефона подтверждён. Можно вернуться в приложение.',
        removeKeyboard: true,
      }).catch((e) => tgLog('bot_send_failed', { stage: 'verified', error: String(e?.message || e) }));
    } else if (verification.reason === 'PHONE_MISMATCH') {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Отправлен другой номер. Нажмите кнопку и отправьте контакт с нужным номером.',
      }).catch((e) => tgLog('bot_send_failed', { stage: 'phone_mismatch', error: String(e?.message || e) }));
    } else if (verification.reason === 'SESSION_NOT_FOUND' || verification.reason === 'SESSION_EXPIRED') {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Сессия подтверждения не найдена или истекла. Запустите подтверждение заново в приложении.',
        removeKeyboard: true,
      }).catch((e) => tgLog('bot_send_failed', { stage: 'session_not_found_or_expired', error: String(e?.message || e) }));
    } else if (verification.reason === 'PHONE_ALREADY_USED') {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Этот номер уже используется другим пользователем.',
        removeKeyboard: true,
      }).catch((e) => tgLog('bot_send_failed', { stage: 'phone_already_used', error: String(e?.message || e) }));
    } else if (verification.reason === 'TELEGRAM_ALREADY_USED') {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Этот Telegram-аккаунт уже привязан к другому пользователю.',
        removeKeyboard: true,
      }).catch((e) => tgLog('bot_send_failed', { stage: 'telegram_already_used', error: String(e?.message || e) }));
    } else {
      await sendTelegramInfoMessage({
        chatId,
        text: 'Не удалось подтвердить номер. Попробуйте снова из приложения.',
      }).catch((e) => tgLog('bot_send_failed', { stage: 'unknown_verification_error', error: String(e?.message || e) }));
    }
  }
}

registerTelegramUpdateHandler(processTelegramPhoneVerificationUpdate);

router.post('/telegram/webhook', async (req: express.Request, res: express.Response) => {
  try {
    if (TG_WEBHOOK_SECRET) {
      const header = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (!header || header !== TG_WEBHOOK_SECRET) {
        return res.status(403).json(errorResponse('Forbidden', ErrorCodes.FORBIDDEN));
      }
    }

    await processTelegramPhoneVerificationUpdate(req.body || {});
    return res.json(successResponse({ ok: true }));
  } catch (error: any) {
    return res.status(500).json(
      errorResponse(error?.message || 'Webhook processing failed', ErrorCodes.INTERNAL_ERROR)
    );
  }
});

function extractPhoneFromVcf(vcfInfo: string): string | null {
  const raw = String(vcfInfo || '').trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const telLine = lines.find((line) => /^TEL/i.test(line.trim()));
  if (!telLine) return null;
  const phoneRaw = telLine.split(':').slice(1).join(':').trim();
  return phoneRaw || null;
}

function parseMaxUpdatePayload(update: any) {
  const updateType = String(update?.update_type || '').trim().toLowerCase();
  const message = update?.message || null;
  const fromIdRaw =
    update?.user?.user_id ??
    message?.sender?.user_id ??
    null;
  const chatIdRaw =
    update?.chat_id ??
    message?.recipient?.chat_id ??
    null;
  const username = update?.user?.username || message?.sender?.username
    ? String(update?.user?.username || message?.sender?.username)
    : null;
  const textRaw = String(message?.body?.text || '').trim();

  let startPayload = '';
  if (updateType === 'bot_started') {
    startPayload = String(update?.payload || '').trim();
  } else if (textRaw.startsWith('/start')) {
    startPayload = textRaw.split(/\s+/, 2)[1] || '';
  }
  const phoneVerifyStartToken = startPayload.startsWith('verify_phone_')
    ? startPayload.slice('verify_phone_'.length)
    : '';
  const qrAuthStartToken = startPayload.startsWith('auth_qr_')
    ? startPayload.slice('auth_qr_'.length)
    : '';

  let phoneRaw: string | null = null;
  const attachments = Array.isArray(message?.body?.attachments) ? message.body.attachments : [];
  for (const att of attachments) {
    if (att?.type !== 'contact') continue;
    const fromVcf = extractPhoneFromVcf(String(att?.payload?.vcf_info || ''));
    if (fromVcf) {
      phoneRaw = fromVcf;
      break;
    }
  }

  return { fromIdRaw, chatIdRaw, username, phoneVerifyStartToken, qrAuthStartToken, phoneRaw };
}

async function processMaxPhoneVerificationUpdate(update: any) {
  const parsed = parseMaxUpdatePayload(update);
  const fromIdRaw = parsed.fromIdRaw;
  const username = parsed.username;
  const targetChatId = parsed.fromIdRaw ?? null;

  const isStartEvent =
    String(update?.update_type || '').trim().toLowerCase() === 'bot_started' ||
    String(update?.message?.body?.text || '').trim().startsWith('/start');

  if (fromIdRaw && parsed.qrAuthStartToken) {
    maxLog('qr_auth_start_received', {
      fromIdRaw: String(fromIdRaw),
      hasChatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined,
    });
    const qrSession = await bindMessengerQrAuthSessionByStartToken({
      provider: 'MAX',
      startToken: parsed.qrAuthStartToken,
      messengerUserId: String(fromIdRaw),
      messengerChatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined ? String(parsed.chatIdRaw) : null,
      messengerUsername: username,
    });

    if (targetChatId !== null && targetChatId !== undefined) {
      const chatId = String(targetChatId);
      if (!qrSession) {
        await sendMaxInfoMessage({
          chatId,
          text: 'QR-сессия входа недействительна или истекла. Запустите вход заново на сайте.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_start_invalid', error: String(e?.message || e) }));
      } else if (qrSession.status === 'AWAITING_CONTACT' || qrSession.status === 'PENDING') {
        await sendMaxPhoneContactRequestMessage({
          chatId,
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_start_pending', error: String(e?.message || e) }));
      } else if (qrSession.status === 'EXPIRED') {
        await sendMaxInfoMessage({
          chatId,
          text: 'QR-сессия входа истекла. Запустите вход заново на сайте.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_start_expired', error: String(e?.message || e) }));
      } else {
        await sendMaxInfoMessage({
          chatId,
          text: 'Эта QR-сессия уже завершена.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_start_finished', error: String(e?.message || e) }));
      }
    }
  } else if (fromIdRaw && parsed.phoneVerifyStartToken) {
    maxLog('phone_verify_start_received', {
      fromIdRaw: String(fromIdRaw),
      hasChatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined,
    });
    const session = await bindMaxToPhoneVerificationByStartToken({
      token: parsed.phoneVerifyStartToken,
      maxUserId: String(fromIdRaw),
      chatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined ? String(parsed.chatIdRaw) : null,
      username,
    });
    maxLog('phone_verify_start_bound', {
      sessionId: session?.id ?? null,
      sessionStatus: session?.status ?? null,
    });

    if (targetChatId !== null && targetChatId !== undefined) {
      const chatId = String(targetChatId);
      if (!session) {
        await sendMaxInfoMessage({
          chatId,
          text: 'Ссылка подтверждения недействительна. Запустите подтверждение номера заново в приложении.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'start_invalid', error: String(e?.message || e) }));
      } else if (session.status === 'PENDING') {
        await sendMaxPhoneContactRequestMessage({
          chatId,
          requestedPhone: toApiPhoneString(session.requestedPhone),
        }).catch((e) => maxLog('bot_send_failed', { stage: 'start_pending', error: String(e?.message || e) }));
      } else if (session.status === 'EXPIRED') {
        await sendMaxInfoMessage({
          chatId,
          text: 'Сессия подтверждения истекла. Запустите подтверждение заново в приложении.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'start_expired', error: String(e?.message || e) }));
      } else {
        await sendMaxInfoMessage({
          chatId,
          text: 'Эта сессия подтверждения уже завершена.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'start_already_done', error: String(e?.message || e) }));
      }
    }
  } else if (fromIdRaw && isStartEvent) {
    await sendMaxWelcomeMessage({
      chatId: String(targetChatId),
      startParam: 'home',
    }).catch((e) => maxLog('bot_send_failed', { stage: 'start_welcome', error: String(e?.message || e) }));
  }

  if (!fromIdRaw || !parsed.phoneRaw) return;

  const normalized = normalizePhoneE164(String(parsed.phoneRaw));
  if (!normalized) return;

  await setMaxContactPhone(String(fromIdRaw), normalized);
  const qrResolved = await resolveMaxQrSessionByContact({
    maxUserId: String(fromIdRaw),
    chatId: parsed.chatIdRaw !== null && parsed.chatIdRaw !== undefined ? String(parsed.chatIdRaw) : null,
    username,
    phoneRaw: String(parsed.phoneRaw),
  });

  const verification = await verifyPhoneByMaxContact({
    maxUserId: String(fromIdRaw),
    phoneRaw: String(parsed.phoneRaw),
    username,
  });

  if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND' && !qrResolved.handled) {
    maxLog('contact_without_session', { maxUserId: String(fromIdRaw) });
    return;
  }

  if (targetChatId !== null && targetChatId !== undefined) {
    const chatId = String(targetChatId);
    if (!verification.ok && verification.reason === 'SESSION_NOT_FOUND' && qrResolved.handled) {
      if (qrResolved.state === 'VERIFIED') {
        await sendMaxInfoMessage({
          chatId,
          text: 'Вход в веб-версию подтверждён. Вернитесь к компьютеру.',
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_verified', error: String(e?.message || e) }));
      } else if (qrResolved.failureReason === 'ACCOUNT_CONFLICT') {
        await sendMaxInfoMessage({
          chatId,
          text: qrConflictMessage('MAX'),
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_account_conflict', error: String(e?.message || e) }));
      } else if (qrResolved.state === 'FAILED') {
        await sendMaxInfoMessage({
          chatId,
          text: qrGenericFailureMessage('MAX'),
        }).catch((e) => maxLog('bot_send_failed', { stage: 'qr_failed', error: String(e?.message || e) }));
      }
    } else if (verification.ok) {
      await sendMaxInfoMessage({
        chatId,
        text: 'Номер телефона подтверждён. Можно вернуться в приложение.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'verified', error: String(e?.message || e) }));
    } else if (verification.reason === 'PHONE_MISMATCH') {
      await sendMaxInfoMessage({
        chatId,
        text: 'Отправлен другой номер. Нажмите кнопку и отправьте контакт с нужным номером.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'phone_mismatch', error: String(e?.message || e) }));
    } else if (verification.reason === 'SESSION_NOT_FOUND' || verification.reason === 'SESSION_EXPIRED') {
      await sendMaxInfoMessage({
        chatId,
        text: 'Сессия подтверждения не найдена или истекла. Запустите подтверждение заново в приложении.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'session_not_found_or_expired', error: String(e?.message || e) }));
    } else if (verification.reason === 'PHONE_ALREADY_USED') {
      await sendMaxInfoMessage({
        chatId,
        text: 'Этот номер уже используется другим пользователем.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'phone_already_used', error: String(e?.message || e) }));
    } else if (verification.reason === 'MAX_ALREADY_USED') {
      await sendMaxInfoMessage({
        chatId,
        text: 'Этот MAX-аккаунт уже привязан к другому пользователю.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'max_already_used', error: String(e?.message || e) }));
    } else {
      await sendMaxInfoMessage({
        chatId,
        text: 'Не удалось подтвердить номер. Попробуйте снова из приложения.',
      }).catch((e) => maxLog('bot_send_failed', { stage: 'unknown_verification_error', error: String(e?.message || e) }));
    }
  }
}

registerMaxUpdateHandler(processMaxPhoneVerificationUpdate);

router.post('/max/webhook', async (req: express.Request, res: express.Response) => {
  try {
    if (MAX_WEBHOOK_SECRET) {
      const header = String(req.headers['x-max-bot-api-secret'] || '');
      if (!header || header !== MAX_WEBHOOK_SECRET) {
        return res.status(403).json(errorResponse('Forbidden', ErrorCodes.FORBIDDEN));
      }
    }

    await processMaxPhoneVerificationUpdate(req.body || {});
    return res.json(successResponse({ ok: true }));
  } catch (error: any) {
    return res.status(500).json(
      errorResponse(error?.message || 'Webhook processing failed', ErrorCodes.INTERNAL_ERROR)
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
  if (!email || !password) {
    return res.status(400).json(
      errorResponse('Требуется email и пароль', ErrorCodes.VALIDATION_ERROR)
    );
  }
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json(
      errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
    );
  }

  try {
    const user = (await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
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

    if (!user.passwordHash) {
      return res.status(401).json(
        errorResponse('Для этого аккаунта вход по паролю не настроен', ErrorCodes.UNAUTHORIZED)
      );
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      await prisma.loginAttempt.create({
        data: { userId: user.id, success: false, ip: req.ip },
      });

      const failedAttemptsCount =
        (user.loginAttempts ?? []).filter((a) => !a.success).length + 1;

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

        const profile = await getProfile(user.id);

        res.json(successResponse({
          accessToken: newAccessToken,
          refreshToken: newRefreshToken.token,
          profile
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
    if (!email || !code) {
      return res.status(400).json(
        errorResponse('Требуется email и код', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json(
        errorResponse('Неверный формат email', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const trimmedCode = String(code).trim();
    if (!trimmedCode) {
      return res.status(400).json(
        errorResponse('Требуется код подтверждения', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) return res.status(404).json(
      errorResponse('Пользователь не найден', ErrorCodes.NOT_FOUND)
    );
    if (user.isActive) return res.status(400).json(
      errorResponse('Аккаунт уже активирован', ErrorCodes.VALIDATION_ERROR)
    );

    const latestVerification = await prisma.emailVerification.findFirst({
      where: { userId: user.id, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestVerification) {
      return res.status(400).json(
        errorResponse('Код подтверждения не найден. Запросите новый код.', ErrorCodes.VALIDATION_ERROR)
      );
    }

    const now = new Date();
    if (latestVerification.expiresAt <= now) {
      await prisma.emailVerification.update({
        where: { id: latestVerification.id },
        data: { used: true },
      });
      return res.status(400).json(
        errorResponse('Код подтверждения просрочен. Запросите новый код.', ErrorCodes.VALIDATION_ERROR)
      );
    }

    if (latestVerification.code !== trimmedCode) {
      const newAttempts = (latestVerification.attemptsCount || 0) + 1;
      const tooMany = newAttempts >= MAX_VERIFICATION_ATTEMPTS;

      await prisma.emailVerification.update({
        where: { id: latestVerification.id },
        data: {
          attemptsCount: newAttempts,
          ...(tooMany ? { used: true } : {}),
        },
      });

      if (tooMany) {
        return res.status(429).json(
          errorResponse('Превышено максимальное количество попыток подтверждения', ErrorCodes.TOO_MANY_REQUESTS)
        );
      }
      return res.status(400).json(
        errorResponse('Неверный код подтверждения', ErrorCodes.VALIDATION_ERROR)
      );
    }

    await prisma.emailVerification.update({
      where: { id: latestVerification.id },
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
    const profile = await getProfile(userWithRole.id);

    res.json(successResponse({
      accessToken,
      refreshToken,
      profile,
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
