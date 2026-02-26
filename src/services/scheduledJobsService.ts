import prisma from '../prisma/client';
import { dispatchNotification } from './notificationService';
import { tplUnreadReminder, tplClosureReminder } from './notificationTemplates';

const UNREAD_REMINDER_HOURS  = Number(process.env.UNREAD_REMINDER_HOURS  || 4);
const CLOSURE_REMINDER_HOURS = Number(process.env.CLOSURE_REMINDER_HOURS || 24);
const JOB_POLL_INTERVAL_MS   = Number(process.env.JOB_POLL_INTERVAL_MS   || 60_000);

const JOB_QUEUE_KEY = 'jobs:notifications:scheduled';
const MANAGER_ALERT_CHECK_MS = Number(process.env.MANAGER_ALERT_CHECK_MS || 10 * 60_000);
const MANAGER_ALERT_LAST_KEY = 'jobs:notifications:manager-alert:last-run';

type JobType = 'UNREAD_REMINDER' | 'CLOSURE_REMINDER';

interface ScheduledJob {
  type: JobType;
  appealId: number;
  scheduledFor: number; // Unix ms
}

// ---- Helpers для безопасного получения Redis ----

function tryGetRedis() {
  try {
    const { getRedis } = require('../lib/redis');
    const r = getRedis();
    return r.isOpen ? r : null;
  } catch {
    return null;
  }
}

// ---- Публичный API ----

export async function scheduleUnreadReminder(
  appealId: number,
  fromNowMs = UNREAD_REMINDER_HOURS * 3_600_000
): Promise<void> {
  await scheduleJob({ type: 'UNREAD_REMINDER', appealId, scheduledFor: Date.now() + fromNowMs });
}

export async function scheduleClosureReminder(
  appealId: number,
  fromNowMs = CLOSURE_REMINDER_HOURS * 3_600_000
): Promise<void> {
  await scheduleJob({ type: 'CLOSURE_REMINDER', appealId, scheduledFor: Date.now() + fromNowMs });
}

/** Отменить все запланированные задачи для обращения */
export async function cancelAppealJobs(appealId: number): Promise<void> {
  const redis = tryGetRedis();
  if (!redis) return;

  let cursor = 0;
  do {
    const result = await redis.zScan(JOB_QUEUE_KEY, cursor, {
      MATCH: `*"appealId":${appealId}*`,
      COUNT: 100,
    });
    cursor = result.cursor;
    const toRemove: string[] = result.members
      .filter((m: { value: string }) => {
        try {
          return JSON.parse(m.value).appealId === appealId;
        } catch {
          return false;
        }
      })
      .map((m: { value: string }) => m.value);
    if (toRemove.length) {
      await redis.zRem(JOB_QUEUE_KEY, toRemove);
    }
  } while (cursor !== 0);
}

// ---- Внутренняя реализация ----

async function scheduleJob(job: ScheduledJob): Promise<void> {
  const redis = tryGetRedis();
  if (!redis) return;
  const member = JSON.stringify({ type: job.type, appealId: job.appealId });
  await redis.zAdd(JOB_QUEUE_KEY, { score: job.scheduledFor, value: member });
}

async function processDueJobs(): Promise<void> {
  const redis = tryGetRedis();
  if (!redis) return;

  const now = Date.now();
  const dueMembers: string[] = await redis.zRangeByScore(JOB_QUEUE_KEY, '-inf', now);
  if (!dueMembers.length) return;

  await redis.zRemRangeByScore(JOB_QUEUE_KEY, '-inf', now);

  for (const member of dueMembers) {
    try {
      const job: ScheduledJob = JSON.parse(member);
      await processJob(job);
    } catch (err: any) {
      console.error('[scheduled-jobs] failed to process job', member, err?.message);
    }
  }

  await processManagerAnalyticsAlerts();
}

