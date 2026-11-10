/* Real PostgreSQL TEMP-table smoke of the compiled mail service; no SMTP/network mail, no durable writes. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),dist=process.env.MAIL_QA_DIST_ROOT||path.join(root,'dist');
async function main(){
 let url;try{url=new URL(process.env.DATABASE_URL);}catch{throw Error('Development database configuration required');}
 assert.equal(decodeURIComponent(url.pathname.slice(1)),'LeaderAPI_dev','Only LeaderAPI_dev is permitted');
 const client=new(require('pg').Client)({connectionString:process.env.DATABASE_URL});const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mail-store-qa-'));const previous=process.env.MAIL_PERSONAL_KEYRING_FILE;let connected=false;
 const captured=[],attachments=[],smtp={mode:'ok',calls:0};
 const inject=(relative,exports)=>{const file=require.resolve(path.join(dist,relative));captured.push([file,require.cache[file]]);require.cache[file]={id:file,filename:file,loaded:true,exports};};
 const raw=async(strings,...values)=>client.query(strings.reduce((sql,part,index)=>sql+(index?'$'+index:'')+part,''),values);
 const db={$queryRaw:async(...args)=>(await raw(...args)).rows,$executeRaw:async(...args)=>(await raw(...args)).rowCount,$transaction:async fn=>fn(db),user:{findUnique:async()=>({isActive:true,profileStatus:'ACTIVE',employeeProfile:{status:'ACTIVE'}})},helpAttachment:{findMany:async({where})=>attachments.filter(file=>where.id.in.includes(file.id))}};
 try{
  await client.connect();connected=true;assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name,'LeaderAPI_dev');await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('CREATE TEMP TABLE "User" (id integer primary key); CREATE TEMP TABLE "HelpTicket" (id integer primary key); INSERT INTO "User" VALUES (42),(43); INSERT INTO "HelpTicket" VALUES (87)');
  const migration=fs.readFileSync(path.join(root,'prisma/migrations/20261108090000_personal_mail/migration.sql'),'utf8').replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE');await client.query(migration);
  const namespace=(await client.query(`SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='"PersonalMailConnection"'::regclass`)).rows[0].nspname;assert.match(namespace,/^pg_temp_/);
  process.env.MAIL_PERSONAL_KEYRING_FILE=path.join(folder,'keys.json');fs.writeFileSync(process.env.MAIL_PERSONAL_KEYRING_FILE,JSON.stringify({active:'qa',keys:{qa:crypto.randomBytes(32).toString('base64')}}),{mode:0o600});
  inject('prisma/client.js',{__esModule:true,default:db});
  inject('modules/help/help.service.js',{helpActor:async userId=>({userId}),requireHelpTicket:async()=>({id:87,ownerId:42})});
  inject('modules/help/help.storage.js',{helpBucket:'qa',helpS3:{send:async()=>({Body:(async function*(){yield Buffer.from('abc');})()})},helpStorageRequest:fn=>fn()});
  inject('modules/personal-mail/smtp.js',{mailTransport:()=>({verify:async()=>true,close:()=>{},sendMail:async message=>{smtp.calls++;assert.equal(message.from,'owner@mail.ru');assert.equal(message.disableUrlAccess,true);if(smtp.mode==='unknown')throw Error('synthetic timeout');if(smtp.mode==='auth')throw Object.assign(Error('synthetic auth'),{code:'EAUTH'});return {accepted:message.to,rejected:[]};}})});
  const service=require(path.join(dist,'modules/personal-mail/service.js'));
  const input={provider:'mail',to:['client@example.org'],subject:'QA temporary letter',text:'Synthetic test only',attachmentIds:[]};
  const connection=await service.connectMail(42,'mail','owner@mail.ru','synthetic-app-password');assert.equal(connection.connected,true);
  const stored=(await client.query('SELECT "passwordCipher" FROM "PersonalMailConnection"')).rows[0].passwordCipher;assert(!stored.includes('synthetic-app-password'));
  const draft=await service.createMailDraft(42,87,input,'87:1');assert.equal((await service.createMailDraft(42,87,input,'87:1')).id,draft.id);
  await assert.rejects(service.getMailDraft(43,draft.id));
  await assert.rejects(service.sendMailDraft(42,draft.id,'0'.repeat(64)));
  const review=await service.getMailDraft(42,draft.id);await Promise.all([service.sendMailDraft(42,draft.id,review.contentHash),service.sendMailDraft(42,draft.id,review.contentHash)]);assert.equal(smtp.calls,1);assert.equal((await service.getMailDraft(42,draft.id)).status,'SENT');
  const file={id:crypto.randomUUID(),name:'qa.txt',mimeType:'text/plain',size:3,objectKey:'qa-bound-object',sha256:crypto.createHash('sha256').update('abc').digest('hex')};attachments.push(file);
  const withFile=await service.createMailDraft(42,87,{...input,attachmentIds:[file.id]},'87:2');const fileReview=await service.getMailDraft(42,withFile.id);assert.equal(fileReview.attachments[0].name,file.name);assert(!JSON.stringify(fileReview).includes('qa-bound-object'));await service.sendMailDraft(42,withFile.id,fileReview.contentHash);assert.equal(smtp.calls,2);
  const changed=await service.createMailDraft(42,87,{...input,attachmentIds:[file.id]},'87:3');const changedReview=await service.getMailDraft(42,changed.id);file.name='changed.txt';await assert.rejects(service.sendMailDraft(42,changed.id,changedReview.contentHash));assert.equal(smtp.calls,2);
  const unknown=await service.createMailDraft(42,87,input,'87:4');const unknownReview=await service.getMailDraft(42,unknown.id);smtp.mode='unknown';assert.equal((await service.sendMailDraft(42,unknown.id,unknownReview.contentHash)).status,'UNKNOWN');await service.sendMailDraft(42,unknown.id,unknownReview.contentHash);assert.equal(smtp.calls,3);
  const denied=await service.createMailDraft(42,87,input,'87:5');const deniedReview=await service.getMailDraft(42,denied.id);smtp.mode='auth';assert.equal((await service.sendMailDraft(42,denied.id,deniedReview.contentHash)).status,'FAILED');assert.deepEqual(await service.listMailConnections(42),[]);
  const columns=(await client.query('SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ($2,$3)',[namespace,'PersonalMailConnection','HelpMailDraft'])).rows[0].count;assert.equal(columns,21);
  await client.query('ROLLBACK');return {ok:true,tempTablesOnly:true,rolledBack:true,realSMTPCalls:0,checks:['encrypted_connection','owner_binding','review_hash','duplicate_draft','duplicate_confirm','jsonb_attachment_identity','changed_attachment_denied','uncertain_no_retry','auth_failure_disconnect','schema_columns']};
 }finally{if(connected){await client.query('ROLLBACK').catch(()=>{});await client.end();}for(const [file,entry] of captured){if(entry)require.cache[file]=entry;else delete require.cache[file];}if(previous===undefined)delete process.env.MAIL_PERSONAL_KEYRING_FILE;else process.env.MAIL_PERSONAL_KEYRING_FILE=previous;fs.rmSync(folder,{recursive:true,force:true});}
}
main().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Personal mail TEMP smoke failed; inspect privately. No email was sent.');process.exitCode=1;});
