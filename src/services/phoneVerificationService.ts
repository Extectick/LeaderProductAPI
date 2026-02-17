import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { normalizePhoneToBigInt, normalizePhoneToDigits11, toApiPhoneString } from '../utils/phone';
import { isTelegramBotConfigured } from './telegramBotService';
import { isMaxBotConfigured } from './maxBotService';

const PHONE_VERIFICATION_TTL_MS = 10 * 60 * 1000;
export const PHONE_VERIFICATION_POLL_INTERVAL_SEC = 3;
type PhoneVerificationProviderValue = 'TELEGRAM' | 'MAX';
type AuthProviderValue = 'LOCAL' | 'TELEGRAM' | 'MAX' | 'HYBRID';

function getTelegramBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').trim();
}

function getMaxBotUsername() {
  return String(process.env.MAX_BOT_USERNAME || '').trim();
}

function hasCredentials(user: { email?: string | null; passwordHash?: string | null }) {
  return Boolean(user.email && user.passwordHash);
}

function resolveAuthProvider(hasLocalCredentials: boolean, hasTelegram: boolean, hasMax: boolean): AuthProviderValue {
  if (hasLocalCredentials) {
    return hasTelegram || hasMax ? 'HYBRID' : 'LOCAL';
  }
  if (hasTelegram && hasMax) return 'HYBRID';
  if (hasTelegram) return 'TELEGRAM';
  if (hasMax) return 'MAX';
  return 'LOCAL';
}

function ensurePhoneVerificationConfigured(provider: PhoneVerificationProviderValue) {
  if (provider === 'TELEGRAM') {
    if (!isTelegramBotConfigured() || !getTelegramBotUsername()) {
      throw new Error('TELEGRAM_PHONE_VERIFICATION_NOT_CONFIGURED');
    }
    return;
  }
  if (!isMaxBotConfigured() || !getMaxBotUsername()) {
    throw new Error('MAX_PHONE_VERIFICATION_NOT_CONFIGURED');
  }
}

function buildDeepLink(provider: PhoneVerificationProviderValue, token: string) {
  if (provider === 'TELEGRAM') {
    const username = getTelegramBotUsername();
    if (!username) throw new Error('TELEGRAM_PHONE_VERIFICATION_NOT_CONFIGURED');
    return `https://t.me/${username}?start=verify_phone_${token}`;
  }

  const username = getMaxBotUsername();
  if (!username) throw new Error('MAX_PHONE_VERIFICATION_NOT_CONFIGURED');
  return `https://max.ru/${username}?start=verify_phone_${token}`;
}

