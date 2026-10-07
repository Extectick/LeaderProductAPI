import prisma from '../prisma/client';

const RETENTION_DAYS = Math.max(30, Number(process.env.TRACKING_RETENTION_DAYS || 180));
const RUN_INTERVAL_MS = 24 * 60 * 60_000;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export async function runTrackingMaintenance(now = new Date()) {
  const expiredRequests = await prisma.trackingLocationRequest.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'TIMED_OUT', completedAt: now, failureReason: 'LOCATION_TIMEOUT' },
  });
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  const anonymizedOrderEvents = await prisma.orderGeoEvent.updateMany({
    where: {
      capturedAt: { lt: cutoff },
      OR: [{ latitude: { not: null } }, { longitude: { not: null } }, { routePointId: { not: null } }],
    },
    data: {
      latitude: null,
      longitude: null,
      accuracy: null,
      routePointId: null,
      source: 'RETENTION',
      failureReason: `RETENTION_${RETENTION_DAYS}_DAYS`,
    },
  });
  const deletedPoints = await prisma.routePoint.deleteMany({ where: { recordedAt: { lt: cutoff } } });
  return {
    expiredRequests: expiredRequests.count,
    anonymizedOrderEvents: anonymizedOrderEvents.count,
    deletedPoints: deletedPoints.count,
    cutoff,
  };
}

export function startTrackingMaintenance() {
  if (initialTimer || intervalTimer) return;
  const run = () => void runTrackingMaintenance()
    .then((result) => console.log('[tracking-v2] maintenance complete', result))
    .catch((error) => console.warn('[tracking-v2] maintenance failed', error));
  initialTimer = setTimeout(() => {
    initialTimer = null;
    run();
    intervalTimer = setInterval(run, RUN_INTERVAL_MS);
    intervalTimer.unref?.();
  }, 5 * 60_000);
  initialTimer.unref?.();
}

export function stopTrackingMaintenance() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
}
