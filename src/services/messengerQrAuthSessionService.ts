import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { isMaxBotConfigured } from './maxBotService';
import { isTelegramBotConfigured } from './telegramBotService';

const MESSENGER_QR_AUTH_TTL_MS = 10 * 60 * 1000;
export const MESSENGER_QR_AUTH_POLL_INTERVAL_SEC = 3;

export type MessengerQrAuthProviderValue = 'TELEGRAM' | 'MAX';

const ACTIVE_PENDING_STATUSES = ['PENDING', 'AWAITING_CONTACT'] as const;

const qrSessionSelect = {
  id: true,
  provider: true,
  status: true,
  messengerUserId: true,
  messengerChatId: true,
  messengerUsername: true,
  resolvedUserId: true,
  failureReason: true,
  expiresAt: true,
  verifiedAt: true,
  consumedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type MessengerQrAuthSessionRecord = Prisma.MessengerQrAuthSessionGetPayload<{
  select: typeof qrSessionSelect;
}>;

function getTelegramBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '')
    .replace(/^@+/, '')
    .trim();
}

function getMaxBotUsername() {
  return String(process.env.MAX_BOT_USERNAME || '')
    .replace(/^@+/, '')
    .trim();
}

function hashToken(tokenRaw: string) {
  return crypto.createHash('sha256').update(tokenRaw).digest('hex');
}

function makeRawToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseBigInt(value?: string | number | bigint | null): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function isValidDeepLink(url: string, provider: MessengerQrAuthProviderValue) {
  if (provider === 'MAX') {
    return /^https:\/\/max\.ru\/.+\?start=auth_qr_[A-Za-z0-9_-]+$/.test(url);
  }
  return /^https:\/\/t\.me\/.+\?start=auth_qr_[A-Za-z0-9_-]+$/.test(url);
}

function ensureProviderConfigured(provider: MessengerQrAuthProviderValue) {
  if (provider === 'TELEGRAM') {
    if (!isTelegramBotConfigured() || !getTelegramBotUsername()) {
      throw new Error('TELEGRAM_QR_AUTH_NOT_CONFIGURED');
    }
    return;
  }

  if (!isMaxBotConfigured() || !getMaxBotUsername()) {
    throw new Error('MAX_QR_AUTH_NOT_CONFIGURED');
  }
}

function buildDeepLink(provider: MessengerQrAuthProviderValue, startToken: string) {
  if (provider === 'TELEGRAM') {
    const username = getTelegramBotUsername();
    if (!username) throw new Error('TELEGRAM_QR_AUTH_NOT_CONFIGURED');
    const url = `https://t.me/${username}?start=auth_qr_${startToken}`;
    if (!isValidDeepLink(url, provider)) {
      throw new Error('TELEGRAM_QR_DEEP_LINK_UNAVAILABLE');
    }
    return url;
  }

  const username = getMaxBotUsername();
  if (!username) throw new Error('MAX_QR_AUTH_NOT_CONFIGURED');
  const url = `https://max.ru/${username}?start=auth_qr_${startToken}`;
  if (!isValidDeepLink(url, provider)) {
    throw new Error('MAX_QR_DEEP_LINK_UNAVAILABLE');
  }
  return url;
}

async function expireSessionIfNeeded(session: MessengerQrAuthSessionRecord) {
  if (!ACTIVE_PENDING_STATUSES.includes(session.status as (typeof ACTIVE_PENDING_STATUSES)[number])) {
    return session;
  }
  if (session.expiresAt.getTime() > Date.now()) {
    return session;
  }
  return prisma.messengerQrAuthSession.update({
    where: { id: session.id },
    data: {
      status: 'EXPIRED',
      failureReason: 'SESSION_EXPIRED',
    },
    select: qrSessionSelect,
  });
}

export async function startMessengerQrAuthSession(provider: MessengerQrAuthProviderValue) {
  ensureProviderConfigured(provider);

  const startToken = makeRawToken();
  const sessionToken = makeRawToken();
  const expiresAt = new Date(Date.now() + MESSENGER_QR_AUTH_TTL_MS);
  const deepLinkUrl = buildDeepLink(provider, startToken);

  await prisma.messengerQrAuthSession.create({
    data: {
      provider,
      startTokenHash: hashToken(startToken),
      clientTokenHash: hashToken(sessionToken),
      status: 'PENDING',
      expiresAt,
    },
    select: { id: true },
  });

  return {
    provider,
    sessionToken,
    deepLinkUrl,
    qrPayload: deepLinkUrl,
    expiresAt,
    pollIntervalSec: MESSENGER_QR_AUTH_POLL_INTERVAL_SEC,
  };
}

