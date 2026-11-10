/* No user data: execute current runtime store against TEMP tables on one private connection. */
const fs=require('node:fs'),path=require('node:path');
async function main(){
 const {Client}=require('pg');const client=new Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 try{
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE "HelpAttachment" (id text PRIMARY KEY) ON COMMIT DROP');
  const migration=fs.readFileSync(path.join(__dirname,'../../prisma/migrations/20261108010000_help_audio_transcripts/migration.sql'),'utf8');
  await client.query(migration.replace('CREATE TABLE','CREATE TEMP TABLE'));
  const id='11111111-1111-4111-8111-111111111111';await client.query('INSERT INTO "HelpAttachment" VALUES ($1)',[id]);
  const prismaPath=require.resolve('../../dist/prisma/client');
  const query=async(strings,...values)=>client.query(strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),values);
  require.cache[prismaPath]={id:prismaPath,filename:prismaPath,loaded:true,exports:{__esModule:true,default:{$queryRaw:async(...args)=>(await query(...args)).rows,$executeRaw:async(...args)=>(await query(...args)).rowCount}}};
  const {helpAudioTranscriptStore:store}=require('../../dist/modules/help/help.audio-transcript-store');
  const assert=require('node:assert/strict');
  assert.equal((await store.read(id,'source')).status,'not_started');
  const claims=await Promise.all([store.claim(id,'source','model-a'),store.claim(id,'source','model-a')]);
  assert.equal(claims.filter(Boolean).length,1);const token=claims.find(Boolean);
  assert.equal((await store.read(id,'source')).status,'pending');
  await store.finish(id,'source','wrong-token',{attachmentId:id,status:'transcribed',text:'wrong'});
  assert.equal((await store.read(id,'source')).status,'pending');
  await store.finish(id,'source',token,{attachmentId:id,status:'transcribed',text:'fixture'});
  await store.release(id,'source',token);
  assert.equal((await store.read(id,'source')).text,'fixture');
  assert.equal(await store.claim(id,'source','model-b'),null);
  assert.equal((await store.read(id,'changed')).status,'not_started');
  const changed=await store.claim(id,'changed','model-b');assert.ok(changed);
  await store.release(id,'changed',changed);assert.equal((await store.read(id,'changed')).status,'unavailable');
  assert.ok(await store.claim(id,'changed','model-b'));
  await client.query('UPDATE "HelpAudioTranscript" SET "lockedUntil"=now()-interval \'1 second\'');
  assert.ok(await store.claim(id,'changed','model-b'));
  await client.query('DELETE FROM "HelpAttachment" WHERE id=$1',[id]);
  assert.equal((await client.query('SELECT count(*)::int n FROM "HelpAudioTranscript"')).rows[0].n,0);
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ok:true,checks:12,tempTablesOnly:true,userDataChanged:false}));
 }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
main().catch(()=>{console.error('Audio transcript store QA failed; inspect privately');process.exitCode=1;});
