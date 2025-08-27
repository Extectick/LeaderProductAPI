import { Request, Response, NextFunction } from 'express';
import { getRedis, redisKeys } from '../lib/redis';

export function rateLimit({ windowSec = 60, limit = 100 } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.ip ||
        (req.headers['x-forwarded-for'] as string) ||
        req.socket.remoteAddress ||
        'unknown').toString();

    const key = redisKeys.ratelimit(ip, windowSec);

    try {
      const redis = getRedis();
      if (!redis.isOpen) return next();

      const count = await redis.incr(key);
      if (count === 1) {
        // первый хит — стартуем окно
        await redis.expire(key, windowSec);
      }

      if (count > limit) {
        return res.status(429).json({ ok: false, error: 'Too Many Requests' });
      }
    } catch {
      // fail-open
    }
    next();
  };
}
