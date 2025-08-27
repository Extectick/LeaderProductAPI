import { Request, Response, NextFunction } from 'express';
import { getRedis, redisKeys } from '../lib/redis';

export function cacheByUrl(ttlSeconds = 30) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = redisKeys.byPathCache(req.originalUrl);
    try {
      const redis = getRedis();
      if (redis.isOpen) {
        const hit = await redis.get(key);
        if (hit) {
          res.setHeader('X-Cache', 'HIT');
          return res.status(200).type('application/json').send(hit);
        }
      }
    } catch {}
    // переопределяем res.json, чтобы сохранить
    const origJson = res.json.bind(res);
    res.json = (body: any) => {
      try {
        const redis = getRedis();
        if (redis.isOpen) {
          redis.set(key, JSON.stringify(body), { EX: ttlSeconds }).catch(() => {});
        }
      } catch {}
      res.setHeader('X-Cache', 'MISS');
      return origJson(body);
    };
    next();
  };
}