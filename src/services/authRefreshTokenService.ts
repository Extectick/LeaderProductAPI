import crypto, { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export type AuthDeviceInfo = {
  deviceSessionId?: string | null;
  installId?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  deviceName?: string | null;
};

export const REFRESH_TOKEN_GRACE_MS = Number(process.env.REFRESH_TOKEN_GRACE_MS || 60_000);

export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function normalizeDeviceInfo(input?: AuthDeviceInfo | null): AuthDeviceInfo {
  if (!input) return {};
  const clean = (value?: string | null) => {
    const trimmed = String(value || '').trim();
    return trimmed || undefined;
  };
  return {
    deviceSessionId: clean(input.deviceSessionId),
    installId: clean(input.installId),
    platform: clean(input.platform),
    appVersion: clean(input.appVersion),
    deviceName: clean(input.deviceName),
  };
}

export async function ensureDeviceSession(
  userId: number,
  rawInfo?: AuthDeviceInfo | null,
  db: DbClient = prisma
): Promise<string | null> {
  const info = normalizeDeviceInfo(rawInfo);
  const now = new Date();

  if (info.deviceSessionId) {
    const existing = await db.deviceSession.findFirst({
      where: {
        id: info.deviceSessionId,
        userId,
        revokedAt: null,
      },
    });
    if (existing) {
      await db.deviceSession.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          installId: info.installId || existing.installId,
          platform: info.platform || existing.platform,
          appVersion: info.appVersion || existing.appVersion,
          deviceName: info.deviceName || existing.deviceName,
        },
      });
      return existing.id;
    }
  }

  if (!info.installId) return null;

  const existingByInstall = await db.deviceSession.findFirst({
    where: {
      userId,
      installId: info.installId,
      revokedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existingByInstall) {
    await db.deviceSession.update({
      where: { id: existingByInstall.id },
      data: {
        lastSeenAt: now,
        platform: info.platform || existingByInstall.platform,
        appVersion: info.appVersion || existingByInstall.appVersion,
        deviceName: info.deviceName || existingByInstall.deviceName,
      },
    });
    return existingByInstall.id;
  }

  const created = await db.deviceSession.create({
    data: {
      id: randomUUID(),
      userId,
      installId: info.installId,
      platform: info.platform,
      appVersion: info.appVersion,
      deviceName: info.deviceName,
      lastSeenAt: now,
    },
  });
  return created.id;
}

export async function persistRefreshToken(
  db: DbClient,
  params: {
    rawToken: string;
    userId: number;
    expiresAt: Date;
    deviceInfo?: AuthDeviceInfo | null;
    familyId?: string | null;
  }
) {
  const tokenHash = hashRefreshToken(params.rawToken);
  const deviceSessionId = await ensureDeviceSession(params.userId, params.deviceInfo, db);
  const created = await db.refreshToken.create({
    data: {
      // Keep legacy column populated without storing the raw token.
      token: tokenHash,
      tokenHash,
      userId: params.userId,
      deviceSessionId,
      familyId: params.familyId || randomUUID(),
      expiresAt: params.expiresAt,
    },
  });
  return { token: params.rawToken, tokenHash, deviceSessionId, record: created };
}

export function buildDeviceInfoFromRequestBody(body: any): AuthDeviceInfo {
  return normalizeDeviceInfo({
    deviceSessionId: body?.deviceSessionId,
    installId: body?.installId,
    platform: body?.platform,
    appVersion: body?.appVersion,
    deviceName: body?.deviceName,
  });
}
