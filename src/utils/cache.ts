import { createClient } from 'redis';

let client: ReturnType<typeof createClient> | null = null;
let warnedMissingRedis = false;
let connectStarted = false;

function getClient(): ReturnType<typeof createClient> | null {
  if (process.env.REDIS_DISABLE === '1') {
    return null;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (!warnedMissingRedis) {
      console.warn('REDIS_URL not set; caching disabled');
      warnedMissingRedis = true;
    }
    return null;
  }

  if (!client) {
    client = createClient({ url: redisUrl });
    client.on('error', (err) => console.error('Redis error', err));
  }

  if (!connectStarted) {
    connectStarted = true;
    client.connect().catch((err) => {
      console.error('Redis connection error', err);
      connectStarted = false;
    });
  }

  return client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const cacheClient = getClient();
  if (!cacheClient) return null;
  try {
    const data = await cacheClient.get(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch (err) {
    console.error('cacheGet error', err);
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
  const cacheClient = getClient();
  if (!cacheClient) return;
  try {
    await cacheClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.error('cacheSet error', err);
  }
}

export async function cacheDel(key: string): Promise<void> {
  const cacheClient = getClient();
  if (!cacheClient) return;
  try {
    await cacheClient.del(key);
  } catch (err) {
    console.error('cacheDel error', err);
  }
}

export async function cacheDelPrefix(prefix: string): Promise<void> {
  const cacheClient = getClient();
  if (!cacheClient) return;
  try {
    const keys = await cacheClient.keys(`${prefix}*`);
    if (keys.length) {
      await cacheClient.del(keys);
    }
  } catch (err) {
    console.error('cacheDelPrefix error', err);
  }
}

export default { cacheGet, cacheSet, cacheDel, cacheDelPrefix };