function isValidPhoneVerificationDeepLink(url: string, provider: PhoneVerificationProviderValue): boolean {
  if (!url) return false;
  if (provider === 'TELEGRAM') {
    if (!url.startsWith('https://t.me/')) return false;
    return /[?&]start=verify_phone_[A-Za-z0-9_-]+/.test(url);
  }
  if (!url.startsWith('https://max.ru/')) return false;
  return /[?&]start=verify_phone_[A-Za-z0-9_-]+/.test(url);
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function makeRawToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseBigInt(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

export async function startPhoneVerificationSession(params: {
  userId: number;
  phoneRaw: string;
  provider?: PhoneVerificationProviderValue;
}) {
  const provider = params.provider || 'TELEGRAM';
  ensurePhoneVerificationConfigured(provider);

  const normalizedDigits = normalizePhoneToDigits11(params.phoneRaw);
  if (!normalizedDigits) {
    throw new Error('Некорректный формат телефона');
  }

  const phoneBigInt = normalizePhoneToBigInt(normalizedDigits);
  if (!phoneBigInt) {
    throw new Error('Некорректный формат телефона');
  }

  const owner = await prisma.user.findFirst({
    where: {
      phone: phoneBigInt,
      id: { not: params.userId },
    },
    select: { id: true },
  });
  if (owner) {
    throw new Error('Этот номер уже используется другим пользователем');
  }

  await prisma.phoneVerificationSession.updateMany({
    where: {
      userId: params.userId,
      status: 'PENDING',
    },
    data: {
      status: 'CANCELLED',
      failureReason: 'REPLACED_BY_NEW_REQUEST',
    },
  });

  const rawToken = makeRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + PHONE_VERIFICATION_TTL_MS);

  const created = await prisma.phoneVerificationSession.create({
    data: {
      userId: params.userId,
      requestedPhone: phoneBigInt,
      tokenHash,
      expiresAt,
      status: 'PENDING',
      provider,
    },
    select: {
      id: true,
      expiresAt: true,
      requestedPhone: true,
      provider: true,
    },
  });

  const deepLinkUrl = buildDeepLink(provider, rawToken);
  if (!isValidPhoneVerificationDeepLink(deepLinkUrl, provider)) {
    throw new Error(`${provider}_DEEP_LINK_UNAVAILABLE`);
  }

  return {
    sessionId: created.id,
    deepLinkUrl,
    qrPayload: deepLinkUrl,
    expiresAt: created.expiresAt,
    pollIntervalSec: PHONE_VERIFICATION_POLL_INTERVAL_SEC,
    requestedPhone: toApiPhoneString(created.requestedPhone),
    provider: created.provider,
  };
}

export async function getPhoneVerificationSessionState(params: { userId: number; sessionId: string }) {
  const session = await prisma.phoneVerificationSession.findFirst({
    where: {
      id: params.sessionId,
      userId: params.userId,
    },
    select: {
      id: true,
      status: true,
      requestedPhone: true,
      expiresAt: true,
      verifiedAt: true,
      failureReason: true,
      provider: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!session) return null;

  if (session.status === 'PENDING' && session.expiresAt.getTime() <= Date.now()) {
    const expired = await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
      select: {
        id: true,
        status: true,
        requestedPhone: true,
        expiresAt: true,
        verifiedAt: true,
        failureReason: true,
        provider: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ...expired,
      requestedPhone: toApiPhoneString(expired.requestedPhone),
    };
  }

  return {
    ...session,
    requestedPhone: toApiPhoneString(session.requestedPhone),
  };
}

export async function cancelPhoneVerificationSession(params: { userId: number; sessionId: string }) {
  const updated = await prisma.phoneVerificationSession.updateMany({
    where: {
      id: params.sessionId,
      userId: params.userId,
      status: 'PENDING',
    },
    data: {
      status: 'CANCELLED',
      failureReason: 'CANCELLED_BY_USER',
    },
  });
  return updated.count > 0;
}

export async function bindTelegramToPhoneVerificationByStartToken(params: {
  token: string;
  telegramUserId: string;
  chatId?: string | null;
  username?: string | null;
}) {
  const token = String(params.token || '').trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const telegramUserIdBigInt = parseBigInt(params.telegramUserId);
  const chatIdBigInt = parseBigInt(params.chatId ?? null);
  if (!telegramUserIdBigInt) return null;

  const session = await prisma.phoneVerificationSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      status: true,
      provider: true,
      expiresAt: true,
      requestedPhone: true,
    },
  });

  if (!session) return null;
  if (session.provider !== 'TELEGRAM') return null;

  if (session.status !== 'PENDING') return session;
  if (session.expiresAt.getTime() <= Date.now()) {
    return prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: { status: 'EXPIRED', failureReason: 'SESSION_EXPIRED' },
      select: { id: true, status: true, expiresAt: true, requestedPhone: true },
    });
  }

  return prisma.phoneVerificationSession.update({
    where: { id: session.id },
    data: {
      telegramUserId: telegramUserIdBigInt,
      chatId: chatIdBigInt,
    },
    select: { id: true, status: true, expiresAt: true, requestedPhone: true },
  });
}

