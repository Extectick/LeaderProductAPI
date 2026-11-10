import type {Prisma} from '@prisma/client';
import type {HelpKnowledgeSource} from './help.knowledge';
import type {OnecProof} from '../onec-personal/service';

const MAX_BYTES=512*1024,MAX_CALLS=96,MAX_STRING_BYTES=128*1024,MAX_NODES=50000;
const ONEC_READS=new Set(['onec_list_metadata_objects','onec_get_metadata_structure','onec_get_access_rights','onec_get_object',
  'onec_get_navigation_link','onec_get_object_history','onec_get_event_log','onec_list_tools','onec_execute_query','onec_inspect_metadata','onec_recall_metadata','onec_find_latest_purchase','onec_find_latest_receipt','onec_find_latest_order']);
type JSONValue=null|string|number|boolean|JSONValue[]|{[key:string]:JSONValue};
export type HelpToolEvidence={index:number;toolName:string;args:JSONValue;result:JSONValue;
  status:'returned'|'failed';contentComplete:boolean;redacted:boolean;sourceTruncated:boolean|null;rowCount:number|null;errorCode?:string};
export type HelpAnalysisEvidence={version:1;scope:'latest_attempt';calls:HelpToolEvidence[];truncated:boolean};
export type HelpAnalysisEvidenceGuards={validationSources:HelpKnowledgeSource[];onecProofs:OnecProof[];
  validateAppAccess?:(db:Prisma.TransactionClient)=>Promise<void>;contextRevision?:{throughSequence:number;fingerprint:string}};
export type HelpAnalysisEvidenceSink=(value:HelpAnalysisEvidence,guards:HelpAnalysisEvidenceGuards)=>Promise<void>;
export type HelpToolEvidenceHook=(name:string,args:unknown,output?:string,errorCode?:string)=>Promise<void>;
export class HelpAnalysisEvidenceError extends Error{
  readonly code='HELP_ANALYSIS_EVIDENCE_FORBIDDEN';readonly status=403;
  constructor(){super('HELP_ANALYSIS_EVIDENCE_FORBIDDEN');}
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
const normalizedKey=(key:string)=>key.normalize('NFKC').replace(/[^a-zа-яё0-9]/giu,'').toLowerCase();
const sensitiveKey=(key:string)=>/password|passwd|^pwd$|парол|credential|authorization|^auth$|authentication|username|имяпользователя|cookie|keyring|apikey|accesskey|signingkey|privatekey|secret|token|cipher|логин|login|binding|connectionstring|endpoint|headers|url|navigationlink|objectkey|thumbnail|imagedata|^stack$/iu.test(normalizedKey(key));
const rowKeys=new Set(['rows','data','values','records']);
function credentialColumn(value:unknown):boolean{
  if(typeof value==='string')return sensitiveKey(value);
  if(!object(value))return false;
  // Query adapters use both plain column names and descriptors. Labels are
  // structural data; a password/login value in the corresponding cell is not.
  return Object.entries(value).some(([key,label])=>['name','field','key','caption','label','title','datafield','имя','имяполя','наименование','имяколонки'].includes(normalizedKey(key))&&typeof label==='string'&&sensitiveKey(label));
}
const credentialText=/(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}|-----BEGIN\s+(?:[A-Z ]+\s+)?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})|(?:password|passwd|pwd|пароль|login|username|логин|secret|api[_ -]?key|access[_ -]?token|authorization|cookie|set-cookie|x-api-key)[\s\x22\x27]*[:=]\s*\S+)/iu;
const urls=/(?:[a-z][a-z0-9+.-]*):\/\/[^\s<>"']+|e1cib\/[^\s<>"']+/giu;
function clip(text:string,size:number){const buffer=Buffer.from(text,'utf8');return buffer.length<=size?text:buffer.subarray(0,size).toString('utf8').replace(/\uFFFD$/u,'');}
function decoded(value:unknown){if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}}

/** Keep business values, while suppressing credentials before the private write.
 * This is not anonymization: the source projection performs its own privacy pass. */
