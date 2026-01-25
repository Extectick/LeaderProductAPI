import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import prisma from '../prisma/client';
import {
  authenticateToken,
  authorizePermissions,
  AuthRequest,
} from '../middleware/auth';
import { checkUserStatus } from '../middleware/checkUserStatus';
import {
  errorResponse,
  ErrorCodes,
  successResponse,
} from '../utils/apiResponse';
import { deleteObject, presignGet, uploadMulterFile } from '../storage/minio';
import {
  CreateUpdateRequest,
  CreateUpdateResponse,
  UpdateCheckQuery,
  UpdateCheckResponse,
  UpdateEventRequest,
  UpdateEventResponse,
} from '../types/updateTypes';

const router = express.Router();

const DEFAULT_CHANNEL = 'prod';
const MAX_ROLLOUT = 100;
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET || 'youraccesstokensecret';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 300 * 1024 * 1024,
    files: 1,
  },
});

type UpdateInput = {
  platform: 'ANDROID' | 'IOS';
  channel: string;
  versionCode: number;
  versionName: string;
  minSupportedVersionCode: number;
  isMandatory: boolean;
  rolloutPercent: number;
  isActive: boolean;
  releaseNotes: string | null;
  storeUrl?: string;
  apkKey?: string;
  fileSize?: number;
  checksum?: string;
  checksumMd5?: string;
};

type UpdateListQuery = {
  platform?: string;
  channel?: string;
  limit?: string;
  offset?: string;
};

type UpdateDeleteQuery = {
  purgeFile?: string;
};

type UpdateCleanupBody = {
  platform?: string;
  channel?: string;
  keepLatest?: number | string;
  purgeFile?: boolean | string;
};

function parsePlatform(raw?: string) {
  const normalized = (raw || '').toLowerCase();
  if (normalized === 'android') return 'ANDROID';
  if (normalized === 'ios') return 'IOS';
  return null;
}

function parseBoolean(raw: unknown) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

function parseChannel(raw?: string) {
  const val = String(raw || '').trim();
  return val || DEFAULT_CHANNEL;
}

function parseRollout(raw: unknown) {
  if (raw === undefined || raw === null || raw === '') return MAX_ROLLOUT;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(0, Math.min(MAX_ROLLOUT, Math.round(num)));
  return clamped;
}

function normalizeUpdateInput(body: any): { ok: true; data: UpdateInput } | { ok: false; message: string } {
  const platform = parsePlatform(body?.platform);
  if (!platform) return { ok: false, message: 'platform должен быть android или ios' };

  const channel = parseChannel(body?.channel);

  const versionCode = Number.parseInt(String(body?.versionCode ?? ''), 10);
  if (!Number.isFinite(versionCode)) {
    return { ok: false, message: 'versionCode должен быть целым числом' };
  }

  const versionName = String(body?.versionName ?? '').trim();
  if (!versionName) {
    return { ok: false, message: 'versionName обязателен' };
  }

  const minSupportedVersionCode = Number.parseInt(
    String(body?.minSupportedVersionCode ?? ''),
    10
  );
  if (!Number.isFinite(minSupportedVersionCode)) {
    return { ok: false, message: 'minSupportedVersionCode должен быть целым числом' };
  }
  if (minSupportedVersionCode > versionCode) {
    return { ok: false, message: 'minSupportedVersionCode не должен быть больше versionCode' };
  }

  const rolloutPercent = parseRollout(body?.rolloutPercent);
  if (rolloutPercent === null) {
    return { ok: false, message: 'rolloutPercent должен быть числом от 0 до 100' };
  }

  const isMandatory = parseBoolean(body?.isMandatory);
  const isActive = body?.isActive === undefined ? true : parseBoolean(body?.isActive);
  const releaseNotesRaw = body?.releaseNotes ?? null;
  const releaseNotes = releaseNotesRaw ? String(releaseNotesRaw) : null;

  const storeUrl = body?.storeUrl ? String(body.storeUrl).trim() : undefined;
  const apkKey = body?.apkKey ? String(body.apkKey).trim() : undefined;
  const fileSize = body?.fileSize ? Number(body.fileSize) : undefined;
  const checksum = body?.checksum ? String(body.checksum).trim() : undefined;
  const checksumMd5 = body?.checksumMd5 ? String(body.checksumMd5).trim() : undefined;

  return {
    ok: true,
    data: {
      platform,
      channel,
      versionCode,
      versionName,
      minSupportedVersionCode,
      isMandatory,
      rolloutPercent,
      isActive,
      releaseNotes,
      storeUrl,
      apkKey,
      fileSize: Number.isFinite(fileSize) ? fileSize : undefined,
      checksum: checksum || undefined,
      checksumMd5: checksumMd5 || undefined,
    },
  };
}