export async function getMessengerQrAuthSessionByClientToken(
  provider: MessengerQrAuthProviderValue,
  sessionTokenRaw: string
) {
  const sessionToken = String(sessionTokenRaw || '').trim();
  if (!sessionToken) throw new Error('sessionToken is required');

  const session = await prisma.messengerQrAuthSession.findFirst({
    where: {
      provider,
      clientTokenHash: hashToken(sessionToken),
    },
    select: qrSessionSelect,
  });
  if (!session) return null;
  return expireSessionIfNeeded(session);
}

export async function cancelMessengerQrAuthSessionByClientToken(
  provider: MessengerQrAuthProviderValue,
  sessionTokenRaw: string
) {
  const session = await getMessengerQrAuthSessionByClientToken(provider, sessionTokenRaw);
  if (!session) return { cancelled: false, session: null };

  if (!ACTIVE_PENDING_STATUSES.includes(session.status as (typeof ACTIVE_PENDING_STATUSES)[number])) {
    return { cancelled: false, session };
  }

  const updated = await prisma.messengerQrAuthSession.update({
    where: { id: session.id },
    data: {
      status: 'CANCELLED',
      failureReason: 'CANCELLED_BY_USER',
    },
    select: qrSessionSelect,
  });
  return { cancelled: true, session: updated };
}

export async function bindMessengerQrAuthSessionByStartToken(params: {
  provider: MessengerQrAuthProviderValue;
  startToken: string;
  messengerUserId: string | number | bigint;
  messengerChatId?: string | number | bigint | null;
  messengerUsername?: string | null;
}) {
  const startToken = String(params.startToken || '').trim();
  if (!startToken) return null;

  const messengerUserId = parseBigInt(params.messengerUserId);
  if (!messengerUserId) return null;
  const messengerChatId = parseBigInt(params.messengerChatId ?? null);

  const session = await prisma.messengerQrAuthSession.findFirst({
    where: {
      provider: params.provider,
      startTokenHash: hashToken(startToken),
    },
    select: qrSessionSelect,
  });
  if (!session) return null;

  const actual = await expireSessionIfNeeded(session);
  if (!ACTIVE_PENDING_STATUSES.includes(actual.status as (typeof ACTIVE_PENDING_STATUSES)[number])) {
    return actual;
  }

  return prisma.messengerQrAuthSession.update({
    where: { id: actual.id },
    data: {
      messengerUserId,
      messengerChatId,
      messengerUsername: params.messengerUsername || null,
      status: 'AWAITING_CONTACT',
      failureReason: null,
    },
    select: qrSessionSelect,
  });
}

export async function getLatestActiveMessengerQrAuthSessionByMessengerUser(params: {
  provider: MessengerQrAuthProviderValue;
  messengerUserId: string | number | bigint;
}) {
  const messengerUserId = parseBigInt(params.messengerUserId);
  if (!messengerUserId) return null;

  const session = await prisma.messengerQrAuthSession.findFirst({
    where: {
      provider: params.provider,
      messengerUserId,
      status: { in: [...ACTIVE_PENDING_STATUSES] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: 'desc' },
    select: qrSessionSelect,
  });
  return session || null;
}

export async function markLatestMessengerQrAuthSessionVerified(params: {
  provider: MessengerQrAuthProviderValue;
  messengerUserId: string | number | bigint;
  resolvedUserId: number;
  messengerUsername?: string | null;
}) {
  const session = await getLatestActiveMessengerQrAuthSessionByMessengerUser({
    provider: params.provider,
    messengerUserId: params.messengerUserId,
  });
  if (!session) return null;

  return prisma.messengerQrAuthSession.update({
    where: { id: session.id },
    data: {
      status: 'VERIFIED',
      resolvedUserId: params.resolvedUserId,
      messengerUsername: params.messengerUsername || session.messengerUsername || null,
      failureReason: null,
      verifiedAt: new Date(),
    },
    select: qrSessionSelect,
  });
}

export async function markLatestMessengerQrAuthSessionFailed(params: {
  provider: MessengerQrAuthProviderValue;
  messengerUserId: string | number | bigint;
  failureReason: string;
  messengerUsername?: string | null;
}) {
  const session = await getLatestActiveMessengerQrAuthSessionByMessengerUser({
    provider: params.provider,
    messengerUserId: params.messengerUserId,
  });
  if (!session) return null;

  return prisma.messengerQrAuthSession.update({
    where: { id: session.id },
    data: {
      status: 'FAILED',
      failureReason: params.failureReason,
      messengerUsername: params.messengerUsername || session.messengerUsername || null,
    },
    select: qrSessionSelect,
  });
}

export async function consumeMessengerQrAuthSession(sessionId: string) {
  const id = String(sessionId || '').trim();
  if (!id) return false;

  const updated = await prisma.messengerQrAuthSession.updateMany({
    where: {
      id,
      status: 'VERIFIED',
    },
    data: {
      status: 'CONSUMED',
      consumedAt: new Date(),
    },
  });
  return updated.count > 0;
}
