import express from 'express';
import crypto from 'node:crypto';
import { AppPlatform, Prisma } from '@prisma/client';

import prisma from '../prisma/client';
import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import { errorResponse, ErrorCodes, successResponse } from '../utils/apiResponse';
import { deleteObject, resolveObjectUrl } from '../storage/minio';

const router = express.Router();
const DEFAULT_CHANNEL = 'prod';
const MAX_ROLLOUT = 100;

type OtaAssetInput = {
  key: string;
  hash?: string;
  contentType?: string;
  fileExtension?: string;
};

type CleanupUpdate = {
  id: number;
  updateId: string;
  manifestKey: string | null;
  launchAssetKey: string;
  assets: Prisma.JsonValue;
};

function noUpdate(res: express.Response) {
  res.setHeader('expo-protocol-version', '1');
  res.setHeader('cache-control', 'private, no-cache, no-store');
  return res.status(204).end();
}

function parsePlatform(raw?: string | string[]) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'android') return AppPlatform.ANDROID;
  if (normalized === 'ios') return AppPlatform.IOS;
  if (normalized === 'ANDROID') return AppPlatform.ANDROID;
  if (normalized === 'IOS') return AppPlatform.IOS;
  return null;
}

function parseChannel(raw?: string | string[]) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim() || DEFAULT_CHANNEL;
}

function parseBoolean(raw: unknown, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  const value = String(raw).trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function parseRollout(raw: unknown) {
  if (raw === undefined || raw === null || raw === '') return MAX_ROLLOUT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(MAX_ROLLOUT, Math.round(value)));
}

function hashBucket(value: string) {
  const digest = crypto.createHash('sha1').update(value).digest('hex');
  const hex = digest.slice(0, 8);
  const num = parseInt(hex, 16);
  return num % 100;
}

function shouldIncludeUpdate(deviceId: string | undefined, updateId: string, rolloutPercent: number) {
  if (rolloutPercent >= MAX_ROLLOUT) return true;
  if (!deviceId) return false;
  return hashBucket(`${deviceId}:${updateId}`) < rolloutPercent;
}

function normalizeAssetList(raw: unknown): OtaAssetInput[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error('assets must be an array');
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`assets[${index}] must be an object`);
    }
    const asset = item as Record<string, unknown>;
    const key = String(asset.key || '').trim();
    if (!key) throw new Error(`assets[${index}].key is required`);
    return {
      key,
      hash: asset.hash ? String(asset.hash).trim() : undefined,
      contentType: asset.contentType ? String(asset.contentType).trim() : undefined,
      fileExtension: asset.fileExtension ? String(asset.fileExtension).trim() : undefined,
    };
  });
}

function collectUpdateObjectKeys(update: CleanupUpdate) {
  const keys = new Set<string>();
  if (update.manifestKey) keys.add(update.manifestKey);
  if (update.launchAssetKey) keys.add(update.launchAssetKey);

  for (const asset of normalizeAssetList(update.assets)) {
    if (asset.key) keys.add(asset.key);
  }

  return Array.from(keys);
}

function parsePositiveInt(raw: unknown, fallback: number) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function normalizePublishBody(body: any) {
  const platform = parsePlatform(body?.platform);
  if (!platform) return { ok: false as const, message: 'platform должен быть android или ios' };

  const channel = parseChannel(body?.channel);
  const runtimeVersion = String(body?.runtimeVersion || '').trim();
  if (!runtimeVersion) return { ok: false as const, message: 'runtimeVersion обязателен' };

  const launchAssetKey = String(body?.launchAssetKey || '').trim();
  if (!launchAssetKey) return { ok: false as const, message: 'launchAssetKey обязателен' };

  const rolloutPercent = parseRollout(body?.rolloutPercent);
  if (rolloutPercent === null) {
    return { ok: false as const, message: 'rolloutPercent должен быть числом от 0 до 100' };
  }

  let assets: OtaAssetInput[];
  try {
    assets = normalizeAssetList(body?.assets);
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'Некорректные assets' };
  }

  const updateId =
    String(body?.updateId || '').trim() ||
    crypto.randomUUID();

  return {
    ok: true as const,
    data: {
      platform,
      channel,
      runtimeVersion,
      updateId,
      manifestKey: body?.manifestKey ? String(body.manifestKey).trim() : null,
      launchAssetKey,
      launchAssetHash: body?.launchAssetHash ? String(body.launchAssetHash).trim() : null,
      launchAssetType: String(body?.launchAssetType || 'application/javascript').trim(),
      assets,
      metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : null,
      isActive: parseBoolean(body?.isActive, true),
      rolloutPercent,
      commitSha: body?.commitSha ? String(body.commitSha).trim() : null,
      releaseNotes: body?.releaseNotes ? String(body.releaseNotes) : null,
    },
  };
}