async function processManagerAnalyticsAlerts(): Promise<void> {
  const redis = tryGetRedis();
  if (redis) {
    const last = await redis.get(MANAGER_ALERT_LAST_KEY);
    const now = Date.now();
    if (last && now - Number(last) < MANAGER_ALERT_CHECK_MS) return;
    await redis.set(MANAGER_ALERT_LAST_KEY, String(now));
  }

  const thresholds = await (prisma as any).appealAnalyticsThreshold.findMany({
    include: { department: { select: { id: true, name: true } } },
  });
  for (const t of thresholds) {
    const managerIds = (
      await prisma.departmentRole.findMany({
        where: { departmentId: t.departmentId, role: { name: 'department_manager' } },
        select: { userId: true },
      })
    ).map((x) => x.userId);
    if (!managerIds.length) continue;

    const openBoundary = new Date(Date.now() - t.openTooLongHours * 3600_000);
    const resolvedBoundary = new Date(Date.now() - t.resolvedTooLongHours * 3600_000);
    const laborBoundary = new Date(Date.now() - t.laborMissingDays * 24 * 3600_000);

    const staleOpen = await prisma.appeal.findFirst({
      where: { toDepartmentId: t.departmentId, status: 'OPEN', createdAt: { lte: openBoundary } },
      select: { id: true, number: true },
      orderBy: { createdAt: 'asc' },
    });
    if (staleOpen) {
      await dispatchNotification({
        type: 'UNREAD_REMINDER',
        appealId: staleOpen.id,
        appealNumber: staleOpen.number,
        title: `Обращение #${staleOpen.number}`,
        body: `Долго в OPEN (> ${t.openTooLongHours} ч)`,
        telegramText: `⚠️ Обращение #${staleOpen.number} долго в OPEN (> ${t.openTooLongHours} ч)`,
        maxText: `⚠️ Обращение #${staleOpen.number} долго в OPEN (> ${t.openTooLongHours} ч)`,
        channels: ['telegram', 'max'],
        recipientUserIds: managerIds,
      });
    }

    const staleResolved = await prisma.appeal.findFirst({
      where: { toDepartmentId: t.departmentId, status: 'RESOLVED' },
      select: { id: true, number: true, statusHistory: { where: { newStatus: 'RESOLVED' }, orderBy: { changedAt: 'asc' }, take: 1 } },
    });
    if (staleResolved?.statusHistory?.[0] && staleResolved.statusHistory[0].changedAt <= resolvedBoundary) {
      await dispatchNotification({
        type: 'CLOSURE_REMINDER',
        appealId: staleResolved.id,
        appealNumber: staleResolved.number,
        title: `Обращение #${staleResolved.number}`,
        body: `Долго без закрытия после RESOLVED (> ${t.resolvedTooLongHours} ч)`,
        telegramText: `⚠️ Обращение #${staleResolved.number} долго без закрытия после RESOLVED (> ${t.resolvedTooLongHours} ч)`,
        maxText: `⚠️ Обращение #${staleResolved.number} долго без закрытия после RESOLVED (> ${t.resolvedTooLongHours} ч)`,
        channels: ['telegram', 'max'],
        recipientUserIds: managerIds,
      });
    }

    const laborMissingAppeal = await prisma.appeal.findFirst({
      where: {
        toDepartmentId: t.departmentId,
        createdAt: { lte: laborBoundary },
        assignees: { some: {} },
        laborEntries: { none: {} },
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'asc' },
    });
    if (laborMissingAppeal) {
      await dispatchNotification({
        type: 'NEW_APPEAL',
        appealId: laborMissingAppeal.id,
        appealNumber: laborMissingAppeal.number,
        title: `Обращение #${laborMissingAppeal.number}`,
        body: `Не проставлены часы более ${t.laborMissingDays} дн.`,
        telegramText: `⚠️ Для обращения #${laborMissingAppeal.number} не проставлены часы более ${t.laborMissingDays} дн.`,
        maxText: `⚠️ Для обращения #${laborMissingAppeal.number} не проставлены часы более ${t.laborMissingDays} дн.`,
        channels: ['telegram', 'max'],
        recipientUserIds: managerIds,
      });
    }
  }
}

