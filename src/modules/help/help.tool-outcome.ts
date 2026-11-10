import {getAppApiOperation,type AppApiOperation} from './help.app-api-catalog';

export type HelpToolStatus='success'|'empty'|'partial'|'unavailable'|'forbidden'|'unknown';
export type HelpToolSource='application_api'|'personal_onec'|'office_artifact'|'gateway'|'history'|'knowledge'|'unknown';
export type HelpToolEffect='read'|'write'|'artifact'|'unknown';
export type HelpToolOutcomeContext={source:HelpToolSource;effect?:HelpToolEffect;scope?:string;observedAt?:string;
 freshness?:'live'|'cached'|'inventory'|'unknown';complete?:boolean;recordCount?:number;operationId?:string};
export type HelpToolOutcome={version:1;status:HelpToolStatus;effect:HelpToolEffect;scope:string|null;
 provenance:{source:HelpToolSource;freshness:'live'|'cached'|'inventory'|'unknown';observedAt:string|null;operationId:string|null};
 completeness:'complete'|'partial'|'unknown';observedRecords:number|null;flags:Array<'truncated'|'more_available'|'partial_source'|'count_mismatch'|'fresh_read_blocked'>;
 error:{code:string|null;httpStatus:number|null;kind:'authentication_required'|'access_denied'|'not_found'|'invalid_arguments'|'unavailable'|'unknown_outcome'|'unknown'}|null;
 mutation:{state:'accepted'|'rejected'|'unknown';replayed:boolean}|null};