async function buildAssetDescriptor(asset: OtaAssetInput) {
  const url = await resolveObjectUrl(asset.key);
  return {
    hash: asset.hash || crypto.createHash('sha256').update(asset.key).digest('hex'),
    key: asset.key,
    fileExtension: asset.fileExtension || '',
    contentType: asset.contentType || 'application/octet-stream',
    url,
  };
}

async function buildManifest(update: any) {
  const launchAssetUrl = await resolveObjectUrl(update.launchAssetKey);
  const assets = normalizeAssetList(update.assets).filter((asset) => asset.key !== update.launchAssetKey);

  return {
    id: update.updateId,
    createdAt: update.createdAt.toISOString(),
    runtimeVersion: update.runtimeVersion,
    launchAsset: {
      hash: update.launchAssetHash || crypto.createHash('sha256').update(update.launchAssetKey).digest('hex'),
      key: update.launchAssetKey,
      contentType: update.launchAssetType,
      url: launchAssetUrl,
    },
    assets: await Promise.all(assets.map(buildAssetDescriptor)),
    metadata: {
      ...(update.metadata && typeof update.metadata === 'object' ? update.metadata : {}),
      channel: update.channel,
      commitSha: update.commitSha ?? undefined,
      releaseNotes: update.releaseNotes ?? undefined,
    },
    extra: {
      expoClient: {},
    },
  };
}

function sendManifest(res: express.Response, manifest: unknown) {
  const boundary = `expo-${crypto.randomBytes(8).toString('hex')}`;
  const manifestJson = JSON.stringify(manifest);
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="manifest"',
    'Content-Type: application/json',
    '',
    manifestJson,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  res.setHeader('expo-protocol-version', '1');
  res.setHeader('cache-control', 'private, no-cache, no-store');
  res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
  return res.status(200).send(body);
}

