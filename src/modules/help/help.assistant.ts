import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { HelpError, helpActor, helpTransaction, requireHelpTicket, publishHelpEvent } from './help.service';

type Tx = Prisma.TransactionClient;
const ACTIVE = ['QUEUED','RUNNING'];
export function helpAssistantConfiguration() {
  const provider = process.env.HELP_AI_PROVIDER || 'disabled';
  const enabled = process.env.HELP_AI_ENABLED === 'true' && provider === 'simulator' && process.env.NODE_ENV !== 'production';
  const durationMs = Math.min(900000, Math.max(500, Number(process.env.HELP_AI_SIMULATOR_DURATION_MS) || 5000));
  return { enabled, provider, durationMs };
}
const state = (job:any, status:string, eventId:number) => ({
  runId:job.id, taskId:job.taskId, ticketId:job.ticketId, eventId, status,
  step:Math.min(3,job.step), completedSteps:status==='completed'?4:job.step,
  startedAt:new Date(job.createdAt).getTime(),updatedAt:Date.now(),
  taskStartSequence:job.contextStartSequence,contextMessageCount:Array.isArray(job.context)?job.context.length:1,
});
async function updateState(db:Tx,job:any,status:string,extra:Record<string,unknown>={}) {
  const event=await publishHelpEvent(db,job.ticketId,null,status==='completed'?'MESSAGE_CREATED':'ASSISTANT_UPDATED',job.messageId);
  await db.helpMessage.update({where:{id:job.messageId},data:{assistantState:{...state(job,status,event.id),...extra}}});
  return event;
}
/** Called in the same transaction as the owner's accepted input. */
export async function enqueueHelpAssistant(db:Tx,ticketId:number,ownerId:number,sourceSequence:number) {
  const config=helpAssistantConfiguration();if(!config.enabled)return;
  const ticket=await db.helpTicket.findUniqueOrThrow({where:{id:ticketId},include:{members:true}});
  if(ticket.status!=='OPEN'||ticket.ownerId!==ownerId||ticket.itRequested||ticket.members.some(member=>member.role==='IT'))return;
  const previous=await db.helpAssistantJob.findFirst({where:{ticketId,status:{in:ACTIVE}},orderBy:{createdAt:'desc'}});
  if(previous){
    await db.helpAssistantJob.update({where:{id:previous.id},data:{status:'SUPERSEDED',leaseToken:null,leaseUntil:null}});
    await updateState(db,previous,'stopped',{stopReason:'superseded'});
  }
  const contextStartSequence=previous?.contextStartSequence??sourceSequence;
  const inputs=await db.helpMessage.findMany({where:{ticketId,authorId:ownerId,sequence:{gte:contextStartSequence},kind:'TEXT'},orderBy:{sequence:'asc'},select:{id:true,text:true,sequence:true}});
  const id=randomUUID(),taskId=previous?.taskId??id;
  const incremented=await db.helpTicket.update({where:{id:ticketId},data:{messageSequence:{increment:1}}});
  const message=await db.helpMessage.create({data:{ticketId,authorId:null,authorRole:'SYSTEM',kind:'ASSISTANT_PROGRESS',clientMessageId:`ai:${id}`,requestHash:id,sequence:incremented.messageSequence}});
  const job=await db.helpAssistantJob.create({data:{id,taskId,ticketId,ownerId,messageId:message.id,revision:(previous?.revision??0)+1,contextStartSequence,context:inputs,provider:config.provider,durationMs:config.durationMs,nextAt:new Date(Date.now()+config.durationMs/4)}});
  await updateState(db,job,'thinking');
}
export async function cancelHelpAssistant(db:Tx,ticketId:number,reason='user') {
  const jobs=await db.helpAssistantJob.findMany({where:{ticketId,status:{in:ACTIVE}}});
  for(const job of jobs){await db.helpAssistantJob.update({where:{id:job.id},data:{status:'STOPPED',leaseToken:null,leaseUntil:null}});await updateState(db,job,'stopped',{stopReason:reason});}
}
export async function controlHelpAssistant(ticketId:number,actor:{userId:number;canManage:boolean},runId:string,retry:boolean) {
  return helpTransaction(ticketId,async db=>{
    const ticket=await requireHelpTicket(db,ticketId,actor,false);
    if(ticket.ownerId!==actor.userId)throw new HelpError(403,'HELP_FORBIDDEN','Управление ответом доступно автору обращения');
    const job=await db.helpAssistantJob.findFirst({where:{id:runId,ticketId}});
    if(!job)throw new HelpError(404,'HELP_RUN_NOT_FOUND','Ответ ИИ не найден');
    if(!retry){if(ACTIVE.includes(job.status))await cancelHelpAssistant(db,ticketId);return;}
    if(ACTIVE.includes(job.status)||job.status==='COMPLETED')return;
    if(!helpAssistantConfiguration().enabled||ticket.status!=='OPEN'||ticket.itRequested||ticket.members.some(member=>member.role==='IT'))throw new HelpError(409,'HELP_AI_UNAVAILABLE','ИИ недоступен для этого обращения');
    const newer=await db.helpAssistantJob.findFirst({where:{ticketId,createdAt:{gt:job.createdAt}}});
    if(newer)throw new HelpError(409,'HELP_RUN_SUPERSEDED','Для обращения уже создан более новый ответ');
    const next=await db.helpAssistantJob.update({where:{id:job.id},data:{status:'QUEUED',step:0,attempts:0,errorCode:null,leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+job.durationMs/4)}});
    await updateState(db,next,'thinking');
  });
}
export type HelpAssistantProvider = (context:unknown,signal:AbortSignal)=>Promise<string>;
/** Simulator exercises the durable server pipeline; it never runs in production. */
export const simulateHelpAnswer:HelpAssistantProvider=async context=>{
  const text=Array.isArray(context)?context.map(item=>String(item.text||'')).join('\n'):'';
  if(/принтер|печата/i.test(text))return 'Проверьте питание принтера, наличие бумаги и подключение. Откройте очередь печати и удалите зависшие задания. Затем попробуйте пробную страницу. Если печать не восстановилась, пришлите модель принтера и текст ошибки — подключим IT.';
  return 'Проверьте подключение к сети и повторите действие. Запишите текст ошибки и приложите снимок экрана. Если проблема сохраняется, уточните, на каком шаге она возникает, чтобы выбрать следующий шаг или подключить специалиста IT.';
};
/** One fenced step, exported so integration tests can verify crash/restart semantics. */
export async function processHelpAssistantJob(jobId:string,leaseToken:string,provider:HelpAssistantProvider=simulateHelpAnswer) {
  const initial=await prisma.helpAssistantJob.findUnique({where:{id:jobId}});
  if(!initial||initial.leaseToken!==leaseToken||!ACTIVE.includes(initial.status))return false;
  let answer:string|undefined;
  try {
    await helpActor(initial.ownerId);
    if(initial.step>=3){
      if(initial.provider!=='simulator'||process.env.NODE_ENV==='production')throw new HelpError(503,'HELP_AI_PROVIDER_UNAVAILABLE','Провайдер ИИ не настроен');
      answer=await provider(initial.context,AbortSignal.timeout(60000));
      if(!answer.trim()||answer.length>20000)throw new HelpError(502,'HELP_AI_INVALID_ANSWER','Неверный ответ провайдера');
    }
    return await helpTransaction(initial.ticketId,async db=>{
      const job=await db.helpAssistantJob.findUnique({where:{id:jobId}});
      if(!job||job.leaseToken!==leaseToken||!ACTIVE.includes(job.status)||!job.leaseUntil||job.leaseUntil.getTime()<Date.now())return false;
      const ticket=await db.helpTicket.findUniqueOrThrow({where:{id:job.ticketId},include:{members:true}});
      if(ticket.status!=='OPEN'||ticket.itRequested||ticket.members.some(member=>member.role==='IT')){await cancelHelpAssistant(db,ticket.id,'handoff');return false;}
      if(answer!==undefined){
        const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:'COMPLETED',step:4,leaseToken:null,leaseUntil:null,completedAt:new Date()}});
        if(!claimed.count)return false;
        const next=await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});
        await db.helpMessage.update({where:{id:job.messageId},data:{text:answer,kind:'TEXT'}});
        await db.helpTicket.update({where:{id:job.ticketId},data:{updatedAt:new Date()}});
        await updateState(db,next,'completed');
      }else{
        const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:'QUEUED',step:job.step+1,attempts:0,leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+job.durationMs/4)}});
        if(!claimed.count)return false;
        const next=await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});
        await updateState(db,next,'thinking');
      }
      return true;
    });
  }catch(error:any){
    await helpTransaction(initial.ticketId,async db=>{
      const job=await db.helpAssistantJob.findUnique({where:{id:jobId}});if(!job||job.leaseToken!==leaseToken||!ACTIVE.includes(job.status))return;
      const denied=error?.status===403||error?.status===404;
      const failed=denied||job.attempts>=5||error?.code==='HELP_AI_PROVIDER_UNAVAILABLE';
      const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:failed?'ERROR':'QUEUED',errorCode:denied?'HELP_FORBIDDEN':error?.code||'HELP_AI_RETRY',leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+Math.min(60000,1000*2**job.attempts))}});
      if(failed&&claimed.count)await updateState(db,await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}}),'error');
    });
    return false;
  }
}
export async function claimHelpAssistantJob() {
  const token=randomUUID();
  const jobs=await prisma.$queryRaw<Array<{id:string}>>`UPDATE "HelpAssistantJob" SET "status"='RUNNING',"leaseToken"=${token},"leaseUntil"=NOW()+INTERVAL '90 seconds',"attempts"="attempts"+1,"updatedAt"=NOW() WHERE "id"=(SELECT "id" FROM "HelpAssistantJob" WHERE "status" IN ('QUEUED','RUNNING') AND "nextAt"<=NOW() AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW()) ORDER BY "nextAt","id" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING "id"`;
  return jobs[0]?{id:jobs[0].id,leaseToken:token}:null;
}
export async function tickHelpAssistantWorker(provider?:HelpAssistantProvider) {
  if(!helpAssistantConfiguration().enabled)return false;
  const job=await claimHelpAssistantJob();if(!job)return false;
  return processHelpAssistantJob(job.id,job.leaseToken,provider);
}
export function startHelpAssistantWorker() {
  if(!helpAssistantConfiguration().enabled)return async()=>{};
  let stopped=false,busy=false,inFlight:Promise<void>=Promise.resolve();
  const tick=()=>{
    if(stopped||busy)return;
    busy=true;
    inFlight=(async()=>{try{await tickHelpAssistantWorker();}catch(error:any){console.error('[help-ai] worker retry',{code:error?.code||'UNKNOWN'});}finally{busy=false;}})();
  };
  const timer=setInterval(tick,250);tick();
  return async()=>{stopped=true;clearInterval(timer);await inFlight;};
}
