import express from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../storage/minio';
import { errorResponse, ErrorCodes } from '../utils/apiResponse';
import { getRedis, redisKeys } from '../lib/redis';
import { verifyFileToken } from '../utils/fileTokens';

const FILES_CACHE_TTL = Number(process.env.FILES_CACHE_TTL || 300);
const FILES_CACHE_MAX_BYTES = Number(process.env.FILES_CACHE_MAX_BYTES || 1024 * 1024);
const FILES_REQUIRE_TOKEN = process.env.FILES_REQUIRE_TOKEN === '1';

const router = express.Router();

const S3_BUCKET = process.env.S3_BUCKET;

function normalizeKey(raw: string) {
  return raw.replace(/^\/+/, '');
}

function getFileToken(req: express.Request) {
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const headerToken = typeof req.headers['x-file-token'] === 'string' ? req.headers['x-file-token'] : '';
  return queryToken || headerToken;
}

function bufferFromStream(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Express 5 + path-to-regexp v8: use wildcard parameter syntax (*key) for multi-segment paths.
router.get('/*key', async (req, res) => {
  if (!S3_BUCKET) {
    return res.status(500).json(
      errorResponse('S3_BUCKET не задан', ErrorCodes.INTERNAL_ERROR)
    );
  }

  const rawKey = (req.params as any)?.key ?? '';
  const combinedKey = Array.isArray(rawKey) ? rawKey.join('/') : String(rawKey || '');
  const key = normalizeKey(combinedKey);
  if (!key) {
    return res.status(400).json(
      errorResponse('Некорректный ключ файла', ErrorCodes.VALIDATION_ERROR)
    );
  }

  if (FILES_REQUIRE_TOKEN) {
    const token = getFileToken(req);
    if (!token) {
      return res.status(401).json(
        errorResponse('Требуется токен доступа к файлу', ErrorCodes.UNAUTHORIZED)
      );
    }
    if (!verifyFileToken(token, key)) {
      return res.status(403).json(
        errorResponse('Недействительный токен доступа к файлу', ErrorCodes.FORBIDDEN)
      );
    }
  }

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
  const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : '';
  const cacheKey = redisKeys.byPathCache(`files:${key}`);
  try {
    const redis = getRedis();
    if (redis.isOpen && !rangeHeader) {
      const hit = await redis.get(cacheKey);
      if (hit) {
        const cached = JSON.parse(hit) as {
          contentType?: string;
          contentLength?: number;
          etag?: string;
          bodyBase64: string;
        };
        if (cached.etag && ifNoneMatch && cached.etag === ifNoneMatch) {
          res.setHeader('ETag', cached.etag);
          res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Cache', 'HIT');
          return res.status(304).end();
        }
        if (cached.contentType) res.setHeader('Content-Type', cached.contentType);
        if (cached.contentLength !== undefined) res.setHeader('Content-Length', String(cached.contentLength));
        if (cached.etag) res.setHeader('ETag', cached.etag);
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Cache', 'HIT');
        return res.end(Buffer.from(cached.bodyBase64, 'base64'));
      }
    }
  } catch {
    // ignore cache errors
  }

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Range: rangeHeader || undefined,
      })
    );

    if (result.ContentType) res.setHeader('Content-Type', result.ContentType);
    if (result.ContentLength !== undefined) {
      res.setHeader('Content-Length', String(result.ContentLength));
    }
    if (result.ETag) res.setHeader('ETag', result.ETag);
    if (result.ContentRange) res.setHeader('Content-Range', result.ContentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!rangeHeader && result.ETag && ifNoneMatch && result.ETag === ifNoneMatch) {
      const body = result.Body as any;
      if (body?.destroy) body.destroy();
      return res.status(304).end();
    }

    const body = result.Body as any;
    if (body && typeof body.pipe === 'function') {
      const canCache =
        FILES_CACHE_TTL > 0 &&
        !rangeHeader &&
        typeof result.ContentLength === 'number' &&
        result.ContentLength > 0 &&
        result.ContentLength <= FILES_CACHE_MAX_BYTES;

      if (!canCache) {
        if (rangeHeader || result.ContentRange) {
          res.status(206);
        }
        body.pipe(res);
        return;
      }

      const buffer = await bufferFromStream(body);
      if (rangeHeader || result.ContentRange) {
        res.status(206);
      }
      res.setHeader('X-Cache', 'MISS');
      res.end(buffer);

      try {
        const redis = getRedis();
        if (redis.isOpen) {
          const payload = JSON.stringify({
            contentType: result.ContentType,
            contentLength: buffer.length,
            etag: result.ETag,
            bodyBase64: buffer.toString('base64'),
          });
          await redis.set(cacheKey, payload, { EX: FILES_CACHE_TTL });
        }
      } catch {
        // ignore cache errors
      }
      return;
    }

    if (body) {
      if (rangeHeader || result.ContentRange) {
        res.status(206);
      }
      res.setHeader('X-Cache', 'MISS');
      res.end(body);
      return;
    }

    return res.status(204).end();
  } catch (error: any) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === 'NoSuchKey') {
      return res.status(404).json(
        errorResponse('Файл не найден', ErrorCodes.NOT_FOUND)
      );
    }
    return res.status(500).json(
      errorResponse(
        'Ошибка получения файла',
        ErrorCodes.INTERNAL_ERROR,
        process.env.NODE_ENV === 'development' ? error : undefined
      )
    );
  }
});

export default router;
