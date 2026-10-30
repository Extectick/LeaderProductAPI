/* Scoped additive development migration; never runs against an inferred target. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg');
const id='20261030110000_help_assistant_delivery';
const sql=fs.readFileSync(path.join(__dirname,'..','prisma','migrations',id,'migration.sql'),'utf8');
const checksum=crypto.createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
const tables=['HelpAssistantJob','HelpSession','HelpNotificationAck','HelpNotificationDelivery'];
async function main(){
 if(process.env.HELP_MIGRATION_TARGET!=='dev'||process.env.DB_ACCEPT_DATA_LOSS!=='0'||!process.env.DATABASE_URL)throw new Error('Explicit dev target and DB_ACCEPT_DATA_LOSS=0 are required');
 const name=decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
 if(!name||process.env.HELP_MIGRATION_DATABASE_CONFIRM!==name)throw new Error('Confirm the exact intended dev database name');
 const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='60s'");await db.query('SELECT pg_advisory_xact_lock(181932,0)');
  const saved=await db.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1',[id]);
  if(saved.rows[0]&&saved.rows[0].checksum!==checksum)throw new Error('Applied assistant migration checksum differs');
  const existing=await db.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY($1::text[])',[tables]);
  let applied=false;
  if(existing.rowCount===0){if(saved.rowCount)throw new Error('Recorded migration has missing tables');await db.query(sql);applied=true;}
  else if(existing.rowCount!==tables.length)throw new Error('Partial assistant schema found; refusing changes');
  const columns=await db.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='HelpMessage' AND column_name IN ('assistantState','authorId')) OR (table_name='HelpEvent' AND column_name='actorId'))`);
  if(columns.rowCount!==3||columns.rows.some(row=>row.is_nullable!=='YES'||row.data_type!==(row.column_name==='assistantState'?'jsonb':'integer')))throw new Error('Incompatible assistant message/event schema');
  const constraints=[...sql.matchAll(/CONSTRAINT "(Help\w+)"/g)].map(row=>row[1]);
  const checked=await db.query('SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])',[constraints]);
  if(checked.rowCount!==constraints.length)throw new Error('Assistant foreign keys incomplete');
  await db.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,checksum]);
  await db.query('COMMIT');console.log(JSON.stringify({ok:true,migration:id,action:applied?'applied':'verified',checksum}));
 }catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
}
main().catch(error=>{console.error('[help assistant migration]',error.message);process.exitCode=1;});
