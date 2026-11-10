'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {validateRequest,readEvidence}=require('./evidence-reader.cjs');
const bytes=Buffer.from('Value\n42'),sha256=createHash('sha256').update(bytes).digest('hex');
const file={id:'063fa464-da3a-4b28-97d0-a23ba343e236',messageId:12,name:'report.csv',mimeType:'text/csv',kind:'FILE',size:bytes.length,objectKey:'private-storage-key',sha256};
function fixture({allowed=[63],files=[file],jobs=[]}={}){
  const queries=[];
  const client={async query(sql,args){queries.push({sql,args});
    if(sql.startsWith('SELECT current_database'))return {rows:[{database:'LeaderAPI_dev',readonly:'on'}]};
    if(sql.startsWith('SELECT ticket_id'))return {rows:allowed.map(ticket_id=>({ticket_id}))};
    if(sql.includes('FROM public."HelpAttachment"'))return {rows:files};
    if(sql.includes('FROM public."HelpAssistantJob"'))return {rows:jobs};
    return {rows:[]};
  }};
  return {client,queries,loadObject:async()=>bytes,extractArtifact:async()=>({format:'csv',status:'parsed',complete:true,sheets:[{name:'CSV',headers:['Value'],rows:[[42]],rowCount:2,dataRowCount:1,columnCount:1,rowsComplete:true,headersComplete:true}]}),sanitizeAnalysisEvidence:(value)=>value};
}
const input={tickets:[{ticketId:63,messageIds:[12]}]};
test('requests accept only selected ticket/message IDs, never caller paths or commands',()=>{
  assert.deepEqual(validateRequest(input),input);
  for(const value of [{...input,path:'/etc/passwd'},{tickets:[{ticketId:63,messageIds:[12],objectKey:'secret'}]},{tickets:[{ticketId:63,messageIds:[12,12]}]}])assert.throws(()=>validateRequest(value));
});
test('read-only scope, bound attachment bytes and integrity precede parsing; private paths never returned',async()=>{
  const f=fixture(),result=await readEvidence(input,f),out=result.tickets[0].analysisEvidence;
  assert.equal(f.queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(f.queries.some(q=>q.sql.includes('m."ticketId"=$1 AND m.id=ANY($2::int[])')&&q.args[0]===63&&q.args[1][0]===12));
  assert.equal(out.files[0].dataRowCount,undefined);assert.equal(out.files[0].sheets[0].dataRowCount,1);
  assert.equal(out.files[0].sha256,sha256);assert.equal(out.files[0].complete,true);
  assert.ok(!JSON.stringify(result).includes(file.objectKey));assert.ok(!JSON.stringify(result).includes(file.name));
});
test('revoked owners are excluded before querying or reading files',async()=>{
  const f=fixture({allowed:[]});f.loadObject=async()=>assert.fail('revoked object read');
  assert.deepEqual((await readEvidence(input,f)).tickets,[]);
  assert.ok(!f.queries.some(q=>q.sql.includes('HelpAttachment')));
});
test('mismatched bytes cannot be presented as parsed content',async()=>{
  const f=fixture();f.loadObject=async()=>Buffer.from('tampered');f.extractArtifact=async()=>assert.fail('tampered file parsed');
  const result=await readEvidence(input,f);assert.equal(result.tickets[0].analysisEvidence.files[0].status,'failed');
  assert.equal(result.tickets[0].analysisEvidence.files[0].complete,false);
});
test('historical missing results stay empty; persisted 1C args/results bind to their assistant message',async()=>{
  assert.deepEqual((await readEvidence(input,fixture())).tickets[0].analysisEvidence.toolCalls,[]);
  const call={index:1,toolName:'onec_execute_query',args:{query:'SELECT 42'},result:{rows:[{Value:42}]},status:'returned',contentComplete:true,redacted:false,sourceTruncated:false};
  const f=fixture({jobs:[{messageId:12,evidence:{version:1,calls:[call],truncated:false}}]});
  const result=await readEvidence(input,f);assert.deepEqual(result.tickets[0].analysisEvidence.toolCalls,[{...call,messageId:12,scope:'latest_attempt'}]);
});
test('file parsing limit is deterministic per ticket, independent of batch ordering',async()=>{
  const many=Array.from({length:7},(_,i)=>({...file,id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}));
  const f=fixture({allowed:[63,64],files:many}),a=await readEvidence({tickets:[...input.tickets,{ticketId:64,messageIds:[12]}]},f);
  const b=await readEvidence({tickets:[{ticketId:64,messageIds:[12]},...input.tickets]},fixture({allowed:[63,64],files:many}));
  assert.deepEqual(a.tickets.find(t=>t.ticketId===63),b.tickets.find(t=>t.ticketId===63));
  assert.equal(a.tickets[0].analysisEvidence.files.filter(f=>f.complete).length,6);
  assert.equal(a.tickets[0].analysisEvidence.filesTruncated,true);
});