export function helpAnalysisEvidenceCollector(){
  const calls:HelpToolEvidence[]=[];let truncated=false;
  return {
    record(name:string,args:unknown,output?:string,errorCode?:string):boolean{
      if(!ONEC_READS.has(name))return false;
      if(calls.length>=MAX_CALLS){truncated=true;return true;}
      let redacted=false,incomplete=false,nodes=0;
      const seen=new WeakSet<object>();
      const sanitize=(value:unknown,depth=0,key='',tableColumns?:boolean[],isRow=false,structuralHeaders=false):JSONValue=>{
        if(++nodes>MAX_NODES||depth>20){incomplete=true;return '[TRUNCATED]';}
        if(sensitiveKey(key)&&!structuralHeaders){redacted=true;return '[REDACTED]';}
        if(value===null||typeof value==='boolean')return value;
        if(typeof value==='number'){if(Number.isFinite(value))return value;incomplete=true;return null;}
        if(typeof value==='string'){
          if(key==='data'||key==='parametersJson'||value.length<=MAX_STRING_BYTES&&/^\s*[\[{]/u.test(value)){
            const parsed=decoded(value);if(parsed!==value)return sanitize(parsed,depth+1,key==='parametersJson'?'parameters':'data');
          }
          if(credentialText.test(value.normalize('NFKC'))){redacted=true;return '[REDACTED]';}
          const clean=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').replace(urls,'[REDACTED_URL]');
          if(clean!==value)redacted=true;
          const result=clip(clean,MAX_STRING_BYTES);if(result!==clean)incomplete=true;return result;
        }
        if(typeof value!=='object'||!value){incomplete=true;return null;}
        if(seen.has(value)){incomplete=true;return '[TRUNCATED]';}seen.add(value);
        if(Array.isArray(value)){
          const result:JSONValue[]=[],sensitiveLabel=isRow&&typeof value[0]==='string'&&sensitiveKey(value[0]);
          for(let index=0;index<value.length;index++){
            if(nodes>=MAX_NODES){incomplete=true;break;}
            const item=value[index];
            if(isRow&&(tableColumns?.[index]||index>0&&sensitiveLabel))result.push(sanitize(item,depth+1,'password'));
            else if(tableColumns&&!isRow&&Array.isArray(item))result.push(sanitize(item,depth+1,'',tableColumns,true));
            else result.push(sanitize(item,depth+1));
          }
          return result;
        }
        if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null){incomplete=true;return null;}
        const result:{[key:string]:JSONValue}=Object.create(null);
        const entries=Object.entries(value),hasRows=entries.some(([entry,content])=>rowKeys.has(normalizedKey(entry))&&Array.isArray(content));
        const columns=hasRows?entries.find(([entry,content])=>['columns','headers','fields'].includes(normalizedKey(entry))&&Array.isArray(content))?.[1]:undefined;
        const columnMask=Array.isArray(columns)?columns.map(credentialColumn):undefined;
        for(const [entry,content]of entries){
          if(nodes>=MAX_NODES){incomplete=true;break;}
          if(['__proto__','constructor','prototype'].includes(entry)){redacted=true;continue;}
          const clean=clip(entry,300);if(clean!==entry)incomplete=true;
          const label=normalizedKey(entry),tableRows=rowKeys.has(label)&&Array.isArray(content);
          const structuralHeaders=label==='headers'&&Array.isArray(content)&&columnMask!==undefined;
          result[clean]=sanitize(content,depth+1,entry,tableRows?columnMask:undefined,false,structuralHeaders);
        }
        return result;
      };
      const rawResult=output===undefined?null:decoded(output),body=object(rawResult)?decoded(rawResult.data):null;
      const source=object(body)?body:object(rawResult)?rawResult:null;
      const code=typeof errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(errorCode)?errorCode:
        source&&typeof source.error==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(source.error)?source.error:undefined;
      const safeArgs=sanitize(args),safeResult=sanitize(rawResult);
      const item:HelpToolEvidence={index:calls.length+1,toolName:name,args:safeArgs,result:safeResult,status:errorCode||code?'failed':'returned',
        contentComplete:output!==undefined&&!redacted&&!incomplete&&source?.truncated!==true&&
          (!(name==='onec_get_object_history'||name==='onec_get_event_log')||source?.truncated===false)&&
          (name!=='onec_get_object_history'||!Array.isArray(source?.data)||!source.data.some(row=>object(row)&&(row.snapshot==='notStored'||typeof row.stateError==='string'&&row.stateError.length>0))),redacted,sourceTruncated:typeof source?.truncated==='boolean'?source.truncated:null,
        rowCount:Number.isSafeInteger(source?.rowCount)&&Number(source?.rowCount)>=0?Number(source!.rowCount):null,...(code?{errorCode:code}:{})};
      if(bytes({version:1,scope:'latest_attempt',calls:[...calls,item],truncated})>MAX_BYTES){
        truncated=true;item.contentComplete=false;item.args='[TRUNCATED]';item.result='[TRUNCATED]';
      }
      if(bytes({version:1,scope:'latest_attempt',calls:[...calls,item],truncated})>MAX_BYTES)return true;
      calls.push(item);if(incomplete)truncated=true;return true;
    },
    snapshot():HelpAnalysisEvidence{return {version:1,scope:'latest_attempt',calls:JSON.parse(JSON.stringify(calls)),truncated};},
  };
}

/** Separate from progress: this writes no event, message, public state or receipt. */
export function createHelpAnalysisEvidenceSink(job:{id:string;ticketId:number;messageId:number;leaseToken:string},signal:AbortSignal):HelpAnalysisEvidenceSink{
  return async(value,guards)=>{
    if(signal.aborted)throw new HelpAnalysisEvidenceError();
    if(value.version!==1||value.calls.length>MAX_CALLS||bytes(value)>MAX_BYTES)throw new HelpAnalysisEvidenceError();
    const {helpTransaction,helpActor}=await import('./help.service');
    const {validateHelpKnowledgeSources}=await import('./help.knowledge');
    const {validateOnecProofs}=await import('../onec-personal/service');
    const {helpContextFingerprint}=await import('./help.context-store');
    await helpTransaction(job.ticketId,async db=>{
      const current=await db.helpAssistantJob.findUnique({where:{id:job.id}});
      if(signal.aborted||process.env.HELP_AI_PROVIDER!=='openai'||!current||current.provider!=='openai'||current.status!=='RUNNING'||current.ticketId!==job.ticketId||current.messageId!==job.messageId||current.leaseToken!==job.leaseToken||!current.leaseUntil||current.leaseUntil.getTime()<=Date.now())throw new HelpAnalysisEvidenceError();
      await helpActor(current.ownerId);
      const ticket=await db.helpTicket.findUnique({where:{id:job.ticketId},include:{members:true}});
      if(!ticket||ticket.ownerId!==current.ownerId||ticket.status!=='OPEN'||ticket.itRequested||ticket.members.some(member=>member.role==='IT'))throw new HelpAnalysisEvidenceError();
      await validateHelpKnowledgeSources(db,guards.validationSources,current.ownerId);
      await guards.validateAppAccess?.(db);
      if(guards.onecProofs.length){await db.$executeRaw`SELECT pg_advisory_xact_lock(190154, ${current.ownerId}::int)`;await validateOnecProofs(current.ownerId,guards.onecProofs,db);}
      if(guards.contextRevision){const revision=await helpContextFingerprint(db,job.ticketId,current.ownerId,guards.contextRevision.throughSequence);if(revision.fingerprint!==guards.contextRevision.fingerprint)throw new HelpAnalysisEvidenceError();}
      if(signal.aborted)throw new HelpAnalysisEvidenceError();
      const context=object(current.context)&&Object.prototype.hasOwnProperty.call(current.context,'inputs')?{...current.context}:{inputs:current.context};
      // The row is read inside the ticket's existing advisory-lock transaction.
      // Merge the latest value so concurrent summary/client metadata is preserved.
      const saved=await db.helpAssistantJob.updateMany({where:{id:job.id,ticketId:job.ticketId,messageId:job.messageId,ownerId:current.ownerId,provider:'openai',status:'RUNNING',leaseToken:job.leaseToken,leaseUntil:{gt:new Date()}},
        data:{context:{...context,helpAnalysisEvidence:value} as unknown as Prisma.InputJsonValue}});
      if(saved.count!==1)throw new HelpAnalysisEvidenceError();
    });
  };
}
