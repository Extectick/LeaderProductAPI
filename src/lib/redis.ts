import { createClient, RedisClientType } from 'redis';

const url = process.env.REDIS_URL || 'redis://localhost:6379';
const prefix = process.env.REDIS_KEY_PREFIX || 'app:';
const socketTimeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000);

let _client: RedisClientType | null = null;

export function getRedis(): RedisClientType {
  if (_client) return _client;

  _client = createClient({
    url,
    socket: { reconnectStrategy: (retries) => Math.min(1000 * retries, 5000), connectTimeout: socketTimeout }
  });

  _client.on('error', (err) => {
    console.error('[redis] error:', err?.message || err);
  });
  _client.on('reconnecting', () => {
    console.warn('[redis] reconnecting...');
  });
  _client.on('connect', () => {
    console.log('[redis] connected');
  });

  // Важно: connect() не вызываем синхронно здесь, а при старте (см. ниже)
  return _client;
}

export async function connectRedis() {
  const client = getRedis();
  if (!client.isOpen) await client.connect();
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

export async function cacheGet<T=any>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r.isOpen) return null;
  const raw = await r.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as T;
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