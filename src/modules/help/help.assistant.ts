import { withHelpPerformance, helpPerformanceSnapshot, timeHelpStage } from './help.performance';
import {createHelpAnalysisEvidenceSink} from './help.analysis-evidence';
import { bunnyConfiguration, HelpBunnyError, prepareHelpBunnyAnswer } from './help.bunny';
import { HelpT3Error, t3Active, t3Configuration } from './help.t3-exchange';
import { prepareHelpT3Answer } from './help.t3';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../prisma/client';
import { HelpError, helpActor, helpTransaction, requireHelpTicket, publishHelpEvent } from './help.service';
import { knowledgeEnabled } from '../knowledge/knowledge.config';
import { HelpGroundedAnswer, prepareHelpKnowledgeAnswer, validateHelpKnowledgeSources } from './help.knowledge';
import { HelpOpenAIError, openAIConfiguration } from './help.openai';
import { prepareHelpOpenAIAnswer } from './help.openai-answer';
import { withHelpAssistantLease } from './help.assistant-lease';
import { onecBases } from '../onec-personal/config';
import { validateOnecProofs } from '../onec-personal/service';
import { createHelpAIProgress, helpAIErrorMessage } from './help.ai-progress';
import { cleanupHelpAIFiles, prepareHelpAIFiles, prepareHelpOfficeFiles, prepareHelpHtmlFiles, type PreparedHelpAIFile } from './help.ai-files';
import { saveHelpContextSummary, helpContextFingerprint, HelpContextError } from './help.context-store';
import {parseHelpClientContext,type HelpClientContext} from './help.chat-context';