async function handleUpdateRequest(req: express.Request, res: express.Response) {
  try {
    const platform =
      parsePlatform(req.header('expo-platform') || req.query.platform as string | undefined) ||
      parsePlatform(req.query.platform as string | undefined);
    if (!platform) return noUpdate(res);

    const runtimeVersion = String(
      req.header('expo-runtime-version') ||
      req.query.runtimeVersion ||
      ''
    ).trim();
    if (!runtimeVersion) return noUpdate(res);

    const channel = parseChannel(
      req.header('expo-channel-name') ||
      req.query.channel as string | undefined
    );
    const deviceId = String(
      req.header('expo-device-id') ||
      req.query.deviceId ||
      req.header('expo-current-update-id') ||
      ''
    ).trim() || undefined;

    const candidates = await prisma.appOtaUpdate.findMany({
      where: {
        platform,
        channel,
        runtimeVersion,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const selected = candidates.find((update) =>
      shouldIncludeUpdate(deviceId, update.updateId, update.rolloutPercent)
    );
    if (!selected) return noUpdate(res);

    const currentUpdateId = String(req.header('expo-current-update-id') || '').trim();
    if (currentUpdateId && currentUpdateId === selected.updateId) {
      return noUpdate(res);
    }

    const manifest = await buildManifest(selected);
    return sendManifest(res, manifest);
  } catch (error) {
    console.error('[ota] update check failed', error);
    return noUpdate(res);
  }
}

router.get('/update', async (req, res) => {
  return handleUpdateRequest(req, res);
});

router.post('/update', async (req, res) => {
  req.query = { ...req.query, ...(req.body || {}) };
  return handleUpdateRequest(req, res);
});

router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (req: AuthRequest<{}, any, any, any>, res) => {
    try {
      const platform = parsePlatform(req.query.platform as string | undefined);
      const channelRaw = req.query.channel as string | undefined;
      const runtimeVersion = req.query.runtimeVersion ? String(req.query.runtimeVersion) : undefined;

      const where: Prisma.AppOtaUpdateWhereInput = {};
      if (platform) where.platform = platform;
      if (channelRaw) where.channel = parseChannel(channelRaw);
      if (runtimeVersion) where.runtimeVersion = runtimeVersion;

      const updates = await prisma.appOtaUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return res.json(successResponse(updates, 'Список OTA обновлений'));
    } catch (error) {
      console.error('[ota] list failed', error);
      return res.status(500).json(errorResponse('Ошибка получения OTA обновлений', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.post(
  '/publish',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (req: AuthRequest<{}, any, any, any>, res) => {
    try {
      const parsed = normalizePublishBody(req.body);
      if (!parsed.ok) {
        return res.status(400).json(errorResponse(parsed.message, ErrorCodes.VALIDATION_ERROR));
      }

      const data: Prisma.AppOtaUpdateUncheckedCreateInput = {
        ...parsed.data,
        assets: parsed.data.assets as unknown as Prisma.InputJsonValue,
        metadata: parsed.data.metadata as Prisma.InputJsonValue | undefined,
      };

      const saved = await prisma.appOtaUpdate.upsert({
        where: { updateId: parsed.data.updateId },
        create: data,
        update: data,
      });

      return res.status(201).json(successResponse(saved, 'OTA обновление опубликовано'));
    } catch (error) {
      console.error('[ota] publish failed', error);
      return res.status(500).json(errorResponse('Ошибка публикации OTA обновления', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.post(
  '/cleanup',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (req: AuthRequest<{}, any, any, any>, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const platform = parsePlatform(body.platform as string | undefined);
      const channel = body.channel ? parseChannel(body.channel as string) : undefined;
      const runtimeVersion = body.runtimeVersion ? String(body.runtimeVersion).trim() : undefined;
      const includeActive = parseBoolean(body.includeActive, false);
      const dryRun = parseBoolean(body.dryRun, true);
      const deleteDbRows = parseBoolean(body.deleteDbRows, false);
      const keepLast = parsePositiveInt(body.keepLast, 0);
      const limit = parsePositiveInt(body.limit, 50);
      const olderThanDays = parsePositiveInt(body.olderThanDays, 0);

      if (keepLast === null || limit === null || olderThanDays === null) {
        return res.status(400).json(errorResponse('keepLast, limit и olderThanDays должны быть положительными числами', ErrorCodes.VALIDATION_ERROR));
      }

      if (includeActive && !dryRun) {
        return res.status(400).json(errorResponse('Активные OTA нельзя удалять через cleanup. Сначала деактивируйте обновление.', ErrorCodes.VALIDATION_ERROR));
      }

      const where: Prisma.AppOtaUpdateWhereInput = {};
      if (!includeActive) where.isActive = false;
      if (platform) where.platform = platform;
      if (channel) where.channel = channel;
      if (runtimeVersion) where.runtimeVersion = runtimeVersion;
      if (olderThanDays > 0) {
        where.createdAt = {
          lt: new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000),
        };
      }

      const updates = await prisma.appOtaUpdate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit + keepLast, 200),
        select: {
          id: true,
          updateId: true,
          manifestKey: true,
          launchAssetKey: true,
          assets: true,
        },
      });

      const candidates = updates.slice(keepLast);
      const files = candidates.flatMap((update) =>
        collectUpdateObjectKeys(update).map((key) => ({
          updateId: update.updateId,
          key,
        }))
      );

      const deletedFiles: typeof files = [];
      const failedFiles: Array<{ updateId: string; key: string; error: string }> = [];

      if (!dryRun) {
        for (const file of files) {
          try {
            await deleteObject(file.key);
            deletedFiles.push(file);
          } catch (error) {
            failedFiles.push({
              ...file,
              error: error instanceof Error ? error.message : 'Unknown delete error',
            });
          }
        }
      }

      let deletedDbRows = 0;
      if (!dryRun && deleteDbRows && failedFiles.length === 0 && candidates.length > 0) {
        const result = await prisma.appOtaUpdate.deleteMany({
          where: { id: { in: candidates.map((update) => update.id) } },
        });
        deletedDbRows = result.count;
      }

      return res.json(successResponse({
        dryRun,
        includeActive,
        keepLast,
        matchedUpdates: updates.length,
        cleanupUpdates: candidates.map((update) => ({
          id: update.id,
          updateId: update.updateId,
        })),
        files,
        deletedFiles,
        failedFiles,
        deletedDbRows,
      }, dryRun ? 'План очистки OTA файлов' : 'Очистка OTA файлов выполнена'));
    } catch (error) {
      console.error('[ota] cleanup failed', error);
      return res.status(500).json(errorResponse('Ошибка очистки OTA файлов', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

router.put(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (req: AuthRequest<{ id: string }, any, any, any>, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json(errorResponse('Некорректный id', ErrorCodes.VALIDATION_ERROR));
      }

      const body = req.body as Record<string, unknown>;
      const data: Prisma.AppOtaUpdateUpdateInput = {};
      if (body.isActive !== undefined) data.isActive = parseBoolean(body.isActive);
      if (body.rolloutPercent !== undefined) {
        const rollout = parseRollout(body.rolloutPercent);
        if (rollout === null) {
          return res.status(400).json(errorResponse('rolloutPercent должен быть числом от 0 до 100', ErrorCodes.VALIDATION_ERROR));
        }
        data.rolloutPercent = rollout;
      }
      if (body.releaseNotes !== undefined) data.releaseNotes = body.releaseNotes ? String(body.releaseNotes) : null;

      const saved = await prisma.appOtaUpdate.update({ where: { id }, data });
      return res.json(successResponse(saved, 'OTA обновление обновлено'));
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res.status(404).json(errorResponse('OTA обновление не найдено', ErrorCodes.NOT_FOUND));
      }
      console.error('[ota] update failed', error);
      return res.status(500).json(errorResponse('Ошибка обновления OTA', ErrorCodes.INTERNAL_ERROR));
    }
  }
);

export default router;
