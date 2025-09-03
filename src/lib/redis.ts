import { createClient, RedisClientType } from 'redis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';
const prefix = process.env.REDIS_KEY_PREFIX || 'app:';
const socketTimeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 15000);

let _client: RedisClientType | null = null;

export function getRedis(): RedisClientType {
  if (_client) return _client;

  _client = createClient({
    url,
    socket: {
      connectTimeout: socketTimeout,
      // Плавный бэкофф до 5s между попытками
      reconnectStrategy: (retries) => Math.min(1000 * retries, 5000),
    },
  });

  _client.on('connect', () => {
    console.log('[redis] connected');
  });
  _client.on('reconnecting', () => {
    console.warn('[redis] reconnecting...');
  });
  _client.on('error', (err: any) => {
    const name = err?.name || '';
    // Транзиентные ошибки не считаем «красной тревогой»
    if (name === 'ConnectionTimeoutError' || name === 'SocketClosedUnexpectedlyError') {
      console.warn('[redis] transient:', name, '-', err?.message || err);
    } else {
      console.error('[redis] error:', err?.message || err);
    }
  });

  // connect() вызываем в connectRedis()
  return _client;
}

/**
 * Подключаемся к Redis с мягким ретраем в течение maxWaitMs (по умолчанию 15s).
 * Не спамим логами — ошибки считаем транзиентными и просто ждём следующую попытку.
 */
export async function connectRedis(maxWaitMs = 15000) {
  const client = getRedis();
  if (client.isOpen) return client;

  const start = Date.now();
  let attempt = 0;
  // Первая попытка — сразу, далее ретраи каждые 500мс
  while (!client.isOpen) {
    try {
      attempt++;
      await client.connect();
      return client;
    } catch (e: any) {
      if (Date.now() - start > maxWaitMs) {
        console.error('[redis] connect failed after retries:', e?.message || e);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return client;
}

export async function disconnectRedis() {
  if (_client?.isOpen) {
    try { await _client.quit(); } catch {}
  }
}

export const redisKeys = {
  byPathCache: (path: string) => `${prefix}cache:${path}`,
  ratelimit:   (ip: string, windowSeconds: number) => `${prefix}rl:${ip}:${windowSeconds}`,
  // --- QR specific ---
  qrListVer:           (scope: string) => `${prefix}qr:list:ver:${scope}`,      // scope: admin | user:<id>
  qrItemVer:           (id: string) => `${prefix}qr:item:ver:${id}`,
  qrAnalyticsVer:      (scope: string) => `${prefix}qr:analytics:ver:${scope}`,
  qrScansVer:          (scope: string) => `${prefix}qr:scans:ver:${scope}`,
  qrStatsVer:          (scope: string) => `${prefix}qr:stats:ver:${scope}`,
  // cache keys (в ключ вшиваем "ver" для автопротухания)
  qrListCache:         (scope: string, queryHash: string, ver: number) => `${prefix}qr:list:${scope}:${ver}:${queryHash}`,
  qrItemCache:         (id: string, simple: string, ver: number) => `${prefix}qr:item:${id}:${simple}:${ver}`,
  qrAnalyticsCache:    (scope: string, queryHash: string, ver: number) => `${prefix}qr:analytics:${scope}:${ver}:${queryHash}`,
  qrScansCache:        (scope: string, queryHash: string, ver: number) => `${prefix}qr:scans:${scope}:${ver}:${queryHash}`,
  qrStatsCache:        (scope: string, ver: number) => `${prefix}qr:stats:${scope}:${ver}`,
  // public scan helpers
  scanDedup:           (qrId: string, ip: string) => `${prefix}qr:scan:dedup:${qrId}:${ip}`,
  scanRate:            (qrId: string, ip: string, windowSec: number) => `${prefix}qr:scan:rate:${qrId}:${ip}:${windowSec}`,
};

export async function getVersion(key: string) {
  const r = getRedis();
  const v = await r.get(key);
  return v ? parseInt(v, 10) || 1 : 1;
}
export async function bumpVersion(key: string) {
  const r = getRedis();
  return r.incr(key);
}

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r.isOpen) return null;
  const raw = await r.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
export async function cacheSet(key: string, val: any, ttlSec: number) {
  const r = getRedis();
  if (!r.isOpen) return;
  await r.set(key, JSON.stringify(val), { EX: ttlSec });
}

// маленькая утилита для хэша query
export function hashObj(obj: any) {
  const json = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < json.length; i++) { h = (h * 31 + json.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}
