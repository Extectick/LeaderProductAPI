import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {pool} from '../../prisma/client';
import {validateOnecProofs, type OnecProof} from '../onec-personal/service';
import {HelpError} from './help.service';
import {canReadScheduleStock} from './help.schedule-stock-access';
import {nextHelpScheduleTime,scheduleDraft,type ScheduleDraft} from './help.schedule-time';

type TaskRow = ScheduleDraft & {id:string; ownerId:number; ticketId:number; messageId:number; active:boolean; due:Date; revision:number; deletedAt:Date|null; cancelled:boolean};
type RunRow = {id:string; scheduleId:string; finishedAt:Date; slot:Date|null; status:'alert'|'clear'|'error'; rows:unknown; truncated:boolean; error:string|null; readAt:Date|null; onecProof:OnecProof|null};
const PAGE = 20;
const notFound = () => new HelpError(404,'HELP_SCHEDULE_NOT_FOUND','Задание не найдено');
const conflict = () => new HelpError(409,'HELP_SCHEDULE_DECIDED','Для этого предложения решение уже сохранено.');
const terminal = "r.status IN ('alert','clear','error') AND r.\"finishedAt\" IS NOT NULL";

async function transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T> {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const result=await work(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

function createProofChecker(owner:number) {
  let stockAccess: Promise<boolean> | undefined;
  const cache = new Map<string,Promise<boolean>>();
  return (proof:OnecProof|null) => {
    if (!proof) return Promise.resolve(false);
    const key=JSON.stringify(proof);
    let check=cache.get(key);
    if (!check) {
      stockAccess ??= canReadScheduleStock(owner);
      check=stockAccess.then(async allowed => {
        if (!allowed) return false;
        try { await validateOnecProofs(owner,[proof]); return true; }
        catch { return false; }
      });
      cache.set(key,check);
    }
    return check;
  };
}
async function runDto(r:RunRow,allowed:ReturnType<typeof createProofChecker>) {
  const visible = r.status==='error' || await allowed(r.onecProof);
  const needsConnection = r.status==='error' && r.error==='ONEC_AUTH_REQUIRED';
  const error = needsConnection ? 'Подключите личную 1С в профиле и повторите проверку.' : r.error;
  return {id:r.id,taskId:r.scheduleId,at:r.finishedAt.getTime(),slot:r.slot?.getTime()??null,
    status:visible?r.status:'error',rows:visible?r.rows:[],truncated:visible&&r.truncated,
    unread:visible&&r.status==='alert'&&!r.readAt,errorCode:needsConnection?'ONEC_AUTH_REQUIRED':undefined,
    error:visible?error:'Для просмотра отчёта требуется действующий доступ к источнику.'};
}
function taskDto(row:TaskRow,runs:Awaited<ReturnType<typeof runDto>>[]=[],hasMoreRuns=false) {
  return {id:row.id,ticketId:row.ticketId,messageId:row.messageId,active:row.active,time:row.time,timeZone:row.timeZone,
    warehouse:row.warehouse,metric:row.metric,due:row.due.getTime(),runs,hasMoreRuns};
}
async function ownedTask(db:PoolClient,owner:number,id:string) {
  const {rows}=await db.query<TaskRow>('SELECT * FROM "HelpSchedule" WHERE id=$1 AND "ownerId"=$2 AND "deletedAt" IS NULL FOR UPDATE',[id,owner]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function listSchedules(owner:number) {
  // Use an MVCC snapshot so counters, proposal receipts and rows describe the same revision.
  const {tasks,runs,unread} = await transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tasks=(await db.query<TaskRow>('SELECT * FROM "HelpSchedule" WHERE "ownerId"=$1 ORDER BY "createdAt" DESC,id DESC',[owner])).rows;
    const runs=(await db.query<RunRow>(`SELECT recent.* FROM "HelpSchedule" s CROSS JOIN LATERAL (
      SELECT r.* FROM "HelpScheduleRun" r WHERE r."scheduleId"=s.id AND ${terminal}
      ORDER BY r."finishedAt" DESC,r.id DESC LIMIT $2) recent WHERE s."ownerId"=$1 AND s."deletedAt" IS NULL
      ORDER BY recent."finishedAt" DESC,recent.id DESC`,[owner,PAGE+1])).rows;
    const unread=(await db.query<Pick<RunRow,'scheduleId'|'onecProof'>>(`SELECT DISTINCT r."scheduleId",r."onecProof"
      FROM "HelpScheduleRun" r JOIN "HelpSchedule" s ON s.id=r."scheduleId"
      WHERE s."ownerId"=$1 AND s."deletedAt" IS NULL AND r.status='alert' AND r."readAt" IS NULL`,[owner])).rows;
    return {tasks,runs,unread};
  });
  const check=createProofChecker(owner);
  const unreadTasks=new Set<string>();
  for (const r of unread) if (await check(r.onecProof)) unreadTasks.add(r.scheduleId);
  const byTask=new Map<string,RunRow[]>();
  for (const r of runs) {
    const group=byTask.get(r.scheduleId);
    if (group) group.push(r); else byTask.set(r.scheduleId,[r]);
  }
  const decisions:Record<string,'cancelled'|'deleted'>={};
  const items=[];
  for (const task of tasks) {
    if (task.deletedAt) { decisions[String(task.messageId)]=task.cancelled?'cancelled':'deleted'; continue; }
    const group=byTask.get(task.id)??[];
    const recent=await Promise.all(group.slice(0,PAGE).map(r=>runDto(r,check)));
    items.push(taskDto(task,recent,group.length>PAGE));
  }
  return {tasks:items,activeTaskCount:items.filter(t=>t.active).length,unreadTaskCount:unreadTasks.size,decisions};
}

export async function decideSchedule(owner:number,ticketId:number,messageId:number,draft?:ScheduleDraft) {
  return transaction(async db=>{
    // Both decisions lock the same server-authored message before testing its one-time receipt.
    const {rows}=await db.query<{proposal:unknown}>(`SELECT m."assistantState"->'scheduleDraft' AS proposal FROM "HelpMessage" m
      JOIN "HelpTicket" t ON m."ticketId"=t.id WHERE t.id=$1 AND t."ownerId"=$2 AND m.id=$3 AND m."authorId" IS NULL
      AND m."authorRole"='SYSTEM' AND m."assistantState"->>'status'='completed' FOR UPDATE OF m`,[ticketId,owner,messageId]);
    if (!rows[0]) throw notFound();
    const parsed=scheduleDraft.safeParse(rows[0].proposal);
    if (!parsed.success) throw new HelpError(400,'HELP_SCHEDULE_PROPOSAL_REQUIRED','В сообщении нет предложения создать задание.');
    const existing=(await db.query<TaskRow>('SELECT * FROM "HelpSchedule" WHERE "messageId"=$1 AND "ownerId"=$2 FOR UPDATE',[messageId,owner])).rows[0];
    if (existing) {
      if (draft && !existing.deletedAt) return taskDto(existing);
      if (!draft && existing.cancelled) return {ok:true};
      throw conflict();
    }
    const d=draft??parsed.data;
    const args=[randomUUID(),owner,ticketId,messageId,d.time,d.timeZone,d.warehouse,d.metric,
      nextHelpScheduleTime(d.time,d.timeZone,new Date()),!draft];
    const saved=(await db.query<TaskRow>(`INSERT INTO "HelpSchedule"
      (id,"ownerId","ticketId","messageId",time,"timeZone",warehouse,metric,due,active,"deletedAt",cancelled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOT $10,CASE WHEN $10 THEN now() END,$10) RETURNING *`,args)).rows[0];
    return draft?taskDto(saved):{ok:true};
  });
}

export async function editSchedule(owner:number,id:string,patch:Partial<ScheduleDraft>&{active?:boolean}) {
  return transaction(async db=>{
    const prev=await ownedTask(db,owner,id);
    const d={...prev,...patch};
    if (d.time===prev.time && d.timeZone===prev.timeZone && d.metric===prev.metric && d.warehouse===prev.warehouse && d.active===prev.active) return taskDto(prev);
    const due=nextHelpScheduleTime(d.time,d.timeZone,new Date());
    const {rows}=await db.query<TaskRow>(`UPDATE "HelpSchedule" SET time=$2,"timeZone"=$3,warehouse=$4,metric=$5,
      active=$6,due=$7,revision=revision+1 WHERE id=$1 RETURNING *`,[id,d.time,d.timeZone,d.warehouse,d.metric,d.active,due]);
    return taskDto(rows[0]);
  });
}
export async function removeSchedule(owner:number,id:string) {
  const {rowCount}=await pool.query(`UPDATE "HelpSchedule" SET active=false,revision=revision+CASE WHEN "deletedAt" IS NULL THEN 1 ELSE 0 END,
    "deletedAt"=coalesce("deletedAt",now()) WHERE id=$1 AND "ownerId"=$2 AND NOT cancelled`,[id,owner]);
  if (!rowCount) throw notFound();
  return {ok:true};
}
export async function queueSchedule(owner:number,id:string,request:string) {
  return transaction(async db=>{
    const task=await ownedTask(db,owner,id);
    await db.query(`INSERT INTO "HelpScheduleRun" (id,"scheduleId",revision,"requestId") VALUES ($1,$2,$3,$4)
      ON CONFLICT ("scheduleId","requestId") DO NOTHING`,[randomUUID(),id,task.revision,request]);
    return {ok:true};
  });
}

export async function historyPage(owner:number,taskId?:string,before?:string) {
  if (taskId && !(await pool.query('SELECT id FROM "HelpSchedule" WHERE id=$1 AND "ownerId"=$2 AND "deletedAt" IS NULL',[taskId,owner])).rowCount) throw notFound();
  const {rows}=await pool.query<RunRow>(`SELECT r.* FROM "HelpScheduleRun" r JOIN "HelpSchedule" s ON s.id=r."scheduleId"
    WHERE s."ownerId"=$1 AND s."deletedAt" IS NULL AND ${terminal}
    AND (CASE WHEN $2::text IS NULL THEN r.status='alert' ELSE s.id=$2 END)
    AND ($3::text IS NULL OR (r."finishedAt",r.id)<(SELECT p."finishedAt",p.id FROM "HelpScheduleRun" p
      JOIN "HelpSchedule" parent ON p."scheduleId"=parent.id WHERE p.id=$3 AND parent."ownerId"=$1 AND parent."deletedAt" IS NULL
      AND (CASE WHEN $2::text IS NULL THEN p.status='alert' ELSE parent.id=$2 END)))
    ORDER BY r."finishedAt" DESC,r.id DESC LIMIT $4`,[owner,taskId??null,before??null,PAGE+1]);
  const check=createProofChecker(owner);
  return {runs:await Promise.all(rows.slice(0,PAGE).map(r=>runDto(r,check))),hasMore:rows.length>PAGE};
}
export async function readScheduleResults(owner:number,ids:string[]) {
  await pool.query(`UPDATE "HelpScheduleRun" r SET "readAt"=now() FROM "HelpSchedule" s
    WHERE s.id=r."scheduleId" AND s."ownerId"=$1 AND s."deletedAt" IS NULL
      AND r.id=ANY($2::text[]) AND r.status='alert' AND r."readAt" IS NULL`,[owner,ids]);
  return {ok:true};
}
