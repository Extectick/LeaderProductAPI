import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL;
let client: ReturnType<typeof createClient> | null = null;

if (redisUrl) {
  const c = createClient({ url: redisUrl });
  c.on('error', (err) => console.error('Redis error', err));
  c.connect().catch((err) => {
    console.error('Redis connection error', err);
  });
  client = c;
} else {
  console.warn('REDIS_URL not set; caching disabled');
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!client) return null;
  try {
    const data = await client.get(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch (err) {
    console.error('cacheGet error', err);
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.error('cacheSet error', err);
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!client) return;
  try {
    await client.del(key);
  } catch (err) {
    console.error('cacheDel error', err);
  }
}

export async function cacheDelPrefix(prefix: string): Promise<void> {
  if (!client) return;
  try {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) {
      await client.del(keys);
    }
  } catch (err) {
    console.error('cacheDelPrefix error', err);
  }
}

export default { cacheGet, cacheSet, cacheDel, cacheDelPrefix };
