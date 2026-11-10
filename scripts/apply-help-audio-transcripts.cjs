/* Apply only the additive voice transcript table to the explicitly confirmed dev database. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const migrationId='20261108010000_help_audio_transcripts';
const sql=fs.readFileSync(path.join(__dirname,'..','prisma','migrations',migrationId,'migration.sql'),'utf8').replace(/\r\n/g,'\n');
const checksum=crypto.createHash('sha256').update(sql).digest('hex');
class GuardError extends Error {}
function guard(ok,message){if(!ok)throw new GuardError(message);}
function target(env){
  guard(env.HELP_MIGRATION_TARGET==='dev'&&env.DB_ACCEPT_DATA_LOSS==='0','Explicit dev target and DB_ACCEPT_DATA_LOSS=0 required');
  let url;try{url=new URL(env.DATABASE_URL);}catch{throw new GuardError('Development database configuration required');}
  guard(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))==='LeaderAPI_dev'&&env.HELP_MIGRATION_DATABASE_CONFIRM==='LeaderAPI_dev','Only confirmed LeaderAPI_dev is permitted');
}
async function verify(client){
  const columns=(await client.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='HelpAudioTranscript'`)).rows;
  const expected={attachmentId:'text',sourceKey:'text',model:'text',status:'text',text:'text',truncated:'boolean',leaseToken:'text',lockedUntil:'timestamp without time zone',createdAt:'timestamp without time zone',updatedAt:'timestamp without time zone'};
  guard(columns.length===Object.keys(expected).length&&Object.entries(expected).every(([name,type])=>columns.some(c=>c.column_name===name&&c.data_type===type)),'Transcript table columns differ');
  const constraints=(await client.query(`SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public."HelpAudioTranscript"'::regclass`)).rows;
  guard(constraints.some(c=>c.contype==='p'&&c.definition==='PRIMARY KEY ("attachmentId")'),'Transcript primary key differs');
  guard(constraints.some(c=>c.contype==='f'&&/FOREIGN KEY \("attachmentId"\) REFERENCES "HelpAttachment"\(id\) ON DELETE CASCADE/.test(c.definition)),'Transcript attachment binding differs');
  guard(constraints.some(c=>c.contype==='c'&&['PROCESSING','TRANSCRIBED','NO_SPEECH','FAILED'].every(status=>c.definition.includes(status))),'Transcript status constraint differs');
}
async function applyHelpAudioTranscripts({env=process.env,client:provided}={}){
  target(env);
  const client=provided||new(require('pg').Client)({connectionString:env.DATABASE_URL});let connected=false,transaction=false;
  try{
    await client.connect();connected=true;
    guard((await client.query('SELECT current_database() AS database')).rows[0]?.database==='LeaderAPI_dev','Connected database is not LeaderAPI_dev');
    await client.query('BEGIN');transaction=true;
    await client.query("SET LOCAL lock_timeout='15s'");await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SELECT pg_advisory_xact_lock(181932,0)');
    const saved=(await client.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1',[migrationId])).rows[0];
    if(saved)guard(saved.checksum===checksum,'Migration checksum differs');
    else{
      guard(!(await client.query(`SELECT to_regclass('public."HelpAudioTranscript"') AS name`)).rows[0]?.name,'Unrecorded transcript table exists; inspect before applying');
      await client.query(sql);
      await client.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES ($1,$2)',[migrationId,checksum]);
    }
    await verify(client);await client.query('COMMIT');transaction=false;
    return{ok:true,migration:migrationId,action:saved?'verified':'applied',checksum};
  }catch(error){if(transaction)await client.query('ROLLBACK').catch(()=>{});if(error instanceof GuardError)throw error;throw new GuardError('Transcript migration failed; inspect privately before retrying');}
  finally{if(connected)await client.end().catch(()=>{});}
}
module.exports={applyHelpAudioTranscripts,migrationId,checksum};
if(require.main===module)applyHelpAudioTranscripts().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error('[help audio migration]',error.message);process.exitCode=1;});
