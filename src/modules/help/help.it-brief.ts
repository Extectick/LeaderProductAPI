import {Prisma} from '@prisma/client';
import prisma from '../../prisma/client';
import {helpContextFingerprint,parseHelpContextSummary} from './help.context-store';
import type {HelpActor} from './help.service';

type Message = {id:number;sequence:number;text:string;authorId:number|null;authorRole:string;assistantState?:unknown};
export type HelpItBriefItem = {text:string;messageIds:number[];provenance:'owner'|'it'|'assistant'|'summary'|'tool_execution'};
export type HelpItBrief = {
  version:1;ticketId:number;throughSequence:number;
  initialRequest:HelpItBriefItem|null;latestRequest:HelpItBriefItem|null;
  recentMessages:HelpItBriefItem[];
  summary:{coveredThrough:number;items:(HelpItBriefItem&{kind:string})[]}|null;
  checks:(HelpItBriefItem&{status:'completed'|'failed'|'stopped';errorCode?:string})[];
};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
/** A brief is not a second transcript or a place to repeat credentials. Originals
 * remain available through the existing authorized message navigation. */
export function helpBriefExcerpt(text:string):string {
  if (/(?:password|passwd|пароль|секрет|api[_ -]?key|access[_ -]?token)\s*[:=]|\bBearer\s+\S+|-----BEGIN [\w ]*PRIVATE KEY|https?:\/\/[^\s/]+:[^\s/]+@|[?&#](?:token|key|secret|password)=/i.test(text)) return 'Содержимое скрыто: откройте исходное сообщение.';
  return text.length>600?text.slice(0,599)+'…':text;
}
function item(message:Message,ownerId:number):HelpItBriefItem {
  return {text:helpBriefExcerpt(message.text),messageIds:[message.id],provenance:message.authorId===ownerId?'owner':message.authorId!==null?'it':'assistant'};
}

/** On-demand, read-only snapshot. No inference, ticket claim, mark-read or cache
 * mutation. A completed tool operation is explicitly NOT a confirmed solution. */
export async function helpItBrief(ticketId:number,actor:HelpActor):Promise<HelpItBrief> {
  const {helpActor,requireHelpTicket,HelpError}=await import('./help.service');
  const freshActor=await helpActor(actor.userId);
  if(!freshActor.canManage)throw new HelpError(403,'HELP_FORBIDDEN','Требуется право специалиста IT');
  const result=await prisma.$transaction(async db=>{
    const ticket=await requireHelpTicket(db,ticketId,freshActor);
    const where={ticketId,kind:'TEXT',sequence:{lte:ticket.messageSequence},OR:[{authorId:ticket.ownerId},{authorId:null,authorRole:'SYSTEM'},{authorId:{not:null},authorRole:'IT'}]};
    const select={id:true,sequence:true,text:true,authorId:true,authorRole:true,assistantState:true} as const;
    const [first,latest,recent,jobs]=await Promise.all([
      db.helpMessage.findFirst({where:{...where,authorId:ticket.ownerId},orderBy:{sequence:'asc'},select}),
      db.helpMessage.findFirst({where:{...where,authorId:ticket.ownerId},orderBy:{sequence:'desc'},select}),
      db.helpMessage.findMany({where,orderBy:{sequence:'desc'},take:32,select}),
      // Project only the existing semantic cache. Job context can also contain
      // private tool evidence, which must never be loaded into this endpoint.
      db.$queryRaw<Array<{summary:unknown}>>`SELECT "context"->'helpContextSummary' AS summary FROM "HelpAssistantJob"
        WHERE "ticketId"=${ticketId} AND "ownerId"=${ticket.ownerId} AND "provider"='openai' AND "status"='COMPLETED' AND "context" ? 'helpContextSummary'
        ORDER BY "createdAt" DESC LIMIT 3`,
    ]);
    let summary:HelpItBrief['summary']=null;
    for(const job of jobs){
      const candidate=parseHelpContextSummary(job.summary);
      if(!candidate||candidate.coveredThrough>ticket.messageSequence)continue;
      const hash=await helpContextFingerprint(db,ticketId,ticket.ownerId,candidate.coveredThrough);
      if(hash.fingerprint!==candidate.fingerprint)continue;
      const ids=[...new Set(candidate.items.flatMap(value=>value.messageIds))];
      const references=await db.helpMessage.findMany({where:{...where,sequence:{lte:candidate.coveredThrough},id:{in:ids}},select:{id:true}});
      if(new Set(references.map(value=>value.id)).size!==ids.length)continue;
      summary={coveredThrough:candidate.coveredThrough,items:candidate.items.slice(0,12).map(value=>({kind:value.kind,text:helpBriefExcerpt(value.text),messageIds:value.messageIds,provenance:'summary'}))};
      break;
    }
    const checks:HelpItBrief['checks']=[];
    for(const message of recent){
      const state=message.assistantState;
      if(message.authorId!==null||!object(state)||!Array.isArray(state.activities))continue;
      for(const activity of state.activities.slice(0,24)){
        if(!object(activity)||!['tool','knowledge'].includes(String(activity.kind))||!['completed','failed','stopped'].includes(String(activity.status)))continue;
        const name=typeof activity.toolName==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(activity.toolName)?activity.toolName:activity.kind==='knowledge'?'Поиск в базе знаний':'Операция инструмента';
        checks.push({text:name,messageIds:[message.id],provenance:'tool_execution',status:activity.status as 'completed'|'failed'|'stopped',
          ...(typeof activity.errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(activity.errorCode)?{errorCode:activity.errorCode}:{})});
        if(checks.length>=12)break;
      }
      if(checks.length>=12)break;
    }
    return {version:1 as const,ticketId,throughSequence:ticket.messageSequence,initialRequest:first?item(first,ticket.ownerId):null,
      latestRequest:latest?item(latest,ticket.ownerId):null,recentMessages:recent.slice(0,6).reverse().map(message=>item(message,ticket.ownerId)),summary,checks};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  // The snapshot cannot observe an access revocation committed while reading.
  const finalActor=await helpActor(actor.userId);
  if(!finalActor.canManage)throw new HelpError(403,'HELP_FORBIDDEN','Требуется право специалиста IT');
  await requireHelpTicket(prisma,ticketId,finalActor);
  return result;
}
