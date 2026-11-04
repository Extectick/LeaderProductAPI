const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runSource,validateRequest,eventPrefix}=require('./source.cjs');
const env={HELP_LEARNING_TARGET:'dev',HELP_LEARNING_DATABASE_URL:'postgresql://leader_help_learning_ro:synthetic@localhost/LeaderAPI_dev'};
const date='2026-11-05T00:00:00.000Z';
const ticket=id=>({ticket_id:id,status:'CLOSED',closed_at:date,it_requested:true,updated_at:date,message_sequence:2,last_event_id:10,message_count:1,message_mutation_at:date,job_count:0,job_mutation_at:null,eligibility_version:'owner-version',member_version:'member-version'});
const message=(id,seq,text='Synthetic dialogue')=>({ticket_id:id,id:id*100+seq,sequence:seq,author_role:'OWNER',kind:'TEXT',text,text_digest:'digest',text_truncated:false,rating:null,created_at:date,edited_at:null});
function fixture({events=[],tickets=[ticket(1)],messages=[message(1,1)],jobs=[],identity,failQuery}={}) {
  const state={calls:[],connects:0,ends:0};
  const client={async connect(){state.connects++;},async end(){state.ends++;},async query(sql,args){
    state.calls.push({sql,args});if(failQuery&&sql.includes(failQuery))throw new Error('synthetic secret URL/password');
    if(sql.includes('current_database()'))return {rows:[identity||{database:'LeaderAPI_dev',role:'leader_help_learning_ro',readonly:'on'}]};
    if(sql.includes('FROM help_learning.events_v1'))return {rows:events};
    if(sql.includes('FROM help_learning.tickets_v1'))return {rows:tickets.filter(row=>args[0].includes(row.ticket_id))};
    if(sql.includes('FROM help_learning.messages_v1'))return {rows:messages.filter(row=>args[0].includes(row.ticket_id))};
    if(sql.includes('FROM help_learning.jobs_v1'))return {rows:jobs};return {rows:[]};
  }};return {client,state};
}
const clone=value=>structuredClone(value);
test('strict request caps reject extra SQL, unsafe IDs and oversized batches before connecting',async()=>{
 const bad=[{op:'scan',afterEventId:0,maxTickets:21},{op:'scan',afterEventId:0,maxEvents:1001},{op:'scan',afterEventId:-1},{op:'scan',afterEventId:0,sql:'SELECT secret'},
  {op:'snapshots',ticketIds:[1,1]},{op:'snapshots',ticketIds:[2147483648]},{op:'snapshots',ticketIds:Array.from({length:21},(_,i)=>i+1)},{op:'snapshots',ticketIds:[1],query:'ignored'}];
 for(const request of bad){const {client,state}=fixture();await assert.rejects(runSource(request,{client,env,sanitizeSnapshot:clone}),/INVALID_REQUEST/);assert.equal(state.connects,0);}
 assert.deepEqual(validateRequest({op:'scan',afterEventId:0}),{op:'scan',afterEventId:0,maxTickets:20,maxEvents:1000});
});
test('source refuses any non-dev URL or privileged role before connecting',async()=>{
 for(const patch of [{HELP_LEARNING_TARGET:'prod'},{HELP_LEARNING_DATABASE_URL:'postgresql://postgres@localhost/LeaderAPI_dev'},{HELP_LEARNING_DATABASE_URL:'postgresql://leader_help_learning_ro@localhost/production'}]){
  const {client,state}=fixture();await assert.rejects(runSource({op:'snapshots',ticketIds:[1]},{client,env:{...env,...patch},sanitizeSnapshot:clone}),/SOURCE_CONFIG/);assert.equal(state.connects,0);
 }
});
test('CLI invalid/oversized stdin emits only a fixed error code and no stdout',()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path');
 for(const input of [JSON.stringify({op:'scan',afterEventId:0,sql:'private input marker'}),'x'.repeat(8193)]){
  const result=spawnSync(process.execPath,[path.join(__dirname,'source.cjs')],{input,encoding:'utf8',timeout:5000,maxBuffer:4096});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).code,'HELP_LEARNING_INVALID_REQUEST');assert.ok(!result.stderr.includes('private input marker'));
 }
});
test('scan consumes a contiguous global prefix, never skips the 21st distinct ticket',()=>{
 const events=Array.from({length:21},(_,i)=>({event_id:i+1,ticket_id:i+1}));events.push({event_id:22,ticket_id:1});
 const result=eventPrefix(events,{afterEventId:0,maxTickets:20,maxEvents:1000});
 assert.equal(result.nextEventId,20);assert.equal(result.hasMore,true);assert.equal(result.ticketIds.length,20);
 assert.ok(!result.ticketIds.includes(21));
 assert.deepEqual(eventPrefix([{event_id:5,ticket_id:1},{event_id:9,ticket_id:1}],{afterEventId:3,maxTickets:1,maxEvents:1}),{ticketIds:[1],nextEventId:5,hasMore:true});
});
test('excluded ticket consumes cursor position but supplies no snapshot',async()=>{
 const {client,state}=fixture({events:[{event_id:2,ticket_id:99},{event_id:3,ticket_id:1}]});
 const result=await runSource({op:'scan',afterEventId:0,maxTickets:1,maxEvents:1000},{client,env,sanitizeSnapshot:clone});
 assert.equal(result.nextEventId,2);assert.equal(result.hasMore,true);assert.deepEqual(result.snapshots,[]);
 assert.ok(state.calls.some(row=>row.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
 assert.ok(state.calls.some(row=>row.sql==='COMMIT'));assert.equal(state.ends,1);
});
test('version changes for old-message mutation or membership metadata outside the bounded dialogue',async()=>{
 const run=async(meta)=>{const {client}=fixture({tickets:[{...ticket(1),...meta}]});return (await runSource({op:'snapshots',ticketIds:[1]},{client,env,sanitizeSnapshot:clone})).snapshots[0];};
 const a=await run({}),b=await run({message_mutation_at:'2026-11-06T00:00:00.000Z'}),c=await run({member_version:'changed'});
 assert.match(a.sourceVersion,/^[a-f0-9]{64}$/);assert.notEqual(a.sourceVersion,b.sourceVersion);assert.notEqual(a.sourceVersion,c.sourceVersion);
 assert.ok(!JSON.stringify(a).includes('member_version'));
});
test('version hashes raw selected content before sanitation, and only sanitized whitelisted snapshot reaches callers',async()=>{
 const run=async(text)=>{const {client}=fixture({messages:[message(1,1,text)]});return (await runSource({op:'snapshots',ticketIds:[1]},{client,env,sanitizeSnapshot:value=>({...value,messages:value.messages.map(row=>({...row,text:'[suppressed]'}))})})).snapshots[0];};
 const first=await run('secret original A'),second=await run('secret original B');
 assert.notEqual(first.sourceVersion,second.sourceVersion);assert.equal(first.messages[0].text,'[suppressed]');
 assert.ok(!JSON.stringify(first).includes('secret original'));assert.ok(!JSON.stringify(first).includes('text_digest'));
});
test('20-ticket batches cap total text to 160k; select at most 80 chronological messages and mark omissions',async()=>{
 const tickets=Array.from({length:20},(_,i)=>({...ticket(i+1),message_count:81}));
 const messages=tickets.flatMap(row=>Array.from({length:81},(_,i)=>message(row.ticket_id,i+1,'x'.repeat(4000))));
 const {client,state}=fixture({tickets,messages});
 const result=await runSource({op:'snapshots',ticketIds:tickets.map(row=>row.ticket_id)},{client,env,sanitizeSnapshot:clone});
 let chars=0;for(const item of result.snapshots){assert.equal(item.truncated,true);assert.ok(item.messages.length<=80);let previous=0;for(const m of item.messages){assert.ok(m.sequence>previous);previous=m.sequence;assert.ok(m.text.length<=4000);chars+=m.text.length;}}
 assert.ok(chars<=160000);assert.equal(result.snapshots.length,20);
 assert.ok(state.calls.find(row=>row.sql.includes('LIMIT 81')));assert.ok(state.calls.find(row=>row.sql.includes('LIMIT 8')));
});
test('source identity must be the dedicated dev reader in a readonly transaction',async()=>{
 const {client,state}=fixture({identity:{database:'LeaderAPI_dev',role:'postgres',readonly:'on'}});
 await assert.rejects(runSource({op:'snapshots',ticketIds:[1]},{client,env,sanitizeSnapshot:clone}),/SOURCE_IDENTITY/);
 assert.ok(state.calls.some(row=>row.sql==='ROLLBACK'));assert.ok(!state.calls.some(row=>row.sql.includes('FROM help_learning.')));
});
test('real sanitizer suppresses credential messages before source returns data',async()=>{
 const {client}=fixture({messages:[message(1,1,'password=synthetic-value')]});
 const result=await runSource({op:'snapshots',ticketIds:[1]},{client,env});
 assert.ok(!JSON.stringify(result).includes('synthetic-value'));
 assert.ok(result.snapshots[0].privacyFlags.includes('credentials_suppressed'));
 assert.equal(result.snapshots[0].truncated,true);
});
test('old views remain metadata-unknown and new attachment/activity evidence changes the source version',async()=>{
 const run=async(meta)=>{const {client}=fixture({messages:[{...message(1,1),...meta}]});return (await runSource({op:'snapshots',ticketIds:[1]},{client,env})).snapshots[0];};
 const legacy=await run({});assert.equal(legacy.messages[0].metadataIncluded,false);assert.equal(legacy.messages[0].imagesPrepared,null);
 const current=await run({metadata_included:true,attachments:[{kind:'FILE',extension:'.txt',size:59,mimeType:'text/plain'}],attachments_truncated:false,
   activity_metadata_included:true,activities:[{toolName:'onec_execute_query',status:'completed',errorCode:null}],images_prepared:true});
 assert.notEqual(legacy.sourceVersion,current.sourceVersion);assert.equal(current.messages[0].metadataIncluded,true);
 assert.equal(current.messages[0].attachments[0].size,59);assert.equal(current.messages[0].imagesPrepared,true);
});
test('raw PostgreSQL details are suppressed, transaction rolls back and client closes',async()=>{
 const {client,state}=fixture({failQuery:'FROM help_learning.tickets_v1'});
 await assert.rejects(runSource({op:'snapshots',ticketIds:[1]},{client,env,sanitizeSnapshot:clone}),error=>error.code==='HELP_LEARNING_SOURCE_FAILED'&&!/secret|password|URL/.test(error.message));
 assert.equal(state.ends,1);assert.ok(state.calls.some(row=>row.sql==='ROLLBACK'));
});
test('synthetic PostgreSQL16 views, role isolation, prefix and revocation integration',{skip:process.env.HELP_LEARNING_SYNTHETIC!=='1'},async()=>{
 const {Client}=require('pg'),fs=require('node:fs'),path=require('node:path');
 const admin=new Client({connectionString:'postgresql://postgres@127.0.0.1:5432/LeaderAPI_dev'});await admin.connect();
 const readerEnv={HELP_LEARNING_TARGET:'dev',HELP_LEARNING_DATABASE_URL:'postgresql://leader_help_learning_ro@127.0.0.1:5432/LeaderAPI_dev'};
 try {
  await admin.query(`CREATE TABLE "User" (id int PRIMARY KEY,"isActive" boolean,"deletedAt" timestamp,"profileStatus" text);
   CREATE TABLE "EmployeeProfile" ("userId" int PRIMARY KEY,status text);
   CREATE TABLE "HelpTicket" (id int PRIMARY KEY,"ownerId" int,status text,"closedAt" timestamp,"itRequested" boolean,"updatedAt" timestamp,"messageSequence" int);
   CREATE TABLE "HelpMember" ("ticketId" int,"userId" int,role text,"joinedAt" timestamp,PRIMARY KEY("ticketId","userId"));
   CREATE TABLE "HelpMessage" (id int PRIMARY KEY,"ticketId" int,sequence int,"authorId" int,"authorRole" text,kind text,text text,rating int,"createdAt" timestamp,"editedAt" timestamp,"assistantState" jsonb);
   CREATE TABLE "HelpAttachment" (id text PRIMARY KEY,"messageId" int,kind text,name text,size int,"mimeType" text,position int,"createdAt" timestamp,"objectKey" text,sha256 text,"ownerId" int);
   CREATE TABLE "HelpEvent" (id int PRIMARY KEY,"ticketId" int);
   CREATE TABLE "HelpAssistantJob" (id text PRIMARY KEY,"ticketId" int,status text,"errorCode" text,provider text,"completedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp,context jsonb,"leaseToken" text);
   INSERT INTO "User" VALUES (1,true,NULL,'APPROVED'),(2,true,NULL,'BLOCKED'),(3,true,NULL,'APPROVED');
   INSERT INTO "HelpTicket" SELECT n,1,'CLOSED',timestamp '2026-11-05',true,timestamp '2026-11-05',81 FROM generate_series(1,21) n;
   INSERT INTO "HelpTicket" VALUES (99,2,'CLOSED',timestamp '2026-11-05',true,timestamp '2026-11-05',1);
   INSERT INTO "HelpMember" SELECT id,"ownerId",'OWNER',timestamp '2026-11-05' FROM "HelpTicket";
   INSERT INTO "HelpEvent" SELECT n,n FROM generate_series(1,21) n;
   INSERT INTO "HelpEvent" VALUES (22,99),(23,1);
   INSERT INTO "HelpMessage" SELECT n,1,n,1,'USER','TEXT','synthetic text '||n,NULL,timestamp '2026-11-05',NULL FROM generate_series(1,81) n;
   INSERT INTO "HelpMessage" VALUES (1000,2,1,3,'USER','TEXT','non-owner text',NULL,timestamp '2026-11-05',NULL);
   INSERT INTO "HelpAssistantJob" VALUES ('synthetic-job',1,'COMPLETED',NULL,'synthetic',timestamp '2026-11-05',timestamp '2026-11-05',timestamp '2026-11-05','{"private":"not-selected"}','not-selected-token');`);
  await admin.query(`INSERT INTO "HelpAttachment" VALUES ('file-1',81,'FILE','PRIVATE_NAME.TXT',59,'text/plain',0,timestamp '2026-11-05','PRIVATE_OBJECT_KEY','PRIVATE_SHA256',1),
   ('image-1',80,'IMAGE','PRIVATE_IMAGE.jpeg',200,'image/jpeg',0,timestamp '2026-11-05','PRIVATE_IMAGE_KEY','PRIVATE_IMAGE_HASH',1),
   ('suffix-1',78,'FILE','PRIVATE_NAME.txt?password=PRIVATE_CREDENTIAL',12,'text/plain',0,timestamp '2026-11-05','PRIVATE_OTHER_KEY','PRIVATE_HASH',1);
   INSERT INTO "HelpAttachment" SELECT 'many-'||n,79,'FILE','PRIVATE_MANY.csv',n,'text/csv',n,timestamp '2026-11-05','PRIVATE_MANY_KEY','PRIVATE_HASH',1 FROM generate_series(1,5) n;`);
  await admin.query('UPDATE "HelpMessage" SET "authorId"=NULL,"authorRole"=\'ASSISTANT\',"assistantState"=$1::jsonb WHERE id=81',[JSON.stringify({activityVersion:1,draftText:'PRIVATE_DRAFT',activities:[
   {id:'images',kind:'status',status:'completed',label:'PRIVATE_IMAGE_LABEL',text:'PRIVATE_IMAGE_TEXT'},
   {id:'tool:0',kind:'tool',toolName:'onec_execute_query',status:'failed',errorCode:'ONEC_TOOL_ARGUMENTS',label:'PRIVATE_TOOL_LABEL',text:'PRIVATE_TOOL_TEXT',args:{password:'PRIVATE_PASSWORD'}},
   {id:'analysis',kind:'analysis',status:'completed',label:'PRIVATE_ANALYSIS_LABEL',text:'PRIVATE_ANALYSIS_TEXT'},
  ]})]);
  const schema=fs.readFileSync(path.join(__dirname,'source-schema.sql'),'utf8');
  // Install the actual old projection first, then append columns in place.
  const legacySchema=schema.replace(/,\n  -- BEGIN optional metadata[\s\S]*?  -- END optional metadata\n/u,'\n');
  assert.notEqual(legacySchema,schema);await admin.query(legacySchema);
  const columns=async()=> (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='help_learning' AND table_name='messages_v1' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
  const legacyColumns=await columns();assert.equal(legacyColumns.includes('attachments'),false);
  const viewOid=(await admin.query("SELECT 'help_learning.messages_v1'::regclass::oid AS oid")).rows[0].oid;
  await admin.query('CREATE VIEW help_learning.synthetic_dependency AS SELECT id,text FROM help_learning.messages_v1');
  await admin.query(schema);await admin.query(schema);
  assert.equal((await admin.query("SELECT 'help_learning.messages_v1'::regclass::oid AS oid")).rows[0].oid,viewOid);
  assert.deepEqual((await columns()).slice(0,legacyColumns.length),legacyColumns);
  assert.deepEqual((await columns()).slice(legacyColumns.length),['metadata_included','attachments','attachments_truncated','activity_metadata_included','activities','activities_truncated','images_prepared']);
  assert.ok((await admin.query('SELECT id FROM help_learning.synthetic_dependency LIMIT 1')).rowCount===1);
  await admin.query('ALTER ROLE leader_help_learning_ro LOGIN');
  const scan=await runSource({op:'scan',afterEventId:0,maxTickets:20,maxEvents:1000},{env:readerEnv,sanitizeSnapshot:clone});
  assert.equal(scan.nextEventId,20);assert.equal(scan.hasMore,true);assert.equal(scan.snapshots.length,20);
  const more=await runSource({op:'scan',afterEventId:20,maxTickets:20,maxEvents:1000},{env:readerEnv,sanitizeSnapshot:clone});
  assert.equal(more.nextEventId,23);assert.deepEqual(more.snapshots.map(row=>row.ticketId),[1,21]);
  const first=scan.snapshots.find(row=>row.ticketId===1);assert.equal(first.truncated,true);assert.equal(first.messages.length,80);assert.equal(first.messages[0].sequence,2);assert.equal(first.messages[0].authorRole,'OWNER');
  const published=first.messages.find(row=>row.id===81);assert.equal(published.metadataIncluded,true);
  assert.deepEqual(published.attachments,[{kind:'FILE',extension:'.txt',size:59,mimeType:'text/plain'}]);assert.equal(published.imagesPrepared,true);
  assert.deepEqual(published.activities,[{toolName:'onec_execute_query',status:'failed',errorCode:'ONEC_TOOL_ARGUMENTS'}]);
  assert.deepEqual(first.messages.find(row=>row.id===80).attachments,[{kind:'IMAGE',extension:'.jpeg',size:200,mimeType:'image/jpeg'}]);
  assert.equal(first.messages.find(row=>row.id===79).attachments.length,4);assert.equal(first.messages.find(row=>row.id===79).attachmentsTruncated,true);
  assert.equal(first.messages.find(row=>row.id===78).attachments[0].extension,null);
  assert.equal(first.messages.find(row=>row.id===77).metadataIncluded,true);assert.deepEqual(first.messages.find(row=>row.id===77).attachments,[]);
  assert.equal(first.messages.find(row=>row.id===77).imagesPrepared,null);
  assert.equal(JSON.stringify(scan).includes('PRIVATE_'),false);
  assert.equal(scan.snapshots.find(row=>row.ticketId===2).messages[0].authorRole,'OTHER');
  const snapshot=async()=> (await runSource({op:'snapshots',ticketIds:[1]},{env:readerEnv,sanitizeSnapshot:clone})).snapshots[0];
  await admin.query(`UPDATE "HelpMessage" SET text='old edited text',"editedAt"=timestamp '2026-11-06' WHERE id=1`);
  const changed=await snapshot();assert.notEqual(changed.sourceVersion,first.sourceVersion);
  await admin.query(`INSERT INTO "HelpMember" VALUES (1,3,'IT',timestamp '2026-11-05')`);
  assert.notEqual((await snapshot()).sourceVersion,changed.sourceVersion);
  await admin.query(`UPDATE "User" SET "profileStatus"='BLOCKED' WHERE id=1`);assert.equal(await snapshot(),undefined);
  await admin.query(`UPDATE "User" SET "profileStatus"='APPROVED' WHERE id=1`);
  const reader=new Client({connectionString:readerEnv.HELP_LEARNING_DATABASE_URL});await reader.connect();
  try {
   for(const table of ['User','HelpMessage','HelpAssistantJob','HelpAttachment'])await assert.rejects(reader.query(`SELECT * FROM public."${table}"`),error=>error.code==='42501');
   await reader.query('SET default_transaction_read_only=off');
   assert.equal((await reader.query("SELECT has_table_privilege(current_user,'help_learning.tickets_v1','UPDATE') AS allowed")).rows[0].allowed,false);
   await assert.rejects(reader.query('UPDATE help_learning.tickets_v1 SET status=\'OPEN\''),error=>['42501','55000'].includes(error.code));
   const jobColumns=(await reader.query('SELECT * FROM help_learning.jobs_v1')).fields.map(field=>field.name);
   assert.ok(!jobColumns.includes('context'));assert.ok(!jobColumns.includes('leaseToken'));
   assert.equal((await reader.query("SELECT count(*)::int AS count FROM information_schema.table_privileges WHERE grantee=current_user AND table_schema='help_learning' AND privilege_type='SELECT'")).rows[0].count,4);
  } finally {await reader.end();}
 }finally{await admin.end();}
});

test('dense metadata stays bounded without omitting eligible tickets or claiming empty evidence',async()=>{
 const tickets=Array.from({length:20},(_,i)=>({...ticket(i+1),message_count:80}));
 const messages=tickets.flatMap(row=>Array.from({length:80},(_,i)=>({...message(row.ticket_id,i+1,''),metadata_included:true,activity_metadata_included:true,
  attachments:Array.from({length:4},()=>({kind:'FILE',extension:'.json',size:2147483647,mimeType:'application/octet-stream'})),
  activities:Array.from({length:8},()=>({toolName:'onec_get_metadata_structure',status:'completed',errorCode:'ONEC_REPEATED_REJECTED_REQUEST'}))})));
 const {client}=fixture({tickets,messages});
 const result=await runSource({op:'snapshots',ticketIds:tickets.map(row=>row.ticket_id)},{client,env});
 assert.equal(result.snapshots.length,20);assert.ok(Buffer.byteLength(JSON.stringify(result))<2*1024*1024);
 assert.ok(result.snapshots.every(s=>s.truncated&&s.messages.length===80&&s.messages.some(m=>m.attachmentsTruncated||m.activitiesTruncated)));
});