function hashBucket(value: string) {
  const digest = crypto.createHash('sha1').update(value).digest('hex');
  const hex = digest.slice(0, 8);
  const num = parseInt(hex, 16);
  return num % 100;
}

function shouldIncludeUpdate(deviceId: string | undefined, updateId: number, rolloutPercent: number) {
  if (rolloutPercent >= MAX_ROLLOUT) return true;
  if (!deviceId) return false;
  const bucket = hashBucket(`${deviceId}:${updateId}`);
  return bucket < rolloutPercent;
}

function computeEtag(payload: unknown) {
  const raw = JSON.stringify(payload);
  const digest = crypto.createHash('sha1').update(raw).digest('hex');
  return `W/"${digest}"`;
}

function getUserIdFromAuthHeader(authHeader?: string): number | undefined {
  if (!authHeader) return undefined;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return undefined;
  const token = parts[1].trim();
  if (!token) return undefined;
  try {
    const decoded = jwt.verify(token, accessTokenSecret) as { userId?: number };
    return decoded?.userId;
  } catch {
    return undefined;
  }
}

async function safeDeleteApk(key: string | null | undefined, skipUpdateId?: number) {
  if (!key) return;
  const usedCount = await prisma.appUpdate.count({
    where: {
      apkKey: key,
      ...(skipUpdateId ? { id: { not: skipUpdateId } } : {}),
    },
  });
  if (usedCount > 0) return;
  try {
    await deleteObject(key);
  } catch (e) {
    console.warn('[updates] deleteObject failed', { key, error: e });
  }
}

/**
 * @openapi
 * /updates/check:
 *   get:
 *     tags: [Updates]
 *     summary: Проверить обновление приложения
 *     parameters:
 *       - in: query
 *         name: platform
 *         required: true
 *         schema: { type: string, enum: [android, ios] }
 *       - in: query
 *         name: versionCode
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: version
 *         schema: { type: string }
 *       - in: query
 *         name: channel
 *         schema: { type: string }
 *       - in: query
 *         name: deviceId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Статус обновления
 *       304:
 *         description: Не изменилось
 *       400:
 *         description: Ошибка валидации параметров
 */
