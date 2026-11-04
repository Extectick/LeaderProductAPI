'use strict';
const { createHash } = require('node:crypto');
const MAX_ID=2147483647,MAX_BATCH_CHARS=160000;
class SourceError extends Error { constructor(code) { super(code); this.code=code; } }
const fail=code=>{throw new SourceError(code);};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function validateRequest(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('HELP_LEARNING_INVALID_REQUEST');
  if(value.op==='scan') {
    if(Object.keys(value).some(key=>!['op','afterEventId','maxTickets','maxEvents'].includes(key))||!integer(value.afterEventId,0,MAX_ID)
      ||!integer(value.maxTickets??20,1,20)||!integer(value.maxEvents??1000,1,1000))fail('HELP_LEARNING_INVALID_REQUEST');
    return {op:'scan',afterEventId:value.afterEventId,maxTickets:value.maxTickets??20,maxEvents:value.maxEvents??1000};
  }
  if(value.op==='snapshots'&&Object.keys(value).every(key=>['op','ticketIds'].includes(key))&&Array.isArray(value.ticketIds)
    &&value.ticketIds.length<=20&&value.ticketIds.every(id=>integer(id,1,MAX_ID))&&new Set(value.ticketIds).size===value.ticketIds.length)return {op:'snapshots',ticketIds:value.ticketIds};
  fail('HELP_LEARNING_INVALID_REQUEST');
}
function sourceUrl(env) {
  let url,database,username;try{url=new URL(env.HELP_LEARNING_DATABASE_URL);database=decodeURIComponent(url.pathname);username=decodeURIComponent(url.username);}catch{fail('HELP_LEARNING_SOURCE_CONFIG');}
  if(env.HELP_LEARNING_TARGET!=='dev'||!['postgres:','postgresql:'].includes(url.protocol)||database!=='/LeaderAPI_dev'
    ||username!=='leader_help_learning_ro')fail('HELP_LEARNING_SOURCE_CONFIG');
  return url.toString();
}
const iso=value=>value==null?null:new Date(value).toISOString();
function eventPrefix(rows,request) {
  const ids=new Set();let next=request.afterEventId,consumed=0;
  for(const row of rows.slice(0,request.maxEvents)) {
    if(!ids.has(row.ticket_id)&&ids.size===request.maxTickets)break;
    ids.add(row.ticket_id);next=row.event_id;consumed++;
  }
  return {ticketIds:[...ids],nextEventId:next,hasMore:consumed<rows.length};
}
async function loadSnapshots(client,ids,sanitize) {
  if(!ids.length)return [];
  const tickets=(await client.query('SELECT * FROM help_learning.tickets_v1 WHERE ticket_id=ANY($1::int[]) ORDER BY ticket_id',[ids])).rows;
  const messages=(await client.query(`SELECT page.* FROM unnest($1::int[]) selected(ticket_id)
    CROSS JOIN LATERAL (SELECT * FROM help_learning.messages_v1 m WHERE m.ticket_id=selected.ticket_id ORDER BY sequence DESC LIMIT 81) page
    ORDER BY page.ticket_id,page.sequence`,[tickets.map(row=>row.ticket_id)])).rows;
  const jobs=(await client.query(`SELECT page.* FROM unnest($1::int[]) selected(ticket_id)
    CROSS JOIN LATERAL (SELECT * FROM help_learning.jobs_v1 j WHERE j.ticket_id=selected.ticket_id ORDER BY created_at DESC,updated_at DESC,status,provider,error_code,completed_at LIMIT 8) page
    ORDER BY page.ticket_id,page.created_at,page.updated_at,page.status,page.provider,page.error_code,page.completed_at`,[tickets.map(row=>row.ticket_id)])).rows;
  const perTicketBudget=Math.floor(MAX_BATCH_CHARS/Math.max(tickets.length,1));
  return tickets.map(ticket=>{
    const rawMessages=messages.filter(row=>row.ticket_id===ticket.ticket_id).slice(-80);
    const rawJobs=jobs.filter(row=>row.ticket_id===ticket.ticket_id).slice(-8);
    // Hash unredacted selected content and whole-history/version watermarks.
    // Hashing precedes both privacy sanitation and batch-size truncation.
    const sourceVersion=createHash('sha256').update(JSON.stringify({ticket,messages:rawMessages,jobs:rawJobs})).digest('hex');
    let truncated=ticket.message_count>80||ticket.job_count>8||rawMessages.some(row=>row.text_truncated||row.attachments_truncated||row.activities_truncated),remaining=perTicketBudget;
    const bounded=[];
    for(const row of [...rawMessages].reverse()) {
      if(!remaining){truncated=true;continue;}
      const text=row.text.slice(0,Math.min(4000,remaining));remaining-=text.length;
      if(text.length<row.text.length)truncated=true;
      bounded.push({id:row.id,sequence:row.sequence,authorRole:row.author_role,kind:row.kind,text,rating:row.rating,createdAt:iso(row.created_at),
        metadataIncluded:row.metadata_included===true,attachments:Array.isArray(row.attachments)?row.attachments.slice(0,4):[],attachmentsTruncated:row.attachments_truncated===true,
        activityMetadataIncluded:row.activity_metadata_included===true,activities:Array.isArray(row.activities)?row.activities.slice(-8):[],activitiesTruncated:row.activities_truncated===true,
        imagesPrepared:typeof row.images_prepared==='boolean'?row.images_prepared:null});
    }
    const snapshot={ticketId:ticket.ticket_id,sourceVersion,status:ticket.status,closedAt:iso(ticket.closed_at),itRequested:ticket.it_requested,
      updatedAt:iso(ticket.updated_at),lastEventId:ticket.last_event_id,truncated,messages:bounded.reverse(),
      jobs:rawJobs.map(row=>({status:row.status,errorCode:row.error_code,provider:row.provider,completedAt:iso(row.completed_at)}))};
    const safe=sanitize(snapshot);
    if(!safe||safe.ticketId!==snapshot.ticketId||safe.sourceVersion!==sourceVersion||!Array.isArray(safe.messages))fail('HELP_LEARNING_SOURCE_PRIVACY');
    // Defensive cap even if a sanitizer replacement expands a redacted string.
    let budget=perTicketBudget,metadataBudget=Math.floor(24000/Math.max(tickets.length,1));
    for(const message of safe.messages){const text=message.text.slice(0,Math.min(4000,budget));budget-=text.length;if(text!==message.text)safe.truncated=true;message.text=text;}
    // Bound metadata independently without dropping eligible tickets or
    // pretending a truncated attachment list proves there were no files.
    for(const message of [...safe.messages].reverse())for(const [field,flag] of [['attachments','attachmentsTruncated'],['activities','activitiesTruncated']]){
      if(!Array.isArray(message[field]))continue;
      while(message[field].length&&JSON.stringify(message[field]).length>metadataBudget){message[field].pop();message[flag]=true;safe.truncated=true;}
      metadataBudget-=Math.min(metadataBudget,JSON.stringify(message[field]).length);
    }
    return safe;
  });
}
async function runSource(input,{client:injectedClient,sanitizeSnapshot,env=process.env}={}) {
  const request=validateRequest(input),url=sourceUrl(env);
  const sanitize=sanitizeSnapshot||require('./privacy.cjs').sanitizeSnapshot;
  const client=injectedClient||new(require('pg').Client)({connectionString:url,connectionTimeoutMillis:5000,application_name:'leader-help-learning-source'});
  let connected=false,inTransaction=false;
  try {
    await client.connect();connected=true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');inTransaction=true;
    await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    const identity=(await client.query("SELECT current_database() AS database,current_user AS role,current_setting('transaction_read_only') AS readonly")).rows[0];
    if(identity.database!=='LeaderAPI_dev'||identity.role!=='leader_help_learning_ro'||identity.readonly!=='on')fail('HELP_LEARNING_SOURCE_IDENTITY');
    let result;
    if(request.op==='scan') {
      const rows=(await client.query('SELECT event_id,ticket_id FROM help_learning.events_v1 WHERE event_id>$1 ORDER BY event_id LIMIT $2',[request.afterEventId,request.maxEvents+1])).rows;
      const prefix=eventPrefix(rows,request);
      result={schemaVersion:1,afterEventId:request.afterEventId,nextEventId:prefix.nextEventId,hasMore:prefix.hasMore,snapshots:await loadSnapshots(client,prefix.ticketIds,sanitize)};
    }else result={schemaVersion:1,snapshots:await loadSnapshots(client,request.ticketIds,sanitize)};
    await client.query('COMMIT');inTransaction=false;return result;
  }catch(error){if(inTransaction)await client.query('ROLLBACK').catch(()=>{});if(error instanceof SourceError)throw error;throw new SourceError('HELP_LEARNING_SOURCE_FAILED');}
  finally{if(connected)await client.end().catch(()=>{});}
}
async function main() {
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>8192)fail('HELP_LEARNING_INVALID_REQUEST');chunks.push(chunk);}
  let request;try{request=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('HELP_LEARNING_INVALID_REQUEST');}
  process.stdout.write(JSON.stringify(await runSource(request))+'\n');
}
module.exports={runSource,validateRequest,eventPrefix,SourceError};
if(require.main===module)main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,code:error instanceof SourceError?error.code:'HELP_LEARNING_SOURCE_FAILED'})+'\n');process.exitCode=1;});
