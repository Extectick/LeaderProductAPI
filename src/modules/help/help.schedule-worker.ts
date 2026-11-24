import {randomUUID} from 'node:crypto';
import {Expo} from 'expo-server-sdk';
import prisma from '../../prisma/client';
import {OnecPersonalError} from '../onec-personal/config';
import {type OnecProof, validateOnecProofs} from '../onec-personal/service';
import {sendHelpPushToUser} from './help.push';
import {canReadScheduleStock} from './help.schedule-stock-access';
import {nextHelpScheduleTime} from './help.schedule-time';
import {readScheduleStock, ScheduleStockError, type ScheduleStockMetric, type ScheduleStockResult} from './help.schedule-stock';
import {helpActor} from './help.service';

type Due = {id: string; due: Date; revision: number; time: string; timeZone: string; now: Date};
type Claim = {id: string; scheduleId: string; ownerId: number; metric: ScheduleStockMetric; warehouse: string; leaseToken: string; attempts: number};
type PendingPush = {id: string; scheduleId: string; ownerId: number; ticketId: number; onecProof: OnecProof};
const changed = 'Проверка отменена после изменения задания.';

async function enqueueDue() {
  await prisma.$transaction(async tx => {
    const due = await tx.$queryRaw<Due[]>`SELECT id, due, revision, time, "timeZone", CURRENT_TIMESTAMP AS now
      FROM "HelpSchedule" WHERE active AND "deletedAt" IS NULL AND due <= CURRENT_TIMESTAMP
      ORDER BY due, id LIMIT 12 FOR UPDATE SKIP LOCKED`;
    for (const task of due) {
      // Coalesce missed days after downtime. This is a live balance, not historical stock at the missed hour.
      const next = nextHelpScheduleTime(task.time, task.timeZone, task.now);
      await tx.$executeRaw`INSERT INTO "HelpScheduleRun"(id,"scheduleId",revision,slot)
        VALUES (${randomUUID()},${task.id},${task.revision},${task.due})
        ON CONFLICT ("scheduleId",slot) DO NOTHING`;
      await tx.$executeRaw`UPDATE "HelpSchedule" SET due=${next} WHERE id=${task.id}`;
    }
  });
}

async function claimNext(): Promise<Claim | undefined> {
  const token = randomUUID();
  const [run] = await prisma.$queryRaw<Claim[]>`
    WITH candidate AS (
      SELECT r.id FROM "HelpScheduleRun" r JOIN "HelpSchedule" s ON s.id=r."scheduleId"
      WHERE (r.status='queued' OR (r.status='running' AND r."leaseUntil" <= CURRENT_TIMESTAMP))
        AND s."deletedAt" IS NULL AND r.revision=s.revision AND (r.slot IS NULL OR s.active)
      ORDER BY r."createdAt",r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE "HelpScheduleRun" r SET status='running', "leaseToken"=${token},
      "leaseUntil"=CURRENT_TIMESTAMP+INTERVAL '90 seconds', attempts=attempts+1
    FROM candidate c, "HelpSchedule" s WHERE r.id=c.id AND s.id=r."scheduleId"
    RETURNING r.id,r."scheduleId",r."leaseToken",r.attempts,s."ownerId",s.metric,s.warehouse`;
  return run;
}

function safeRunError(error: unknown) {
  if (error instanceof ScheduleStockError) return error.message;
  if (error instanceof OnecPersonalError && ['ONEC_AUTH_REQUIRED','ONEC_CREDENTIALS_INVALID'].includes(error.code)) {
    return 'ONEC_AUTH_REQUIRED';
  }
  if ((error as {code?:string})?.code === 'HELP_FORBIDDEN' || (error instanceof OnecPersonalError && error.code === 'ONEC_FORBIDDEN')) {
    return 'У сотрудника нет доступа к проверке остатков.';
  }
  return 'Не удалось проверить остатки в 1С. Повторите проверку позже.';
}

async function assertAccess(ownerId: number) {
  await helpActor(ownerId);
  if (!await canReadScheduleStock(ownerId)) throw new ScheduleStockError('Нет доступа к складским остаткам.');
}

async function finish(run: Claim, stock: ScheduleStockResult | null, error: string | null) {
  await prisma.$transaction(async tx => {
    // API edits/deletes lock this same schedule. A finishing run can never publish
    // an old configuration after edit, pause or deletion has taken effect.
    const [schedule] = await tx.$queryRaw<{revision: number; active: boolean; deletedAt: Date | null}[]>`
      SELECT revision,active,"deletedAt" FROM "HelpSchedule" WHERE id=${run.scheduleId} FOR UPDATE`;
    if (!schedule) return;
    if (stock) {
      // Serialize publication with the existing personal 1C connect/disconnect path.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(190154,${run.ownerId}::int)`;
      await validateOnecProofs(run.ownerId, [stock.proof], tx);
    }
    const status = !stock ? 'error' : stock.rows.length ? 'alert' : 'clear';
    await tx.$executeRaw`UPDATE "HelpScheduleRun" SET status=${status},rows=${JSON.stringify(stock?.rows ?? [])}::jsonb,
      error=${error},truncated=${stock?.truncated ?? false},"onecProof"=${stock ? JSON.stringify(stock.proof) : null}::jsonb,
      "finishedAt"=CURRENT_TIMESTAMP,"leaseToken"=NULL,"leaseUntil"=NULL
      WHERE id=${run.id} AND status='running' AND "leaseToken"=${run.leaseToken} AND "leaseUntil">CURRENT_TIMESTAMP
        AND revision=${schedule.revision} AND ${schedule.deletedAt === null} AND (slot IS NULL OR ${schedule.active})`;
  });
}