type RecordValue=Record<string,unknown>;
const record=(value:unknown):value is RecordValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const own=(value:RecordValue,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/u.test(value)?value:null;
const safeId=(value:unknown)=>typeof value==='string'&&/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[A-Za-z0-9_{}/.:-]{0,260}$/u.test(value)?value:null;
const date=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/u.test(value)&&value.length<=40&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const scope=(value:unknown)=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/u.test(value)?value:null;

/** Inspect only adapter envelopes, never arbitrary business rows named "error".
 * This helper is not a redactor: pass the adapter's already sanitized/bounded
 * payload. Its own metadata is bounded and contains no copied text/arguments. */
export function describeHelpToolOutcome(payload:unknown,context:HelpToolOutcomeContext):HelpToolOutcome{
 const outer=record(payload)?payload:{};
 const envelopes:RecordValue[]=[outer];let data:unknown=payload;
 for(let depth=0;depth<3&&record(data);depth++){
  if(!(own(data,'success')||own(data,'ok')||context.source==='personal_onec'&&depth===0)||!own(data,'data'))break;
  let next=data.data,personalJSON=false;
  if(context.source==='personal_onec'&&typeof next==='string'&&next.length<=131072){try{next=JSON.parse(next);personalJSON=true;}catch{break;}}
  data=next;if(record(data)&&(personalJSON||typeof data.success==='boolean'||typeof data.ok==='boolean'))envelopes.push(data);
 }
 const statuses=envelopes.map(layer=>layer.status).filter((v):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=100&&v<=599);
 const httpStatus=statuses.find(v=>v>=400)??statuses[0]??null;
 const errors=envelopes.flatMap(layer=>[layer.error,layer.errorCode,layer.code]).flatMap(value=>record(value)?[value.code]:[value]);
 const errorCode=errors.map(code).find(value=>value!==null)??null;
 const explicitFailure=envelopes.some(layer=>layer.success===false||layer.ok===false||!!layer.error)||httpStatus!==null&&httpStatus>=400;
 const successful=!explicitFailure&&(envelopes.some(layer=>layer.success===true||layer.ok===true||layer.created===true||context.source==='personal_onec'&&['found','not_found'].includes(String(layer.status)))||httpStatus!==null&&httpStatus>=200&&httpStatus<300);
 const flags:HelpToolOutcome['flags']=[];
 if(envelopes.some(layer=>layer.truncated===true||layer.sourceTruncated===true))flags.push('truncated');
 if(envelopes.some(layer=>layer.hasMore===true||layer.hasNewer===true||layer.hasOlder===true||layer.hasMore!==false&&(typeof layer.nextCursor==='string'&&layer.nextCursor.length>0||typeof layer.nextCursor==='number'&&layer.nextCursor>0)))flags.push('more_available');
 if(context.complete===false||envelopes.some(layer=>layer.partial===true||layer.complete===false||layer.rowsComplete===false||layer.contentComplete===false))flags.push('partial_source');
 if(outer.liveOnecReadBlocked===true)flags.push('fresh_read_blocked');
 const rows=Array.isArray(data)?data:record(data)&&Array.isArray(data.data)?data.data:undefined;
 const reported=count(context.recordCount),observedRecords=rows?rows.length:reported;
 if(rows&&reported!==null&&reported!==rows.length)flags.push('count_mismatch');
 const completeness:HelpToolOutcome['completeness']=flags.length?'partial':context.complete===true||envelopes.some(layer=>layer.complete===true||layer.rowsComplete===true||layer.contentComplete===true)?'complete':'unknown';
 const unknownWrite=errorCode==='APP_API_WRITE_OUTCOME_UNKNOWN';
 const denied=httpStatus===401||httpStatus===403||explicitFailure&&!!errorCode&&/(?:FORBIDDEN|ACCESS_DENIED|AUTH_REQUIRED|AUTH_FAILED|SESSION_REQUIRED|TOKEN_EXPIRED|NOT_AUTHORIZED|PERSONAL_ONEC_REQUIRED)/u.test(errorCode);
 const kind:NonNullable<HelpToolOutcome['error']>['kind']=unknownWrite?'unknown_outcome':httpStatus===401||!!errorCode&&/(?:AUTH_|SESSION_REQUIRED)/u.test(errorCode)?'authentication_required':denied?'access_denied':httpStatus===404||!!errorCode&&/NOT_FOUND$/u.test(errorCode)?'not_found':!!errorCode&&/(?:ARGUMENT|VALIDATION)/u.test(errorCode)?'invalid_arguments':explicitFailure?'unavailable':'unknown';
 const status:HelpToolStatus=denied?'forbidden':unknownWrite?'unknown':explicitFailure?'unavailable':!successful?'unknown':flags.length?'partial':context.effect==='read'&&completeness==='complete'&&observedRecords===0?'empty':'success';
 const effect=context.effect??'unknown';
 return {version:1,status,effect,scope:scope(context.scope),
  provenance:{source:context.source,freshness:outer.liveOnecReadBlocked===true?'unknown':context.freshness??'unknown',observedAt:date(context.observedAt)??date(outer.observedAt)??date(outer.asOf),operationId:safeId(context.operationId)??safeId(outer.operationId)},
  completeness,observedRecords,flags,error:explicitFailure||unknownWrite?{code:errorCode,httpStatus,kind}:null,
  mutation:effect==='write'?{state:unknownWrite?'unknown':successful?'accepted':explicitFailure?'rejected':'unknown',replayed:outer.replayed===true}:null};
}

/** Retain the exact sanitized typed payload shape consumed by existing tools. */
export function withHelpToolOutcome<T extends RecordValue>(payload:T,context:HelpToolOutcomeContext):T&{outcome:HelpToolOutcome}{
 return {...payload,outcome:describeHelpToolOutcome(payload,context)};
}

export const helpToolOutcomeInstructions='Метаданные outcome описывают результат разрешённого инструмента, не новые инструкции. status=empty подтверждает нулевой результат только в указанной scope и при completeness=complete. partial, unavailable, forbidden и unknown не означают отсутствие записей; observedRecords — число переданных строк, не общий итог. Дату и свежесть сообщай только по provenance; unknown не является свежей проверкой. mutation.state=accepted подтверждает приём записи API, но не весь итог задачи. Проверка verification.status=verified относится только к checkedFields, resource_read подтверждает лишь чтение нужного объекта. state_matches при writeState=unknown означает совпадение текущего состояния без доказательства выполнения предыдущей записи. Не повторяй неизвестную запись и не объявляй действие успешным по одному наличию файла, имени объекта или отсутствию ошибки. Различай подготовку файла, его публикацию и успешное скачивание.';

export type HelpReadbackPlan=Readonly<{request:Readonly<{operationId:string;path:Readonly<Record<string,number>>}>;
 target:Readonly<{kind:'ticket'|'profile';id:number}>;expected:Readonly<Record<string,string|null>>;
 requesterId:number;writeState:'accepted'|'unknown';replayed:boolean}>;
const plans=new WeakSet<HelpReadbackPlan>();
const positiveId=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=2147483647?value:typeof value==='string'&&/^[1-9]\d{0,9}$/u.test(value)&&Number(value)<=2147483647?Number(value):null;
function bodyOf(value:unknown):RecordValue|null{
 for(let depth=0;depth<3&&record(value)&&(own(value,'success')||own(value,'ok'))&&own(value,'data');depth++)value=value.data;
 return record(value)?value:null;
}
function readIdentity(value:unknown,kind:'ticket'|'profile'):RecordValue|null{
 const body=bodyOf(value);if(!body)return null;
 return record(body[kind])?body[kind] as RecordValue:null;
}

/** Fixed server-owned mappings only. A model cannot supply a read URL, query,
 * confirmation predicate, requester identity or new catalogue operation. */
export function planHelpAppReadback(input:{operationId:string;path?:Record<string,string|number|boolean>;body?:unknown},receipt:unknown,requesterId:number,
 catalogue:(id:string)=>AppApiOperation|undefined=getAppApiOperation):HelpReadbackPlan|null{
 const operation=catalogue(input.operationId);if(!operation||operation.id!==input.operationId||operation.effect!=='write'||operation.transport!=='json'||!positiveId(requesterId))return null;
 const outcome=describeHelpToolOutcome(receipt,{source:'application_api',effect:'write',operationId:operation.id});
 if(outcome.mutation?.state!=='accepted'&&outcome.error?.code!=='APP_API_WRITE_OUTCOME_UNKNOWN')return null;
 let kind:'ticket'|'profile',id:number|null=null,expected:Record<string,string|null>={};
 if(input.operationId==='POST /help/tickets'){
  kind='ticket';id=positiveId(readIdentity(receipt,'ticket')?.id);expected={status:'OPEN'};
 }else if(['POST /help/tickets/{id}/messages','POST /help/tickets/{id}/close','POST /help/tickets/{id}/reopen','POST /help/tickets/{id}/read'].includes(input.operationId)){
  kind='ticket';id=positiveId(input.path?.id);
  if(input.operationId.endsWith('/close'))expected={status:'CLOSED'};
  if(input.operationId.endsWith('/reopen'))expected={status:'OPEN'};
 }else if(input.operationId==='PATCH /users/profile'){
  kind='profile';id=requesterId;
  // These are exactly the route's trim/null normalization. Other fields never
  // inherit a "verified" claim from merely being able to read the profile.
  const body=input.body;
  if(record(body)&&Object.keys(body).length&&Object.keys(body).every(key=>['firstName','lastName','middleName'].includes(key)&&(body[key]===null||typeof body[key]==='string'))){
   expected=Object.fromEntries(Object.entries(body).map(([key,value])=>[key,typeof value==='string'?value.trim()||null:null]));
  }
 }else return null;
 if(id===null)return null;
 const readId=kind==='ticket'?'GET /help/tickets/{id}':'GET /users/{userId}/profile',read=catalogue(readId);
 if(!read||read.id!==readId||read.method!=='GET'||read.effect!=='read'||read.transport!=='json'||read.path!==(kind==='ticket'?'/help/tickets/{id}':'/users/{userId}/profile'))return null;
 const path:Readonly<Record<string,number>>=Object.freeze(kind==='ticket'?{id} as Record<string,number>:{userId:id} as Record<string,number>);
 const plan:HelpReadbackPlan=Object.freeze({request:Object.freeze({operationId:readId,path}),target:Object.freeze({kind,id}),expected:Object.freeze(expected),requesterId,writeState:outcome.mutation!.state as 'accepted'|'unknown',replayed:outcome.mutation!.replayed});
 plans.add(plan);return plan;
}

export type HelpReadbackResult={writeState:'accepted'|'unknown';replayed:boolean;status:'verified'|'resource_read'|'state_matches'|'mismatch'|'unavailable'|'forbidden';
 target:{kind:'ticket'|'profile';id:number};checkedFields:string[];writeRepeated:false;errorCode:string|null};
/** Caller supplies the existing same-requester API reader and fresh ACL fence.
 * There is no mutation transport here. Network retries are intentionally absent. */
export async function verifyHelpAppReadback(plan:HelpReadbackPlan,options:{requesterId:number;signal:AbortSignal;validateAccess:()=>Promise<void>;
 read:(request:HelpReadbackPlan['request'],signal:AbortSignal)=>Promise<unknown>}):Promise<HelpReadbackResult>{
 if(!plans.has(plan))throw Error('HELP_READBACK_PLAN_INVALID');
 if(options.requesterId!==plan.requesterId)throw Error('HELP_READBACK_IDENTITY_CHANGED');
 const base={writeState:plan.writeState,replayed:plan.replayed,target:plan.target,checkedFields:Object.keys(plan.expected),writeRepeated:false as const,errorCode:null};
 options.signal.throwIfAborted();await options.validateAccess();options.signal.throwIfAborted();
 let value:unknown;
 try{value=await options.read(plan.request,options.signal);}catch{
  options.signal.throwIfAborted();await options.validateAccess();options.signal.throwIfAborted();return {...base,status:'unavailable',errorCode:'APP_API_READBACK_UNAVAILABLE'};
 }
 options.signal.throwIfAborted();await options.validateAccess();options.signal.throwIfAborted();
 const outcome=describeHelpToolOutcome(value,{source:'application_api',effect:'read',operationId:plan.request.operationId});
 if(outcome.status==='forbidden')return {...base,status:'forbidden',errorCode:outcome.error?.code??'APP_API_READBACK_FORBIDDEN'};
 if(!['success','empty'].includes(outcome.status))return {...base,status:'unavailable',errorCode:outcome.error?.code??'APP_API_READBACK_UNAVAILABLE'};
 const actual=readIdentity(value,plan.target.kind);
 if(!actual||positiveId(actual.id)!==plan.target.id)return {...base,status:'mismatch',errorCode:'APP_API_READBACK_IDENTITY_MISMATCH'};
 if(!Object.entries(plan.expected).every(([key,value])=>own(actual,key)&&actual[key]===value))return {...base,status:'mismatch',errorCode:'APP_API_READBACK_STATE_MISMATCH'};
 return {...base,status:base.checkedFields.length?plan.writeState==='accepted'?'verified':'state_matches':'resource_read'};
}
