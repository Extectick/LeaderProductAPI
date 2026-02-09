import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRedis } from '../lib/redis';

const TG_SESSION_TTL_SEC = 10 * 60;
const TG_CONTACT_TTL_SEC = 10 * 60;
const TG_MAX_INITDATA_AGE_SEC = 24 * 60 * 60;

export type TelegramUserInfo = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type TelegramSessionPayload = {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  iat?: number;
  exp?: number;
};

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function getSessionSecret() {
  return process.env.TG_SESSION_SECRET || process.env.ACCESS_TOKEN_SECRET || 'tg-session-secret';
}

function getContactKey(telegramId: string) {
  return `tg:contact:${telegramId}`;
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizePhoneE164(phoneRaw: string): string | null {
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (!digits) return null;
  let normalized = digits;
  if (normalized.length === 10) normalized = `7${normalized}`;
  if (normalized.length === 11 && normalized.startsWith('8')) {
    normalized = `7${normalized.slice(1)}`;
  }
  if (normalized.length !== 11 || !normalized.startsWith('7')) return null;
  return `+${normalized}`;
}

export function maskEmail(email: string | null | undefined) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  const left = local.slice(0, 2);
  return `${left}***@${domain}`;
}

export function maskPhone(phone: string | null | undefined) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

export function verifyTelegramInitData(initDataRaw: string): TelegramUserInfo {
  const botToken = getBotToken();
  if (!botToken) {
    throw new Error('Telegram bot token is not configured');
  }

  const params = new URLSearchParams(initDataRaw || '');
  const hash = params.get('hash');
  if (!hash) throw new Error('Telegram initData hash is missing');

  const authDateRaw = params.get('auth_date');
  const authDate = Number(authDateRaw || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || nowSec - authDate > TG_MAX_INITDATA_AGE_SEC) {
    throw new Error('Telegram initData is expired');
  }

  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (expectedHash !== hash) {
    throw new Error('Telegram initData hash mismatch');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('Telegram user is missing in initData');

  let parsedUser: any;
  try {
    parsedUser = JSON.parse(userRaw);
  } catch {
    throw new Error('Telegram user payload is invalid');
  }

  const telegramId = parsedUser?.id;
  if (telegramId === undefined || telegramId === null) {
    throw new Error('Telegram user id is missing');
  }

  return {
    id: String(telegramId),
    username: safeString(parsedUser?.username),
    firstName: safeString(parsedUser?.first_name),
    lastName: safeString(parsedUser?.last_name),
  };
}

export function issueTelegramSessionToken(user: TelegramUserInfo) {
  const payload: TelegramSessionPayload = {
    telegramId: user.id,
    username: user.username ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
  };
  return jwt.sign(payload, getSessionSecret(), {
    expiresIn: TG_SESSION_TTL_SEC,
    algorithm: 'HS256',
  });
}

export function parseTelegramSessionToken(tokenRaw: string): TelegramSessionPayload {
  const token = String(tokenRaw || '').trim();
  if (!token) throw new Error('tgSessionToken is required');
  const payload = jwt.verify(token, getSessionSecret()) as TelegramSessionPayload;
  if (!payload?.telegramId) throw new Error('Invalid tgSessionToken payload');
  return payload;
}

export async function setTelegramContactPhone(telegramId: string, phoneE164: string) {
  try {
    const redis = getRedis();
    if (!redis.isOpen) return;
    await redis.set(getContactKey(telegramId), phoneE164, { EX: TG_CONTACT_TTL_SEC });
  } catch {
    // Redis fallback is best-effort.
  }
}

export async function getTelegramContactPhone(telegramId: string) {
  try {
    const redis = getRedis();
    if (!redis.isOpen) return null;
    const value = await redis.get(getContactKey(telegramId));
    return value || null;
  } catch {
    return null;
  }
}
