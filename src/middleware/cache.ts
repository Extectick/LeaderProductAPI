import { Request, Response, NextFunction } from 'express';
import { getRedis, redisKeys } from '../lib/redis';

type CacheOpts = {
  include?: RegExp;        // кэшируем только то, что match'ится
  exclude?: RegExp;        // исключения
  varyByAuth?: boolean;    // учитывать пользователя/токен в ключе
  cacheStatuses?: number[];// какие статусы кэшировать (по умолч. 200)
};

export function cacheByUrl(ttlSeconds = 30, opts: CacheOpts = {}) {
  const { include, exclude, varyByAuth = true, cacheStatuses = [200] } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1) Кэш только для GET
      if (req.method !== 'GET') return next();

      const url = req.originalUrl;
      if (include && !include.test(url)) return next();
      if (exclude && exclude.test(url)) return next();

      // 2) ключ кэша (учёт пользователя предотвращает утечки данных)
      const auth = varyByAuth ? (req.headers.authorization || 'anon') : 'anon';
      const key = redisKeys.byPathCache(`${auth}:${url}`);

      const redis = getRedis();
      if (redis.isOpen) {
        const hit = await redis.get(key);
        if (hit) {
          const cached = JSON.parse(hit) as { status: number; headers?: Record<string,string>; body: any };
          res.setHeader('X-Cache', 'HIT');
          if (cached.headers) for (const [h,v] of Object.entries(cached.headers)) res.setHeader(h, v);
          return res.status(cached.status || 200).send(cached.body);
        }
      }

      // 3) Оборачиваем res.json для записи в кэш
      const origJson = res.json.bind(res);
      res.json = (body: any) => {
        try {
          if (cacheStatuses.includes(res.statusCode)) {
            const payload = JSON.stringify({
              status: res.statusCode,
              headers: {
                'Content-Type': (res.getHeader('Content-Type') as string) || 'application/json',
              },
              body,
            });
            if (getRedis().isOpen) void getRedis().set(key, payload, { EX: ttlSeconds });
          }
        } catch { /* не мешаем ответу */ }
        res.setHeader('X-Cache', 'MISS');
        return origJson(body);
      };

      return next();
    } catch {
      return next();
    }
  };
}
