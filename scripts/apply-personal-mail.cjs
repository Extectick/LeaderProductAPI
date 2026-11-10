/* Add only personal mailbox connections and immutable confirmation drafts in dev. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const migrationId='20261108090000_personal_mail';
const sql=fs.readFileSync(path.join(__dirname,'..','prisma','migrations',migrationId,'migration.sql'),'utf8').replace(/\r\n/g,'\n');
const checksum=crypto.createHash('sha256').update(sql).digest('hex');
class GuardError extends Error{}const guard=(ok,message)=>{if(!ok)throw new GuardError(message);};
const expected={PersonalMailConnection:{userId:'integer',provider:'text',email:'text',passwordCipher:'text',verifiedAt:'timestamp with time zone',revision:'integer',attempts:'integer',attemptWindow:'timestamp with time zone'},HelpMailDraft:{id:'uuid',ownerId:'integer',ticketId:'integer',provider:'text',connectionRevision:'integer',sender:'text',payload:'jsonb',contentHash:'text',status:'text',createdAt:'timestamp with time zone',attemptedAt:'timestamp with time zone',sentAt:'timestamp with time zone',messageId:'text'}};
async function verify(client){for(const [table,fields] of Object.entries(expected)){
 const columns=(await client.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
 guard(columns.length===Object.keys(fields).length&&Object.entries(fields).every(([name,type])=>columns.some(c=>c.column_name===name&&c.data_type===type)),'Personal mail table columns differ');
 const constraints=(await client.query('SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass',[`public."${table}"`])).rows;
 const has=(type,text)=>constraints.some(c=>c.contype===type&&c.definition===text);
 guard(has('p',table==='PersonalMailConnection'?'PRIMARY KEY ("userId", provider)':'PRIMARY KEY (id)'),'Personal mail primary key differs');
 guard(has('f',`FOREIGN KEY ("${table==='PersonalMailConnection'?'userId':'ownerId'}") REFERENCES "User"(id) ON DELETE CASCADE`),'Personal mail user binding differs');
 if(table==='HelpMailDraft'){guard(has('f','FOREIGN KEY ("ticketId") REFERENCES "HelpTicket"(id) ON DELETE CASCADE'),'Mail ticket binding differs');guard(has('u','UNIQUE ("ownerId", "ticketId", "contentHash")'),'Mail draft deduplication differs');guard(constraints.some(c=>c.contype==='c'&&['DRAFT','SENDING','SENT','UNKNOWN','FAILED'].every(status=>c.definition.includes(status))),'Mail draft status constraint differs');}
 else guard(constraints.some(c=>c.contype==='c'&&['mail','yandex'].every(provider=>c.definition.includes(provider))),'Mail provider constraint differs');
 }
 const index=(await client.query(`SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i WHERE i.indexrelid=to_regclass('public."HelpMailDraft_owner_created_idx"')`)).rows[0];guard(index?.indisvalid&&index?.indisready&&index.definition.includes('("ownerId", "createdAt")'),'Mail draft index differs');
}
async function applyPersonalMail({env=process.env,client:provided}={}){
 guard(env.HELP_MIGRATION_TARGET==='dev'&&env.DB_ACCEPT_DATA_LOSS==='0','Explicit dev target and DB_ACCEPT_DATA_LOSS=0 required');let url;try{url=new URL(env.DATABASE_URL);}catch{throw new GuardError('Development database configuration required');}
 guard(['postgres:','postgresql:'].includes(url.protocol)&&decodeURIComponent(url.pathname.slice(1))==='LeaderAPI_dev'&&env.HELP_MIGRATION_DATABASE_CONFIRM==='LeaderAPI_dev','Only confirmed LeaderAPI_dev is permitted');
 const client=provided||new(require('pg').Client)({connectionString:env.DATABASE_URL});let connected=false,transaction=false;
 try{await client.connect();connected=true;guard((await client.query('SELECT current_database() AS database')).rows[0]?.database==='LeaderAPI_dev','Connected database is not LeaderAPI_dev');await client.query('BEGIN');transaction=true;await client.query("SET LOCAL lock_timeout='15s'");await client.query("SET LOCAL statement_timeout='30s'");await client.query('SELECT pg_advisory_xact_lock(181932,0)');
 const saved=(await client.query('SELECT checksum FROM "HelpSchemaVersion" WHERE id=$1',[migrationId])).rows[0];if(saved)guard(saved.checksum===checksum,'Migration checksum differs');else{for(const table of Object.keys(expected))guard(!(await client.query('SELECT to_regclass($1) AS name',[`public."${table}"`])).rows[0]?.name,'Unrecorded personal mail table exists; inspect before applying');await client.query(sql);await client.query('INSERT INTO "HelpSchemaVersion" (id,checksum) VALUES ($1,$2)',[migrationId,checksum]);}
 await verify(client);await client.query('COMMIT');transaction=false;return {ok:true,migration:migrationId,action:saved?'verified':'applied',checksum};
 }catch(error){if(transaction)await client.query('ROLLBACK').catch(()=>{});if(error instanceof GuardError)throw error;throw new GuardError('Mail migration failed; inspect privately before retrying');}finally{if(connected)await client.end().catch(()=>{});}
}
module.exports={applyPersonalMail,migrationId,checksum,verify};
if(require.main===module)applyPersonalMail().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error('[personal mail migration]',error.message);process.exitCode=1;});
