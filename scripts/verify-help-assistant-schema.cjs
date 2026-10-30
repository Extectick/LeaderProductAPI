/* Read-only readiness gate. It never migrates, resets, seeds or guesses a DB. */
require('dotenv').config({path:process.env.NODE_ENV==='production'?'.env.production':process.env.NODE_ENV==='test'?'.env.test':'.env.dev',quiet:true});
const {Client}=require('pg');
async function main(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
 const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
 try{
  // LIMIT 0 validates the actual columns without reading user content.
  await client.query('SELECT "id","taskId","ticketId","ownerId","messageId","revision","contextStartSequence","context","status","step","attempts","provider","durationMs","nextAt","leaseUntil","leaseToken","errorCode","createdAt","updatedAt","completedAt" FROM "HelpAssistantJob" LIMIT 0');
  await client.query('SELECT "userId","sessionId","deviceId","socketId","active","ticketId","expiresAt","updatedAt" FROM "HelpSession" LIMIT 0');
  await client.query('SELECT "userId","eventId","sessionId","kind","createdAt" FROM "HelpNotificationAck" LIMIT 0');
  await client.query('SELECT "notificationId","tokenHash","status","updatedAt" FROM "HelpNotificationDelivery" LIMIT 0');
  await client.query('SELECT "assistantState" FROM "HelpMessage" LIMIT 0');
  const columns=await client.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='HelpMessage' AND column_name='authorId') OR (table_name='HelpEvent' AND column_name='actorId'))`);
  if(columns.rowCount!==2||columns.rows.some(row=>row.is_nullable!=='YES'))throw new Error('Nullable system-author migration missing');
  console.log('[help-ai] schema ready');
 }finally{await client.end();}
}
main().catch(()=>{console.error('[help-ai] schema not ready: apply the reviewed 20261030110000_help_assistant_delivery migration explicitly before starting API/worker');process.exitCode=1;});