async function processJob(job: ScheduledJob): Promise<void> {
  if (job.type === 'UNREAD_REMINDER') {
    await processUnreadReminder(job.appealId);
  } else if (job.type === 'CLOSURE_REMINDER') {
    await processClosureReminder(job.appealId);
  }
}

async function processUnreadReminder(appealId: number): Promise<void> {
  const appeal = await prisma.appeal.findUnique({
    where: { id: appealId },
    include: {
      assignees: { select: { userId: true } },
      toDepartment: {
        include: {
          departmentRoles: { select: { userId: true } },
        },
      },
      messages: {
        where: { deleted: false, type: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { reads: { select: { userId: true } } },
      },
    },
  });

  if (!appeal) return;
  if (!['OPEN', 'IN_PROGRESS'].includes(appeal.status)) return;

  const lastMsg = appeal.messages[0];
  if (!lastMsg) return;
  if (lastMsg.reads.length > 0) return; // кто-то уже прочитал

  // Проверить порог давности
  const threshold = Date.now() - UNREAD_REMINDER_HOURS * 3_600_000;
  if (lastMsg.createdAt.getTime() > threshold) return;

  const employeeDeptMembers = await prisma.employeeProfile.findMany({
    where: { departmentId: appeal.toDepartmentId },
    select: { userId: true },
  });
  const deptUserIds = Array.from(
    new Set([
      ...(appeal.toDepartment?.departmentRoles ?? []).map((r) => r.userId),
      ...employeeDeptMembers.map((m) => m.userId),
    ])
  );
  const assigneeIds = appeal.assignees.map((a) => a.userId);
  const recipients = Array.from(new Set([...deptUserIds, ...assigneeIds]));

  await dispatchNotification({
    type: 'UNREAD_REMINDER',
    appealId,
    appealNumber: appeal.number,
    title: `Обращение #${appeal.number}`,
    body: `Непрочитанные сообщения уже ${UNREAD_REMINDER_HOURS} ч`,
    telegramText: tplUnreadReminder({
      appealId,
      number: appeal.number,
      hoursUnread: UNREAD_REMINDER_HOURS,
      channel: 'telegram',
    }),
    maxText: tplUnreadReminder({
      appealId,
      number: appeal.number,
      hoursUnread: UNREAD_REMINDER_HOURS,
      channel: 'max',
    }),
    channels: ['telegram', 'max'],
    recipientUserIds: recipients,
  });
}

async function processClosureReminder(appealId: number): Promise<void> {
  const appeal = await prisma.appeal.findUnique({
    where: { id: appealId },
    select: { id: true, number: true, status: true, createdById: true },
  });

  if (!appeal) return;
  if (!['RESOLVED', 'COMPLETED'].includes(appeal.status)) return;

  await dispatchNotification({
    type: 'CLOSURE_REMINDER',
    appealId,
    appealNumber: appeal.number,
    title: `Обращение #${appeal.number}`,
    body: `Ожидает вашего закрытия уже ${CLOSURE_REMINDER_HOURS} ч`,
    telegramText: tplClosureReminder({
      appealId,
      number: appeal.number,
      hoursWaiting: CLOSURE_REMINDER_HOURS,
      channel: 'telegram',
    }),
    maxText: tplClosureReminder({
      appealId,
      number: appeal.number,
      hoursWaiting: CLOSURE_REMINDER_HOURS,
      channel: 'max',
    }),
    channels: ['telegram', 'max'],
    recipientUserIds: [appeal.createdById],
  });
}

// ---- Жизненный цикл ----

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduledJobs(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void processDueJobs().catch((err) => {
      console.error('[scheduled-jobs] poll error:', err?.message);
    });
  }, JOB_POLL_INTERVAL_MS);
  console.log(
    `[scheduled-jobs] started, interval=${JOB_POLL_INTERVAL_MS}ms, ` +
    `unread=${UNREAD_REMINDER_HOURS}h, closure=${CLOSURE_REMINDER_HOURS}h`
  );
}

export function stopScheduledJobs(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[scheduled-jobs] stopped');
  }
}
