import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getRedis } from '../lib/redis';
import { normalizePhoneToDigits11 } from '../utils/phone';

const MAX_SESSION_TTL_SEC = 10 * 60;
const MAX_CONTACT_TTL_SEC = 10 * 60;
const MAX_INITDATA_MAX_AGE_SEC = 24 * 60 * 60;

export type MaxUserInfo = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type MaxSessionPayload = {
  maxId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  iat?: number;
  exp?: number;
};

function getBotToken() {
  return String(process.env.MAX_BOT_TOKEN || '').trim();
}

function getSessionSecret() {
  return String(process.env.MAX_SESSION_SECRET || process.env.ACCESS_TOKEN_SECRET || 'max-session-secret').trim();
}

function getContactKey(maxId: string) {
  return `max:contact:${maxId}`;
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeInitDataRaw(initDataRaw: string): URLSearchParams {
  const raw = String(initDataRaw || '').trim();
  if (!raw) throw new Error('MAX initData is missing');

  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    const parsed = new URLSearchParams(candidate);
    if (Array.from(parsed.keys()).length > 1) return parsed;
    if (parsed.has('signature') || parsed.has('hash') || parsed.has('user')) return parsed;
  }

  throw new Error('MAX initData is invalid');
}

function extractSignature(params: URLSearchParams): string {
  const signature = String(params.get('signature') || params.get('hash') || '').trim();
  if (!signature) {
    throw new Error('MAX initData signature is missing');
  }
  return signature;
}

function decodeUserId(user: any): string {
  const userId = user?.user_id ?? user?.id;
  if (userId === undefined || userId === null) {
    throw new Error('MAX user id is missing');
  }
  return String(userId);
}

function normalizeUserName(user: any) {
  return safeString(user?.username);
}

function normalizeFirstName(user: any) {
  return safeString(user?.first_name) ?? safeString(user?.name);
}

function normalizeLastName(user: any) {
  return safeString(user?.last_name);
}

function equalsInTimingSafeWay(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function normalizePhoneE164(phoneRaw: string): string | null {
  return normalizePhoneToDigits11(phoneRaw);
}

export function verifyMaxInitData(initDataRaw: string): MaxUserInfo {
  const botToken = getBotToken();
  if (!botToken) {
    throw new Error('MAX bot token is not configured');
  }

  const params = normalizeInitDataRaw(initDataRaw);
  const signature = extractSignature(params);

  const authDateRaw = String(params.get('auth_date') || '').trim();
  if (authDateRaw) {
    const authDateSec = Number(authDateRaw);
    if (Number.isFinite(authDateSec) && authDateSec > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - authDateSec > MAX_INITDATA_MAX_AGE_SEC) {
        throw new Error('MAX initData is expired');
      }
    }
  }

  params.delete('signature');
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const signatureDigest = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest();

  const expectedSignatureHex = signatureDigest.toString('hex').toLowerCase();
  const expectedSignatureBase64Url = signatureDigest.toString('base64url');

  const actualSignature = signature.trim();
  const isHexMatch = equalsInTimingSafeWay(actualSignature.toLowerCase(), expectedSignatureHex);
  const isBase64Match = equalsInTimingSafeWay(actualSignature, expectedSignatureBase64Url);
  if (!isHexMatch && !isBase64Match) {
    throw new Error('MAX initData signature mismatch');
  }

  const userRaw = String(params.get('user') || '').trim();
  if (!userRaw) {
    throw new Error('MAX user is missing in initData');
  }

  let user: any;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error('MAX user payload is invalid');
  }

  return {
    id: decodeUserId(user),
    username: normalizeUserName(user),
    firstName: normalizeFirstName(user),
    lastName: normalizeLastName(user),
  };
}

export function issueMaxSessionToken(user: MaxUserInfo) {
  const payload: MaxSessionPayload = {
    maxId: user.id,
    username: user.username ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
  };
  return jwt.sign(payload, getSessionSecret(), {
    expiresIn: MAX_SESSION_TTL_SEC,
    algorithm: 'HS256',
  });
}

export function parseMaxSessionToken(tokenRaw: string): MaxSessionPayload {
  const token = String(tokenRaw || '').trim();
  if (!token) throw new Error('maxSessionToken is required');
  const payload = jwt.verify(token, getSessionSecret()) as MaxSessionPayload;
  if (!payload?.maxId) throw new Error('Invalid maxSessionToken payload');
  return payload;
}

export async function setMaxContactPhone(maxId: string, phoneE164: string) {
  try {
    const redis = getRedis();
    if (!redis.isOpen) return;
    await redis.set(getContactKey(maxId), phoneE164, { EX: MAX_CONTACT_TTL_SEC });
  } catch {
    // Redis fallback is best-effort.
  }
}

export async function getMaxContactPhone(maxId: string) {
  try {
    const redis = getRedis();
    if (!redis.isOpen) return null;
    const value = await redis.get(getContactKey(maxId));
    return value || null;
  } catch {
    return null;
  }
}
