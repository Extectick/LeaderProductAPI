import prisma from '../../prisma/client';

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export function startCrashRetention() {
  if (timer || process.env.APP_CRASH_REPORTING_ENABLED !== 'true') return;
  // Bounded hourly batches avoid long transactions on the business database.
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const expired = await prisma.appCrashEvent.findMany({
        where: { occurredAt: { lt: new Date(Date.now() - 30 * 86400000) } },
        select: { id: true }, take: 5000, orderBy: { occurredAt: 'asc' },
      });
      if (expired.length) await prisma.appCrashEvent.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
    } catch { console.warn('[monitoring] retention deferred'); }
    finally { running = false; }
  }, 3600000);
  timer.unref();
}

export function stopCrashRetention() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