router.get(
  '/check',
  async (
    req: AuthRequest<{}, UpdateCheckResponse, {}, UpdateCheckQuery>,
    res: express.Response<UpdateCheckResponse>
  ) => {
    try {
      const platform = parsePlatform(req.query.platform);
      if (!platform) {
        return res.status(400).json(
          errorResponse('platform должен быть android или ios', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const versionCode = Number.parseInt(String(req.query.versionCode ?? ''), 10);
      if (!Number.isFinite(versionCode)) {
        return res.status(400).json(
          errorResponse('versionCode должен быть целым числом', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const channel = parseChannel(req.query.channel);
      const deviceId = req.query.deviceId ? String(req.query.deviceId) : undefined;

      const latest = await prisma.appUpdate.findFirst({
        where: { platform, channel, isActive: true },
        orderBy: { versionCode: 'desc' },
      });

      if (!latest) {
        const payload = { updateAvailable: false, mandatory: false };
        const etag = computeEtag({ payload, platform, channel, versionCode, deviceId });
        const ifNoneMatch = req.headers['if-none-match'];
        const match =
          Array.isArray(ifNoneMatch) ? ifNoneMatch.includes(etag) : ifNoneMatch === etag;
        if (match) return res.status(304).end();
        res.setHeader('ETag', etag);
        return res.json(successResponse(payload, 'Обновлений не найдено'));
      }

      const updateAvailable = versionCode < latest.versionCode;
      const mandatory =
        updateAvailable &&
        (versionCode < latest.minSupportedVersionCode || latest.isMandatory);

      const eligible = updateAvailable
        ? mandatory || shouldIncludeUpdate(deviceId, latest.id, latest.rolloutPercent)
        : false;

      const payload = {
        updateAvailable: updateAvailable && eligible,
        mandatory: mandatory && eligible,
        latestId: latest.id,
        latestVersionCode: latest.versionCode,
        latestVersionName: latest.versionName,
        minSupportedVersionCode: latest.minSupportedVersionCode,
        rolloutPercent: latest.rolloutPercent,
        releaseNotes: latest.releaseNotes ?? null,
        storeUrl: latest.storeUrl ?? null,
        downloadUrl: null as string | null,
        fileSize: latest.fileSize ?? null,
        checksum: latest.checksum ?? null,
        checksumMd5: latest.checksumMd5 ?? null,
      };

      const needsFreshUrl = updateAvailable && eligible && Boolean(latest.apkKey);
      if (!needsFreshUrl) {
        const etag = computeEtag({ payload, platform, channel, versionCode, deviceId });
        const ifNoneMatch = req.headers['if-none-match'];
        const match =
          Array.isArray(ifNoneMatch) ? ifNoneMatch.includes(etag) : ifNoneMatch === etag;
        if (match) return res.status(304).end();
        res.setHeader('ETag', etag);
      } else {
        res.setHeader('Cache-Control', 'no-store');
      }

      if (needsFreshUrl && latest.apkKey) {
        try {
          const presigned = await presignGet(latest.apkKey);
          payload.downloadUrl = presigned.url;
        } catch (e) {
          console.warn('[updates] presignGet failed', e);
        }
      }

      return res.json(successResponse(payload, 'Статус обновления'));
    } catch (err) {
      console.error('Update check error:', err);
      return res.status(500).json(
        errorResponse('Ошибка проверки обновления', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates/events:
 *   post:
 *     tags: [Updates]
 *     summary: Логировать событие обновления
 */
router.post(
  '/events',
  async (
    req: AuthRequest<{}, UpdateEventResponse, UpdateEventRequest>,
    res: express.Response<UpdateEventResponse>
  ) => {
    try {
      const { eventType, platform, versionCode } = req.body || {};
      const platformParsed = parsePlatform(platform);
      if (!platformParsed) {
        return res.status(400).json(
          errorResponse('platform должен быть android или ios', ErrorCodes.VALIDATION_ERROR)
        );
      }
      if (!eventType) {
        return res.status(400).json(
          errorResponse('eventType обязателен', ErrorCodes.VALIDATION_ERROR)
        );
      }
      const allowed = ['CHECK', 'PROMPT_SHOWN', 'UPDATE_CLICK', 'DISMISS'];
      if (!allowed.includes(eventType)) {
        return res.status(400).json(
          errorResponse('Некорректный eventType', ErrorCodes.VALIDATION_ERROR)
        );
      }
      const versionCodeNum = Number(versionCode);
      if (!Number.isFinite(versionCodeNum)) {
        return res.status(400).json(
          errorResponse('versionCode должен быть числом', ErrorCodes.VALIDATION_ERROR)
        );
      }

      const channel = parseChannel(req.body?.channel);
      const deviceId = req.body?.deviceId ? String(req.body.deviceId) : undefined;
      const versionName = req.body?.versionName ? String(req.body.versionName) : undefined;
      const updateId = req.body?.updateId ? Number(req.body.updateId) : undefined;

      const userId = getUserIdFromAuthHeader(req.headers.authorization);

      const created = await prisma.appUpdateEvent.create({
        data: {
          eventType,
          platform: platformParsed,
          channel,
          versionCode: versionCodeNum,
          versionName,
          deviceId,
          updateId: updateId && Number.isFinite(updateId) ? updateId : undefined,
          userId: userId ?? undefined,
        },
      });

      return res.json(successResponse({ id: created.id }, 'Событие сохранено'));
    } catch (err) {
      console.error('Update event error:', err);
      return res.status(500).json(
        errorResponse('Ошибка записи события', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates:
 *   get:
 *     tags: [Updates]
 *     summary: Список обновлений
 *     security: [ { bearerAuth: [] } ]
 */
router.get(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (
    req: AuthRequest<{}, any, {}, UpdateListQuery>,
    res: express.Response
  ) => {
    try {
      const platform = parsePlatform(req.query.platform as string | undefined);
      const channelRaw = req.query.channel as string | undefined;
      const channel = channelRaw ? parseChannel(channelRaw) : undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

      const where: any = {};
      if (platform) where.platform = platform;
      if (channel) where.channel = channel;

      const [total, updates] = await prisma.$transaction([
        prisma.appUpdate.count({ where }),
        prisma.appUpdate.findMany({
          where,
          orderBy: { versionCode: 'desc' },
          skip: offset,
          take: limit,
        }),
      ]);

      return res.json(
        successResponse(
          {
            data: updates.map((u) => ({
              id: u.id,
              platform: u.platform,
              channel: u.channel,
              versionCode: u.versionCode,
              versionName: u.versionName,
              minSupportedVersionCode: u.minSupportedVersionCode,
              isMandatory: u.isMandatory,
              rolloutPercent: u.rolloutPercent,
              isActive: u.isActive,
              releaseNotes: u.releaseNotes,
              storeUrl: u.storeUrl,
              apkKey: u.apkKey,
              fileSize: u.fileSize,
              checksum: u.checksum,
              checksumMd5: u.checksumMd5,
              createdAt: u.createdAt.toISOString(),
            })),
            meta: { total, limit, offset },
          },
          'Список обновлений'
        )
      );
    } catch (err) {
      console.error('Update list error:', err);
      return res.status(500).json(
        errorResponse('Ошибка получения списка обновлений', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates:
 *   post:
 *     tags: [Updates]
 *     summary: Создать запись обновления (метаданные + apkKey)
 *     security: [ { bearerAuth: [] } ]
 */
router.post(
  '/',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (
    req: AuthRequest<{}, CreateUpdateResponse, CreateUpdateRequest>,
    res: express.Response<CreateUpdateResponse>
  ) => {
    try {
      const parsed = normalizeUpdateInput(req.body);
      if (!parsed.ok) {
        return res
          .status(400)
          .json(errorResponse(parsed.message, ErrorCodes.VALIDATION_ERROR));
      }

      if (!parsed.data.apkKey && !parsed.data.storeUrl) {
        return res
          .status(400)
          .json(errorResponse('Нужно указать apkKey или storeUrl', ErrorCodes.VALIDATION_ERROR));
      }

      const created = await prisma.appUpdate.create({
        data: {
          platform: parsed.data.platform,
          channel: parsed.data.channel,
          versionCode: parsed.data.versionCode,
          versionName: parsed.data.versionName,
          minSupportedVersionCode: parsed.data.minSupportedVersionCode,
          isMandatory: parsed.data.isMandatory,
          rolloutPercent: parsed.data.rolloutPercent,
          isActive: parsed.data.isActive,
          releaseNotes: parsed.data.releaseNotes,
          storeUrl: parsed.data.storeUrl,
          apkKey: parsed.data.apkKey,
          fileSize: parsed.data.fileSize,
          checksum: parsed.data.checksum,
          checksumMd5: parsed.data.checksumMd5,
        },
      });

      return res.status(201).json(
        successResponse(
          {
            id: created.id,
            platform: created.platform,
            channel: created.channel,
            versionCode: created.versionCode,
            versionName: created.versionName,
            minSupportedVersionCode: created.minSupportedVersionCode,
            isMandatory: created.isMandatory,
            rolloutPercent: created.rolloutPercent,
            isActive: created.isActive,
            releaseNotes: created.releaseNotes ?? null,
            storeUrl: created.storeUrl ?? null,
            apkKey: created.apkKey ?? null,
            fileSize: created.fileSize ?? null,
            checksum: created.checksum ?? null,
            checksumMd5: created.checksumMd5 ?? null,
            createdAt: created.createdAt.toISOString(),
          },
          'Обновление создано'
        )
      );
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return res
          .status(409)
          .json(errorResponse('Обновление с такой версией уже существует', ErrorCodes.CONFLICT));
      }
      console.error('Update create error:', err);
      return res.status(500).json(
        errorResponse('Ошибка создания обновления', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates/{id}:
 *   put:
 *     tags: [Updates]
 *     summary: Обновить запись обновления
 *     security: [ { bearerAuth: [] } ]
 */
router.put(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (
    req: AuthRequest<{ id: string }, CreateUpdateResponse, Partial<CreateUpdateRequest>>,
    res: express.Response<CreateUpdateResponse>
  ) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный id', ErrorCodes.VALIDATION_ERROR));
      }

      const current = await prisma.appUpdate.findUnique({ where: { id } });
      if (!current) {
        return res.status(404).json(errorResponse('Обновление не найдено', ErrorCodes.NOT_FOUND));
      }

      const data: any = {};
      if (req.body?.channel !== undefined) data.channel = parseChannel(req.body.channel);
      if (req.body?.versionName !== undefined) data.versionName = String(req.body.versionName || '').trim();
      if (req.body?.versionCode !== undefined) {
        const next = Number(req.body.versionCode);
        if (!Number.isFinite(next)) {
          return res
            .status(400)
            .json(errorResponse('versionCode должен быть числом', ErrorCodes.VALIDATION_ERROR));
        }
        data.versionCode = next;
      }
      if (req.body?.minSupportedVersionCode !== undefined) {
        const next = Number(req.body.minSupportedVersionCode);
        if (!Number.isFinite(next)) {
          return res
            .status(400)
            .json(errorResponse('minSupportedVersionCode должен быть числом', ErrorCodes.VALIDATION_ERROR));
        }
        data.minSupportedVersionCode = next;
      }
      if (req.body?.isMandatory !== undefined) data.isMandatory = parseBoolean(req.body.isMandatory);
      if (req.body?.rolloutPercent !== undefined) {
        const rollout = parseRollout(req.body.rolloutPercent);
        if (rollout === null) {
          return res
            .status(400)
            .json(errorResponse('rolloutPercent должен быть числом от 0 до 100', ErrorCodes.VALIDATION_ERROR));
        }
        data.rolloutPercent = rollout;
      }
      if (req.body?.isActive !== undefined) data.isActive = parseBoolean(req.body.isActive);
      if (req.body?.releaseNotes !== undefined) data.releaseNotes = req.body.releaseNotes ? String(req.body.releaseNotes) : null;
      if (req.body?.storeUrl !== undefined) data.storeUrl = req.body.storeUrl ? String(req.body.storeUrl).trim() : null;
      if (req.body?.apkKey !== undefined) data.apkKey = req.body.apkKey ? String(req.body.apkKey).trim() : null;
      if (req.body?.fileSize !== undefined) data.fileSize = req.body.fileSize ? Number(req.body.fileSize) : null;
      if (req.body?.checksum !== undefined) data.checksum = req.body.checksum ? String(req.body.checksum) : null;
      if (req.body?.checksumMd5 !== undefined) data.checksumMd5 = req.body.checksumMd5 ? String(req.body.checksumMd5) : null;

      const nextVersionCode = data.versionCode ?? current.versionCode;
      const nextMin = data.minSupportedVersionCode ?? current.minSupportedVersionCode;
      if (nextMin > nextVersionCode) {
        return res.status(400).json(
          errorResponse('minSupportedVersionCode не должен быть больше versionCode', ErrorCodes.VALIDATION_ERROR)
        );
      }

      if (!data.apkKey && !data.storeUrl && !current.apkKey && !current.storeUrl) {
        return res
          .status(400)
          .json(errorResponse('Нужно указать apkKey или storeUrl', ErrorCodes.VALIDATION_ERROR));
      }

      const updated = await prisma.appUpdate.update({
        where: { id },
        data,
      });

      return res.json(
        successResponse(
          {
            id: updated.id,
            platform: updated.platform,
            channel: updated.channel,
            versionCode: updated.versionCode,
            versionName: updated.versionName,
            minSupportedVersionCode: updated.minSupportedVersionCode,
            isMandatory: updated.isMandatory,
            rolloutPercent: updated.rolloutPercent,
            isActive: updated.isActive,
            releaseNotes: updated.releaseNotes ?? null,
            storeUrl: updated.storeUrl ?? null,
            apkKey: updated.apkKey ?? null,
            fileSize: updated.fileSize ?? null,
            checksum: updated.checksum ?? null,
            checksumMd5: updated.checksumMd5 ?? null,
            createdAt: updated.createdAt.toISOString(),
          },
          'Обновление обновлено'
        )
      );
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return res
          .status(409)
          .json(errorResponse('Обновление с такой версией уже существует', ErrorCodes.CONFLICT));
      }
      console.error('Update update error:', err);
      return res.status(500).json(
        errorResponse('Ошибка обновления', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates/{id}:
 *   delete:
 *     tags: [Updates]
 *     summary: Удалить обновление
 *     security: [ { bearerAuth: [] } ]
 */
router.delete(
  '/:id',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (
    req: AuthRequest<{ id: string }, any, {}, UpdateDeleteQuery>,
    res: express.Response
  ) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json(errorResponse('Некорректный id', ErrorCodes.VALIDATION_ERROR));
      }

      const purgeFile = req.query.purgeFile !== '0';
      const target = await prisma.appUpdate.findUnique({ where: { id } });
      if (!target) {
        return res.status(404).json(errorResponse('Обновление не найдено', ErrorCodes.NOT_FOUND));
      }

      await prisma.appUpdate.delete({ where: { id } });

      if (purgeFile) {
        await safeDeleteApk(target.apkKey, id);
      }

      return res.json(successResponse({ id }, 'Обновление удалено'));
    } catch (err) {
      console.error('Update delete error:', err);
      return res.status(500).json(
        errorResponse('Ошибка удаления обновления', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates/cleanup:
 *   post:
 *     tags: [Updates]
 *     summary: Очистить старые обновления
 *     security: [ { bearerAuth: [] } ]
 */
router.post(
  '/cleanup',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  async (
    req: AuthRequest<{}, any, UpdateCleanupBody>,
    res: express.Response
  ) => {
    try {
      const platform = parsePlatform(req.body?.platform);
      const channel = req.body?.channel ? parseChannel(req.body.channel) : undefined;
      const keepLatest = Math.max(parseInt(String(req.body?.keepLatest ?? '1'), 10) || 1, 1);
      const purgeFile = req.body?.purgeFile === undefined ? true : parseBoolean(req.body.purgeFile);

      const where: any = {};
      if (platform) where.platform = platform;
      if (channel) where.channel = channel;

      const updates = await prisma.appUpdate.findMany({
        where,
        orderBy: { versionCode: 'desc' },
      });

      const toDelete = updates.slice(keepLatest);
      const deletedIds: number[] = [];

      for (const u of toDelete) {
        await prisma.appUpdate.delete({ where: { id: u.id } });
        deletedIds.push(u.id);
        if (purgeFile) {
          await safeDeleteApk(u.apkKey, u.id);
        }
      }

      return res.json(
        successResponse(
          { deletedCount: deletedIds.length, deletedIds },
          'Очистка завершена'
        )
      );
    } catch (err) {
      console.error('Update cleanup error:', err);
      return res.status(500).json(
        errorResponse('Ошибка очистки обновлений', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

/**
 * @openapi
 * /updates/upload:
 *   post:
 *     tags: [Updates]
 *     summary: Загрузить APK и создать запись обновления
 *     security: [ { bearerAuth: [] } ]
 */
router.post(
  '/upload',
  authenticateToken,
  checkUserStatus,
  authorizePermissions(['manage_updates']),
  upload.single('apk'),
  async (
    req: AuthRequest<{}, CreateUpdateResponse, CreateUpdateRequest>,
    res: express.Response<CreateUpdateResponse>
  ) => {
    try {
      const file = req.file;
      if (!file) {
        return res
          .status(400)
          .json(errorResponse('Файл apk обязателен', ErrorCodes.VALIDATION_ERROR));
      }

      const parsed = normalizeUpdateInput(req.body);
      if (!parsed.ok) {
        return res
          .status(400)
          .json(errorResponse(parsed.message, ErrorCodes.VALIDATION_ERROR));
      }

      const checksum = crypto
        .createHash('sha256')
        .update(file.buffer)
        .digest('hex');

      const checksumMd5 = crypto
        .createHash('md5')
        .update(file.buffer)
        .digest('hex');

      const stored = await uploadMulterFile(file, true, 'updates');

      const created = await prisma.appUpdate.create({
        data: {
          platform: parsed.data.platform,
          channel: parsed.data.channel,
          versionCode: parsed.data.versionCode,
          versionName: parsed.data.versionName,
          minSupportedVersionCode: parsed.data.minSupportedVersionCode,
          isMandatory: parsed.data.isMandatory,
          rolloutPercent: parsed.data.rolloutPercent,
          isActive: parsed.data.isActive,
          releaseNotes: parsed.data.releaseNotes,
          storeUrl: parsed.data.storeUrl,
          apkKey: stored.key,
          fileSize: stored.size ?? file.size,
          checksum: parsed.data.checksum || checksum,
          checksumMd5: parsed.data.checksumMd5 || checksumMd5,
        },
      });

      return res.status(201).json(
        successResponse(
          {
            id: created.id,
            platform: created.platform,
            channel: created.channel,
            versionCode: created.versionCode,
            versionName: created.versionName,
            minSupportedVersionCode: created.minSupportedVersionCode,
            isMandatory: created.isMandatory,
            rolloutPercent: created.rolloutPercent,
            isActive: created.isActive,
            releaseNotes: created.releaseNotes ?? null,
            storeUrl: created.storeUrl ?? null,
            apkKey: created.apkKey ?? null,
            fileSize: created.fileSize ?? null,
            checksum: created.checksum ?? null,
            checksumMd5: created.checksumMd5 ?? null,
            createdAt: created.createdAt.toISOString(),
          },
          'Обновление загружено'
        )
      );
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return res
          .status(409)
          .json(errorResponse('Обновление с такой версией уже существует', ErrorCodes.CONFLICT));
      }
      console.error('Update upload error:', err);
      return res.status(500).json(
        errorResponse('Ошибка загрузки обновления', ErrorCodes.INTERNAL_ERROR)
      );
    }
  }
);

export default router;