export async function verifyPhoneByTelegramContact(params: {
  telegramUserId: string;
  phoneRaw: string;
  username?: string | null;
}) {
  const telegramUserIdBigInt = parseBigInt(params.telegramUserId);
  if (!telegramUserIdBigInt) return { ok: false, reason: 'INVALID_TELEGRAM_USER_ID' };

  const normalizedPhoneDigits = normalizePhoneToDigits11(params.phoneRaw);
  if (!normalizedPhoneDigits) return { ok: false, reason: 'INVALID_PHONE' };

  const normalizedPhoneBigInt = normalizePhoneToBigInt(normalizedPhoneDigits);
  if (!normalizedPhoneBigInt) return { ok: false, reason: 'INVALID_PHONE' };

  const session = await prisma.phoneVerificationSession.findFirst({
    where: {
      provider: 'TELEGRAM',
      telegramUserId: telegramUserIdBigInt,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      userId: true,
      requestedPhone: true,
      status: true,
      provider: true,
      expiresAt: true,
    },
  });

  if (!session) return { ok: false, reason: 'SESSION_NOT_FOUND' };

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
    });
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }

  const requestedPhone = toApiPhoneString(session.requestedPhone);
  if (!requestedPhone || requestedPhone !== normalizedPhoneDigits) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'PHONE_MISMATCH',
      },
    });
    return { ok: false, reason: 'PHONE_MISMATCH' };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      telegramId: true,
      telegramUsername: true,
      telegramLinkedAt: true,
      maxId: true,
    },
  });

  if (!user) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'USER_NOT_FOUND',
      },
    });
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  const phoneOwner = await prisma.user.findFirst({
    where: {
      phone: normalizedPhoneBigInt,
      id: { not: user.id },
    },
    select: { id: true },
  });

  if (phoneOwner) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'PHONE_ALREADY_USED',
      },
    });
    return { ok: false, reason: 'PHONE_ALREADY_USED' };
  }

  const telegramOwner = await prisma.user.findFirst({
    where: {
      telegramId: telegramUserIdBigInt,
      id: { not: user.id },
    },
    select: { id: true, email: true, passwordHash: true, maxId: true },
  });

  const nextProvider = resolveAuthProvider(
    hasCredentials(user),
    Boolean(telegramUserIdBigInt),
    Boolean(user.maxId)
  );
  const now = new Date();
  const isTelegramChanged = !user.telegramId || user.telegramId !== telegramUserIdBigInt;
  const tx: Prisma.PrismaPromise<unknown>[] = [];

  if (telegramOwner) {
    const nextOwnerProvider = resolveAuthProvider(
      hasCredentials(telegramOwner),
      false,
      Boolean(telegramOwner.maxId)
    );
    tx.push(
      prisma.user.update({
        where: { id: telegramOwner.id },
        data: {
          telegramId: null,
          telegramUsername: null,
          telegramLinkedAt: null,
          authProvider: nextOwnerProvider,
        },
      })
    );
  }

  tx.push(
    prisma.user.update({
      where: { id: user.id },
      data: {
        phone: normalizedPhoneBigInt,
        phoneVerifiedAt: now,
        telegramId: telegramUserIdBigInt,
        telegramUsername: params.username || user.telegramUsername || undefined,
        telegramLinkedAt: isTelegramChanged ? now : user.telegramLinkedAt ?? now,
        authProvider: nextProvider,
      },
    }),
    prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: now,
        failureReason: null,
      },
    })
  );

  await prisma.$transaction(tx);

  return { ok: true, reason: 'VERIFIED', userId: user.id };
}