type Tx = Prisma.TransactionClient;
const ACTIVE = ['QUEUED','RUNNING'];
export function helpAssistantConfiguration() {
  const provider = process.env.HELP_AI_PROVIDER || 'disabled';
  const enabled = process.env.HELP_AI_ENABLED === 'true' && (provider === 'simulator' && process.env.NODE_ENV !== 'production' ||
    provider === 't3' && t3Configuration().enabled || provider === 'bunny' && bunnyConfiguration().enabled || knowledgeEnabled() && provider === 'knowledge' || provider === 'openai' && (knowledgeEnabled() || onecBases().length > 0) && openAIConfiguration().enabled);
  const durationMs = ['t3', 'bunny', 'knowledge', 'openai'].includes(provider) ? 1000 : Math.min(900000, Math.max(500, Number(process.env.HELP_AI_SIMULATOR_DURATION_MS) || 5000));
  return { enabled, provider, durationMs };
}
const state = (job:any, status:string, eventId:number) => ({
  runId:job.id, taskId:job.taskId, ticketId:job.ticketId, eventId, status,
  step:Math.min(3,job.step), completedSteps:status==='completed'?4:job.step,
  startedAt:new Date(job.createdAt).getTime(),updatedAt:Date.now(),
  taskStartSequence:job.contextStartSequence,contextMessageCount:Array.isArray(job.context)?job.context.length:Array.isArray(job.context?.inputs)?job.context.inputs.length:1,
});
async function updateState(db:Tx,job:any,status:string,extra:Record<string,unknown>={}) {
  const previous = job.provider === 'openai' ? (await db.helpMessage.findUnique({where:{id:job.messageId},select:{assistantState:true}}))?.assistantState as any : null;
  const terminal = ['completed','stopped','error'].includes(status);
  const performance = helpPerformanceSnapshot(job.id);
  const retained = previous?.activityVersion === 1 ? {
    activityVersion: 1, activities: (Array.isArray(previous.activities)?previous.activities:[]).map((item:any) => item.status === 'running' && terminal
      ? {...item,status:status==='completed'?'completed':status==='error'?'failed':'stopped',completedAt:Date.now()} : item),
    draftText: terminal && !(status==='stopped'&&extra.stopReason==='user') ? '' : previous.draftText || '', phase: terminal ? status : previous.phase,
    metrics: {...previous.metrics, ...(performance ? {performance} : {}), startedAt:previous.metrics?.startedAt||new Date(job.createdAt).getTime(), elapsedMs: Date.now() - (previous.metrics?.startedAt || new Date(job.createdAt).getTime())},
  } : job.provider === 'openai' ? {activityVersion:1,activities:[],phase:'queued',draftText:'',...(performance?{metrics:{performance}}:{})} : {};
  const event=await publishHelpEvent(db,job.ticketId,null,status==='completed'?'MESSAGE_CREATED':'ASSISTANT_UPDATED',job.messageId);
  await db.helpMessage.update({where:{id:job.messageId},data:{assistantState:{...state(job,status,event.id),...retained,...extra}}});
  return event;
}
/** Called in the same transaction as the owner's accepted input. */
export async function enqueueHelpAssistant(db:Tx,ticketId:number,ownerId:number,sourceSequence:number,clientContext?:HelpClientContext) {
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
  const client=parseHelpClientContext(clientContext);
  const id=randomUUID(),taskId=previous?.taskId??id;
  const incremented=await db.helpTicket.update({where:{id:ticketId},data:{messageSequence:{increment:1}}});
  const message=await db.helpMessage.create({data:{ticketId,authorId:null,authorRole:'SYSTEM',kind:'ASSISTANT_PROGRESS',clientMessageId:`ai:${id}`,requestHash:id,sequence:incremented.messageSequence}});
  const job=await db.helpAssistantJob.create({data:{id,taskId,ticketId,ownerId,messageId:message.id,revision:(previous?.revision??0)+1,contextStartSequence,context:client&&config.provider==='openai'?{inputs,clientContext:client}:inputs,provider:config.provider,durationMs:config.durationMs,nextAt:new Date(Date.now()+config.durationMs/4)}});
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
    const pendingMessage = await db.helpMessage.findUnique({where:{id:job.messageId},select:{assistantState:true}});
    const awaitingOnec = (pendingMessage?.assistantState as any)?.action?.type === 'connect_onec';
    if(ACTIVE.includes(job.status)||job.status==='COMPLETED'&&!awaitingOnec)return;
    if(!helpAssistantConfiguration().enabled||ticket.status!=='OPEN'||ticket.itRequested||ticket.members.some(member=>member.role==='IT'))throw new HelpError(409,'HELP_AI_UNAVAILABLE','ИИ недоступен для этого обращения');
    const newer=await db.helpAssistantJob.findFirst({where:{ticketId,createdAt:{gt:job.createdAt}}});
    if(newer)throw new HelpError(409,'HELP_RUN_SUPERSEDED','Для обращения уже создан более новый ответ');
    const next=await db.helpAssistantJob.update({where:{id:job.id},data:{status:'QUEUED',step:0,attempts:0,errorCode:null,leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+job.durationMs/4)}});
    if(awaitingOnec)await db.helpMessage.update({where:{id:job.messageId},data:{text:'',kind:'ASSISTANT_PROGRESS'}});
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
export async function processHelpAssistantJob(jobId:string,leaseToken:string,provider:HelpAssistantProvider=simulateHelpAnswer,shutdown?:AbortSignal) {
  const initial=await prisma.helpAssistantJob.findUnique({where:{id:jobId}});
  if(!initial||initial.leaseToken!==leaseToken||!ACTIVE.includes(initial.status))return false;
  return withHelpPerformance(initial, async () => {
  let answer:string|undefined;
  let grounded:HelpGroundedAnswer|undefined;
  let preparedFiles:PreparedHelpAIFile[] = [], filesPublished = false;
  try {
    await helpActor(initial.ownerId);
    // Switching providers must not publish a queued response from the previous mechanism.
    if ((initial.provider === 't3' || process.env.HELP_AI_PROVIDER === 't3') && initial.provider !== process.env.HELP_AI_PROVIDER) {
      throw new HelpError(503,'HELP_AI_PROVIDER_UNAVAILABLE','Провайдер ИИ не настроен');
    }
    if (initial.provider === 't3' && !t3Active()) throw new HelpT3Error('HELP_T3_NOT_CONFIGURED');
    if(initial.step>=3||initial.provider==='openai'){
      if(initial.provider==='t3') {
        grounded=await withHelpAssistantLease(jobId,leaseToken,signal=>prepareHelpT3Answer({id:jobId,ticketId:initial.ticketId,ownerId:initial.ownerId,leaseToken},initial.context,signal),shutdown);
        answer=grounded.text;
      } else if(initial.provider==='bunny') {
        grounded=await withHelpAssistantLease(jobId,leaseToken,signal=>prepareHelpBunnyAnswer(initial.ticketId,initial.ownerId,initial.context,signal),shutdown);
        answer=grounded.text;
      } else if(initial.provider==='openai') {
        grounded=await withHelpAssistantLease(jobId,leaseToken,async signal=>{
          const result=await prepareHelpOpenAIAnswer(initial.ticketId,initial.ownerId,initial.context,signal,
            createHelpAIProgress({id:jobId,ticketId:initial.ticketId,messageId:initial.messageId,leaseToken},signal),
            createHelpAnalysisEvidenceSink({id:jobId,ticketId:initial.ticketId,messageId:initial.messageId,leaseToken},signal));
          if(result.files?.length || result.officeFiles?.length || result.htmlFiles?.length){
            signal.throwIfAborted(); await helpActor(initial.ownerId);
            try{
              if(result.files?.length)preparedFiles=await timeHelpStage('upload',()=>prepareHelpAIFiles({ticketId:initial.ticketId,runId:jobId},result.files!,signal));
              if(result.officeFiles?.length)preparedFiles.push(...await timeHelpStage('upload',()=>prepareHelpOfficeFiles({ticketId:initial.ticketId,runId:jobId},result.officeFiles!,signal,preparedFiles.length)));
              if(result.htmlFiles?.length)preparedFiles.push(...await timeHelpStage('upload',()=>prepareHelpHtmlFiles({ticketId:initial.ticketId,runId:jobId},result.htmlFiles!,signal,preparedFiles.length)));
            }
            catch{throw new HelpOpenAIError('HELP_AI_FILE_UPLOAD',true);}
          }
          return result;
        },shutdown);
        answer=grounded.text;
      } else if(initial.provider==='knowledge') {
        grounded=await prepareHelpKnowledgeAnswer(initial.ticketId,initial.ownerId,initial.context);
        answer=grounded.text;
      } else {
        if(initial.provider!=='simulator'||process.env.NODE_ENV==='production'||process.env.HELP_AI_PROVIDER==='bunny')throw new HelpError(503,'HELP_AI_PROVIDER_UNAVAILABLE','Провайдер ИИ не настроен');
        answer=await provider(initial.context,AbortSignal.timeout(60000));
      }
      if(!answer.trim()||answer.length>20000)throw new HelpError(502,'HELP_AI_INVALID_ANSWER','Неверный ответ провайдера');
    }
    const delivered = await helpTransaction(initial.ticketId,async db=>{
      const job=await db.helpAssistantJob.findUnique({where:{id:jobId}});
      if(!job||job.leaseToken!==leaseToken||!ACTIVE.includes(job.status)||!job.leaseUntil||job.leaseUntil.getTime()<Date.now())return false;
      const ticket=await db.helpTicket.findUniqueOrThrow({where:{id:job.ticketId},include:{members:true}});
      if(ticket.status!=='OPEN'||ticket.itRequested||ticket.members.some(member=>member.role==='IT')){await cancelHelpAssistant(db,ticket.id,'handoff');return false;}
      if(answer!==undefined){
        if(preparedFiles.length && process.env.HELP_AI_PROVIDER !== 'openai') return false;
        if(preparedFiles.length){
          if(ticket.ownerId!==job.ownerId)return false;
          await helpActor(job.ownerId);
        }
        if ((initial.provider === 't3' || process.env.HELP_AI_PROVIDER === 't3') && initial.provider !== process.env.HELP_AI_PROVIDER) return false;
        if (initial.provider === 't3' && !t3Active()) throw new HelpT3Error('HELP_T3_NOT_CONFIGURED');
        if(grounded)await validateHelpKnowledgeSources(db,grounded.validationSources||grounded.sources,job.ownerId);
        await grounded?.validateAppAccess?.(db);
        if(grounded?.onecProofs?.length){
          await db.$executeRaw`SELECT pg_advisory_xact_lock(190154, ${job.ownerId}::int)`;
          await validateOnecProofs(job.ownerId,grounded.onecProofs,db);
        }
        if(grounded?.contextRevision){
          if(ticket.ownerId!==job.ownerId)return false;
          await requireHelpTicket(db,job.ticketId,await helpActor(job.ownerId),false);
          const current=await helpContextFingerprint(db,job.ticketId,job.ownerId,grounded.contextRevision.throughSequence);
          if(current.fingerprint!==grounded.contextRevision.fingerprint)throw new HelpContextError('HELP_CONTEXT_CHANGED');
        }
        const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:'COMPLETED',step:4,leaseToken:null,leaseUntil:null,completedAt:new Date()}});
        if(!claimed.count)return false;
        if (grounded?.contextSummary && initial.provider === 'openai') await saveHelpContextSummary(db,job,grounded.contextSummary);
        const next=await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});
        if(preparedFiles.length) await db.helpAttachment.createMany({data:preparedFiles.map(file=>({...file,ownerId:job.ownerId,messageId:job.messageId}))});
        const ordinaryFiles=preparedFiles.filter(file=>file.mimeType!=='application/vnd.leaderproduct.help-html+json');
        const finalText = ordinaryFiles.length ? `${answer}\n\nПрикреплены файлы: ${ordinaryFiles.map(file=>file.name).join(', ')}.` : answer;
        await db.helpMessage.update({where:{id:job.messageId},data:{text:finalText,kind:'TEXT'}});
        await db.helpTicket.update({where:{id:job.ticketId},data:{updatedAt:new Date()}});
        await updateState(db,next,'completed',grounded?{answerMode:grounded.mode,sources:grounded.sources,...(grounded.suggestions?.length?{suggestions:grounded.suggestions}:{}),...(grounded.questions?.length?{questions:grounded.questions}:{}),...(grounded.action?{action:grounded.action}:{}),...(grounded.generation?{generation:grounded.generation}:{}),...(grounded.handoffReason?{handoffReason:grounded.handoffReason,action:{type:'request_it'}}:{})}:{});
      }else{
        const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:'QUEUED',step:job.step+1,attempts:0,leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+job.durationMs/4)}});
        if(!claimed.count)return false;
        const next=await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});
        await updateState(db,next,'thinking');
      }
      return true;
    });
    filesPublished = delivered;
    return delivered;
  }catch(error:any){
    await helpTransaction(initial.ticketId,async db=>{
      const job=await db.helpAssistantJob.findUnique({where:{id:jobId}});if(!job||job.leaseToken!==leaseToken||!ACTIVE.includes(job.status))return;
      const denied=error?.status===403||error?.status===404;
      const openAIError=error instanceof HelpOpenAIError || error instanceof HelpBunnyError || error instanceof HelpT3Error;
      const failed=denied||error?.code==='HELP_APP_STATS_FORBIDDEN'||job.attempts>=(initial.provider==='t3'?t3Configuration().maxAttempts:initial.provider==='bunny'?bunnyConfiguration().maxAttempts:initial.provider==='openai'?openAIConfiguration().maxAttempts:5)||error?.code==='HELP_AI_PROVIDER_UNAVAILABLE'||openAIError&&!error.retryable;
      const delay=Math.max(Math.min(60000,1000*2**job.attempts),openAIError?error.retryAfterMs:0);
      const claimed=await db.helpAssistantJob.updateMany({where:{id:job.id,leaseToken,status:{in:ACTIVE},leaseUntil:{gt:new Date()}},data:{status:failed?'ERROR':'QUEUED',errorCode:denied?'HELP_FORBIDDEN':error?.code||'HELP_AI_RETRY',leaseToken:null,leaseUntil:null,nextAt:new Date(Date.now()+delay),completedAt:failed?new Date():null}});
      if(claimed.count)await updateState(db,await db.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}}),failed?'error':'thinking',
        initial.provider==='openai'?{draftText:'',phase:failed?'error':'retrying',error:helpAIErrorMessage(error?.code||'',!failed),errorDiagnostic:error instanceof HelpOpenAIError ? error.diagnostic || null : null,...(failed?{}:{retryAt:Date.now()+delay})}:{});
    });
    return false;
  }finally{
    if(preparedFiles.length&&!filesPublished){
      // A lost COMMIT acknowledgement may still have published the attachment
      // rows. Preserve referenced objects; on an unavailable DB preserve all.
      try{
        const saved=await prisma.helpAttachment.findMany({where:{id:{in:preparedFiles.map(file=>file.id)},messageId:initial.messageId},select:{id:true}});
        const keep=new Set(saved.map(file=>file.id));
        await cleanupHelpAIFiles(preparedFiles.filter(file=>!keep.has(file.id)));
      }catch{console.warn('[help-ai-files] cleanup deferred',{code:'HELP_AI_FILE_PUBLICATION_UNKNOWN'});}
    }
  }
  });
}
export async function claimHelpAssistantJob() {
  const token=randomUUID();
  const jobs=await prisma.$queryRaw<Array<{id:string}>>`UPDATE "HelpAssistantJob" SET "status"='RUNNING',"leaseToken"=${token},"leaseUntil"=NOW()+INTERVAL '90 seconds',"attempts"="attempts"+1,"updatedAt"=NOW() WHERE "id"=(SELECT "id" FROM "HelpAssistantJob" WHERE "status" IN ('QUEUED','RUNNING') AND "nextAt"<=NOW() AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW()) ORDER BY "nextAt","id" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING "id"`;
  return jobs[0]?{id:jobs[0].id,leaseToken:token}:null;
}
export async function tickHelpAssistantWorker(provider?:HelpAssistantProvider,shutdown?:AbortSignal) {
  if(!helpAssistantConfiguration().enabled)return false;
  const job=await claimHelpAssistantJob();if(!job)return false;
  return processHelpAssistantJob(job.id,job.leaseToken,provider,shutdown);
}
export function startHelpAssistantWorker() {
  if(!helpAssistantConfiguration().enabled)return async()=>{};
  const configured=process.env.HELP_AI_WORKER_CONCURRENCY;
  const concurrency=configured&&/^[1-4]$/.test(configured)?Number(configured):1;
  let stopped=false;
  const inFlight=new Set<Promise<void>>();
  const shutdown=new AbortController();
  const tick=()=>{
    if(stopped||inFlight.size>=concurrency)return;
    // Start at most one claim per polling interval, including when the queue is
    // empty. Slots include a pending claim as well as its processing/finalization.
    const work:Promise<void>=(async()=>{try{await tickHelpAssistantWorker(undefined,shutdown.signal);}catch(error:any){console.error('[help-ai] worker retry',{code:error?.code||'UNKNOWN'});}})()
      .finally(()=>{inFlight.delete(work);});
    inFlight.add(work);
  };
  const timer=setInterval(tick,250);tick();
  return async()=>{stopped=true;clearInterval(timer);shutdown.abort();await Promise.all(inFlight);};
}
