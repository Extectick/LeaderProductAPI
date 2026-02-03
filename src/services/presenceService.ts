import prisma from '../prisma/client';
import { getRedis } from '../lib/redis';

const PRESENCE_TTL_SEC = Number(process.env.PRESENCE_TTL_SEC || 90);
const LAST_SEEN_MIN_MS = Number(process.env.LAST_SEEN_MIN_MS || 60_000);

const lastSeenFallback = new Map<number, number>();

const keyOnline = (userId: number) => `presence:user:${userId}`;
const keyLastSeen = (userId: number) => `presence:lastSeen:${userId}`;

export type PresenceInfo = {
  userId: number;
  isOnline: boolean;
  lastSeenAt: Date | null;
};

export async function markUserOnline(userId: number) {
  const now = Date.now();
  const redis = getRedis();

  if (redis.isOpen) {
    await redis.set(keyOnline(userId), String(now), { EX: PRESENCE_TTL_SEC });

    const lastSeenRaw = await redis.get(keyLastSeen(userId));
    const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : 0;
    if (!lastSeen || now - lastSeen > LAST_SEEN_MIN_MS) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date(now) },
      });
      await redis.set(keyLastSeen(userId), String(now), { EX: Math.ceil(LAST_SEEN_MIN_MS / 1000) * 2 });
    }
    return;
  }

  const last = lastSeenFallback.get(userId) || 0;
  if (!last || now - last > LAST_SEEN_MIN_MS) {
    lastSeenFallback.set(userId, now);
    await prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date(now) },
    });
  }
}

export async function getPresenceForUsers(userIds: number[]): Promise<PresenceInfo[]> {
  const ids = Array.from(new Set(userIds.filter((id) => Number.isFinite(id))));
  if (!ids.length) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, lastSeenAt: true },
  });

  const redis = getRedis();
  let onlineSet = new Set<number>();

  if (redis.isOpen) {
    const keys = ids.map((id) => keyOnline(id));
    const raw = await redis.mGet(keys);
    raw.forEach((val, idx) => {
      if (val) onlineSet.add(ids[idx]);
    });
  }

  return users.map((u) => ({
    userId: u.id,
    isOnline: onlineSet.has(u.id),
    lastSeenAt: u.lastSeenAt ?? null,
  }));
}
