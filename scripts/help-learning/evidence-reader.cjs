'use strict';
// Fixed trusted collector, never a model tool. No caller-supplied paths/URLs/SQL.
const {createHash}=require('node:crypto');
const {extname}=require('node:path');
const MAX_FILE=10*1024*1024, MAX_FILES=6;
function validateRequest(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>k!=='tickets')||!Array.isArray(value.tickets)||value.tickets.length>20)throw Error('HELP_LEARNING_EVIDENCE_REQUEST');
  const ids=new Set();
  for(const t of value.tickets){
    if(!t||Object.keys(t).some(k=>!['ticketId','messageIds'].includes(k))||!Number.isSafeInteger(t.ticketId)||t.ticketId<=0||ids.has(t.ticketId)||!Array.isArray(t.messageIds)||t.messageIds.length>80||t.messageIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(t.messageIds).size!==t.messageIds.length)throw Error('HELP_LEARNING_EVIDENCE_REQUEST');
    ids.add(t.ticketId);
  }
  return value;
}
async function readEvidence(input,{client,loadObject,extractArtifact,sanitizeAnalysisEvidence}={}){
  const request=validateRequest(input);
  extractArtifact??=require('./artifact-reader.cjs').extractArtifact;
  sanitizeAnalysisEvidence??=require('./privacy.cjs').sanitizeAnalysisEvidence;
  let own=false;
  if(!client){
    const url=new URL(process.env.DATABASE_URL||'');
    if(decodeURIComponent(url.pathname)!=='/LeaderAPI_dev'||process.env.NODE_ENV!=='development')throw Error('HELP_LEARNING_EVIDENCE_CONFIG');
    client=new(require('pg').Client)({connectionString:url.toString(),application_name:'leader-help-learning-evidence',connectionTimeoutMillis:5000});own=true;await client.connect();
  }
  if(!loadObject)loadObject=async row=>{
    const {helpS3,helpBucket}=require('../../dist/modules/help/help.storage');
    const {GetObjectCommand}=require('@aws-sdk/client-s3');
    const reply=await helpS3.send(new GetObjectCommand({Bucket:helpBucket,Key:row.objectKey}),{abortSignal:AbortSignal.timeout(10000)});
    if(reply.ContentLength!==undefined&&reply.ContentLength!==row.size)throw Error('SIZE_MISMATCH');
    const chunks=[];let size=0;
    for await(const chunk of reply.Body){size+=chunk.length;if(size>MAX_FILE||size>row.size){reply.Body.destroy?.();throw Error('SIZE_MISMATCH');}chunks.push(chunk);}
    return Buffer.concat(chunks);
  };
  let transaction=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='2s'");
    const identity=(await client.query("SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly")).rows[0];
    if(identity?.database!=='LeaderAPI_dev'||identity.readonly!=='on')throw Error('HELP_LEARNING_EVIDENCE_IDENTITY');
    const ids=request.tickets.map(t=>t.ticketId);
    // Reuse the exact eligibility gate of the restricted source. No file content
    // is read for a revoked/deleted/blocked owner or a missing OWNER membership.
    const allowed=(await client.query('SELECT ticket_id FROM help_learning.tickets_v1 WHERE ticket_id=ANY($1::int[])',[ids])).rows.map(r=>r.ticket_id);
    const rows=[];
    for(const ticket of request.tickets.filter(t=>allowed.includes(t.ticketId))){
      const files=(await client.query(`SELECT a.id,a."messageId",a.name,a."mimeType",a.kind,a.size,a."objectKey",a.sha256
        FROM public."HelpAttachment" a JOIN public."HelpMessage" m ON m.id=a."messageId"
        WHERE m."ticketId"=$1 AND m.id=ANY($2::int[]) AND m.kind<>'ASSISTANT_PROGRESS'
        ORDER BY m.sequence DESC,a.position,a.id LIMIT 17`,[ticket.ticketId,ticket.messageIds])).rows;
      const jobs=(await client.query(`SELECT j."messageId",j.context->'helpAnalysisEvidence' AS evidence
        FROM public."HelpAssistantJob" j JOIN public."HelpTicket" t ON t.id=j."ticketId"
        JOIN public."HelpMessage" m ON m.id=j."messageId" AND m."ticketId"=t.id AND m."authorId" IS NULL
        WHERE j."ticketId"=$1 AND j."ownerId"=t."ownerId" AND m.id=ANY($2::int[])
        ORDER BY j."createdAt" DESC,j.id LIMIT 8`,[ticket.ticketId,ticket.messageIds])).rows;
      rows.push({ticket,files,jobs});
    }
    // Release DB transaction before parsing storage bytes; sourceVersion is
    // reread by the coordinator before accepting a model review.
    await client.query('COMMIT');transaction=false;
    const tickets=[];
    for(const {ticket,files,jobs} of rows){
      // Per-ticket limits keep the evidence/version independent of batch order.
      let parsed=0;
      const evidence={version:1,files:[],toolCalls:[],filesTruncated:files.length>16,toolsTruncated:false};
      for(const row of files.slice(0,16)){
        const extension=extname(row.name||'').toLowerCase();
        const file={messageId:row.messageId,attachmentId:row.id,sha256:row.sha256,extension,status:'unsupported',complete:false};
        if(!['.xlsx','.docx','.pdf','.txt','.md','.csv','.json'].includes(extension))file.reason='UNSUPPORTED_FORMAT';
        else if(row.size>MAX_FILE||row.size<0)file.reason='FILE_SIZE_LIMIT';
        else if(parsed>=MAX_FILES){file.reason='BATCH_FILE_LIMIT';evidence.filesTruncated=true;}
        else{
          parsed++;
          try{
            const bytes=await loadObject(row);
            if(!Buffer.isBuffer(bytes)||bytes.length!==row.size||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('INTEGRITY');
            Object.assign(file,await extractArtifact(bytes,{extension,mimeType:row.mimeType}));
          }catch{file.status='failed';file.reason='FILE_READ_OR_INTEGRITY_FAILED';}
        }
        evidence.files.push(file);
      }
      for(const job of jobs){
        if(job.evidence?.version!==1||!Array.isArray(job.evidence.calls))continue;
        evidence.toolsTruncated||=job.evidence.truncated===true;
        for(const call of job.evidence.calls.slice(0,12))evidence.toolCalls.push({...call,messageId:job.messageId,scope:'latest_attempt'});
        if(job.evidence.calls.length>12)evidence.toolsTruncated=true;
      }
      tickets.push({ticketId:ticket.ticketId,analysisEvidence:sanitizeAnalysisEvidence(evidence,{messageIds:ticket.messageIds})});
    }
    return {schemaVersion:1,tickets};
  }finally{
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    if(own)await client.end().catch(()=>{});
  }
}
async function main(){
  const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw Error('HELP_LEARNING_EVIDENCE_REQUEST');chunks.push(chunk);}
  const result=await readEvidence(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const output=JSON.stringify(result);if(Buffer.byteLength(output)>4*1024*1024)throw Error('HELP_LEARNING_EVIDENCE_LIMIT');
  process.stdout.write(output+'\n');
}
module.exports={validateRequest,readEvidence};
if(require.main===module)main().catch(()=>{process.stderr.write('{"ok":false,"code":"HELP_LEARNING_EVIDENCE_UNAVAILABLE"}\n');process.exitCode=1;});