export async function bindMaxToPhoneVerificationByStartToken(params: {
  token: string;
  maxUserId: string;
  chatId?: string | null;
  username?: string | null;
}) {
  const token = String(params.token || '').trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const maxUserIdBigInt = parseBigInt(params.maxUserId);
  const chatIdBigInt = parseBigInt(params.chatId ?? null);
  if (!maxUserIdBigInt) return null;

  const session = await prisma.phoneVerificationSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      status: true,
      provider: true,
      expiresAt: true,
      requestedPhone: true,
    },
  });

  if (!session) return null;
  if (session.provider !== 'MAX') return null;
  if (session.status !== 'PENDING') return session;
  if (session.expiresAt.getTime() <= Date.now()) {
    return prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: { status: 'EXPIRED', failureReason: 'SESSION_EXPIRED' },
      select: { id: true, status: true, provider: true, expiresAt: true, requestedPhone: true },
    });
  }

  return prisma.phoneVerificationSession.update({
    where: { id: session.id },
    data: {
      maxUserId: maxUserIdBigInt,
      maxChatId: chatIdBigInt,
    },
    select: { id: true, status: true, provider: true, expiresAt: true, requestedPhone: true },
  });
}

export async function verifyPhoneByMaxContact(params: {
  maxUserId: string;
  phoneRaw: string;
  username?: string | null;
}) {
  const maxUserIdBigInt = parseBigInt(params.maxUserId);
  if (!maxUserIdBigInt) return { ok: false, reason: 'INVALID_MAX_USER_ID' };

  const normalizedPhoneDigits = normalizePhoneToDigits11(params.phoneRaw);
  if (!normalizedPhoneDigits) return { ok: false, reason: 'INVALID_PHONE' };

  const normalizedPhoneBigInt = normalizePhoneToBigInt(normalizedPhoneDigits);
  if (!normalizedPhoneBigInt) return { ok: false, reason: 'INVALID_PHONE' };

  const session = await prisma.phoneVerificationSession.findFirst({
    where: {
      provider: 'MAX',
      maxUserId: maxUserIdBigInt,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      userId: true,
      requestedPhone: true,
      status: true,
      provider: true,
      expiresAt: true,
    },
  });

  if (!session) return { ok: false, reason: 'SESSION_NOT_FOUND' };

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: 'SESSION_EXPIRED',
      },
    });
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }

  const requestedPhone = toApiPhoneString(session.requestedPhone);
  if (!requestedPhone || requestedPhone !== normalizedPhoneDigits) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'PHONE_MISMATCH',
      },
    });
    return { ok: false, reason: 'PHONE_MISMATCH' };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      telegramId: true,
      maxId: true,
      maxUsername: true,
      maxLinkedAt: true,
    },
  });

  if (!user) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'USER_NOT_FOUND',
      },
    });
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  const phoneOwner = await prisma.user.findFirst({
    where: {
      phone: normalizedPhoneBigInt,
      id: { not: user.id },
    },
    select: { id: true },
  });

  if (phoneOwner) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'PHONE_ALREADY_USED',
      },
    });
    return { ok: false, reason: 'PHONE_ALREADY_USED' };
  }

  const maxOwner = await prisma.user.findFirst({
    where: {
      maxId: maxUserIdBigInt,
      id: { not: user.id },
    },
    select: { id: true },
  });

  if (maxOwner) {
    await prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'FAILED',
        failureReason: 'MAX_ALREADY_USED',
      },
    });
    return { ok: false, reason: 'MAX_ALREADY_USED' };
  }

  const now = new Date();
  const isMaxChanged = !user.maxId || user.maxId !== maxUserIdBigInt;
  const nextProvider = resolveAuthProvider(
    hasCredentials(user),
    Boolean(user.telegramId),
    Boolean(maxUserIdBigInt)
  );

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        phone: normalizedPhoneBigInt,
        phoneVerifiedAt: now,
        maxId: maxUserIdBigInt,
        maxUsername: params.username || user.maxUsername || undefined,
        maxLinkedAt: isMaxChanged ? now : user.maxLinkedAt ?? now,
        authProvider: nextProvider,
      },
    }),
    prisma.phoneVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: now,
        failureReason: null,
      },
    }),
  ]);

  return { ok: true, reason: 'VERIFIED', userId: user.id };
}