export async function executeScheduleClaim(run: Claim, signal: AbortSignal) {
  try {
    if (run.attempts > 3) throw new ScheduleStockError('Не удалось завершить проверку. Запустите её повторно.');
    await assertAccess(run.ownerId);
    const stock = await readScheduleStock(run.ownerId, run.metric, run.warehouse, AbortSignal.any([signal, AbortSignal.timeout(55000)]));
    if (signal.aborted) return;
    await assertAccess(run.ownerId);
    await finish(run, stock, null);
  } catch (error) {
    if (!signal.aborted) await finish(run, null, safeRunError(error));
  }
}

async function deliverNext() {
  const [row] = await prisma.$queryRaw<PendingPush[]>`SELECT r.id,r."scheduleId",s."ownerId",s."ticketId",r."onecProof"
    FROM "HelpScheduleRun" r JOIN "HelpSchedule" s ON s.id=r."scheduleId"
    WHERE r.status='alert' AND r."readAt" IS NULL AND r."pushClaimedAt" IS NULL AND s."deletedAt" IS NULL
    ORDER BY r."createdAt",r.id LIMIT 1`;
  if (!row) return false;
  let allowed = true;
  try {
    await assertAccess(row.ownerId);
    if (row.onecProof) await validateOnecProofs(row.ownerId, [row.onecProof]);
    else allowed = false;
  } catch (error) {
    if (error instanceof OnecPersonalError || error instanceof ScheduleStockError || (error as {code?:string})?.code === 'HELP_FORBIDDEN') allowed = false;
    else throw error;
  }
  let tokens: string[] = [];
  if (allowed) {
    const settings = await prisma.userNotificationSettings.findUnique({where:{userId:row.ownerId}});
    if (settings?.inAppNotificationsEnabled !== false && settings?.pushNewMessage !== false) {
      const devices = await prisma.deviceToken.findMany({where:{userId:row.ownerId},select:{token:true}});
      tokens = devices.map(device => device.token).filter(token => Expo.isExpoPushToken(token));
    }
  }
  // Expo has no idempotency key. Reserve the optional device notification once;
  // the authoritative, unread personal report was already published transactionally.
  const claimed = await prisma.$executeRaw`UPDATE "HelpScheduleRun" r SET "pushClaimedAt"=CURRENT_TIMESTAMP
    FROM "HelpSchedule" s WHERE r.id=${row.id} AND s.id=r."scheduleId" AND s."deletedAt" IS NULL
      AND r.status='alert' AND r."readAt" IS NULL AND r."pushClaimedAt" IS NULL`;
  if (claimed && tokens.length) {
    await sendHelpPushToUser(row.ownerId, {title:'Мои задания',body:'Готов отчёт по регламентному заданию.',
      channelId:'help-message',data:{type:'HELP_SCHEDULE_REPORT',scheduleId:row.scheduleId,runId:row.id,
        ticketId:row.ticketId,recipientUserId:row.ownerId}}, {includeTokens:tokens});
  }
  return true;
}

export async function tickHelpSchedules(signal: AbortSignal) {
  await enqueueDue();
  await prisma.$executeRaw`UPDATE "HelpScheduleRun" r SET status='error',error=${changed},"finishedAt"=CURRENT_TIMESTAMP,
    "leaseUntil"=NULL,"leaseToken"=NULL FROM "HelpSchedule" s WHERE s.id=r."scheduleId" AND r.status IN ('queued','running')
    AND (r.revision<>s.revision OR s."deletedAt" IS NOT NULL OR (r.slot IS NOT NULL AND NOT s.active))`;
  const run = await claimNext();
  if (run && !signal.aborted) await executeScheduleClaim(run, signal);
  const sent = !signal.aborted && await deliverNext();
  return Boolean(run || sent);
}

export function startHelpScheduleWorker() {
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const loop = (async () => {
    while (!controller.signal.aborted) {
      let busy = false;
      try { busy = await tickHelpSchedules(controller.signal); }
      catch { if (!controller.signal.aborted) console.error('[help-schedules] worker tick failed'); }
      if (!busy && !controller.signal.aborted) await new Promise<void>(resolve => {
        release = resolve;
        timer = setTimeout(resolve, 5000);
      });
    }
  })();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    release?.();
    await loop;
  };
}
