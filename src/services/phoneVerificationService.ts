import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { normalizePhoneToBigInt, normalizePhoneToDigits11, toApiPhoneString } from '../utils/phone';
import { isTelegramBotConfigured } from './telegramBotService';

const PHONE_VERIFICATION_TTL_MS = 10 * 60 * 1000;
export const PHONE_VERIFICATION_POLL_INTERVAL_SEC = 3;

function getBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').trim();
}

function ensureTelegramPhoneVerificationConfigured() {
  if (!isTelegramBotConfigured()) {
    throw new Error('TELEGRAM_PHONE_VERIFICATION_NOT_CONFIGURED');
  }
}

function buildDeepLink(token: string) {
  const username = getBotUsername();
  if (!username) {
    throw new Error('TELEGRAM_PHONE_VERIFICATION_NOT_CONFIGURED');
  }
  return `https://t.me/${username}?start=verify_phone_${token}`;
}

function isValidPhoneVerificationDeepLink(url: string): boolean {
  if (!url) return false;
  if (!url.startsWith('https://t.me/')) return false;
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

function resolveHybridAuthProvider(current: 'LOCAL' | 'TELEGRAM' | 'HYBRID', hasTelegram: boolean) {
  if (!hasTelegram && current === 'LOCAL') return 'HYBRID';
  if (hasTelegram && current === 'LOCAL') return 'HYBRID';
  return current;
}

function dropTelegramAuthProvider(current: 'LOCAL' | 'TELEGRAM' | 'HYBRID') {
  if (current === 'TELEGRAM' || current === 'HYBRID') return 'LOCAL';
  return current;
}

export async function startPhoneVerificationSession(params: { userId: number; phoneRaw: string }) {
  ensureTelegramPhoneVerificationConfigured();

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
    },
    select: {
      id: true,
      expiresAt: true,
      requestedPhone: true,
    },
  });

  const deepLinkUrl = buildDeepLink(rawToken);
  if (!isValidPhoneVerificationDeepLink(deepLinkUrl)) {
    throw new Error('TELEGRAM_DEEP_LINK_UNAVAILABLE');
  }

  return {
    sessionId: created.id,
    deepLinkUrl,
    qrPayload: deepLinkUrl,
    expiresAt: created.expiresAt,
    pollIntervalSec: PHONE_VERIFICATION_POLL_INTERVAL_SEC,
    requestedPhone: toApiPhoneString(created.requestedPhone),
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
      expiresAt: true,
      requestedPhone: true,
    },
  });

  if (!session) return null;

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
      telegramUserId: telegramUserIdBigInt,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      userId: true,
      requestedPhone: true,
      status: true,
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
      authProvider: true,
      telegramId: true,
      telegramUsername: true,
      telegramLinkedAt: true,
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
    select: { id: true, authProvider: true },
  });

  const nextProvider = resolveHybridAuthProvider(user.authProvider, Boolean(telegramUserIdBigInt));
  const now = new Date();
  const isTelegramChanged = !user.telegramId || user.telegramId !== telegramUserIdBigInt;
  const tx: Prisma.PrismaPromise<unknown>[] = [];

  if (telegramOwner) {
    tx.push(
      prisma.user.update({
        where: { id: telegramOwner.id },
        data: {
          telegramId: null,
          telegramUsername: null,
          telegramLinkedAt: null,
          authProvider: dropTelegramAuthProvider(telegramOwner.authProvider),
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
