import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import prisma,{pool} from '../src/prisma/client';
import {createHelpTicket,sendHelpMessage,helpActor,helpDetail,readHelpTicket,replayHelp} from '../src/modules/help/help.service';
import {claimHelpAssistantJob,processHelpAssistantJob,controlHelpAssistant} from '../src/modules/help/help.assistant';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(url.hostname!=='127.0.0.1'||url.port!=='54329'||!/^help_production_qa_\d+_\d+$/.test(url.pathname.slice(1))||process.env.HELP_PRODUCTION_QA_DATABASE!==url.pathname.slice(1))throw new Error('Requires isolated production QA runner');
let owner:Awaited<ReturnType<typeof helpActor>>;
const input=(text='Не печатает принтер')=>({text,clientMessageId:randomUUID()});
async function create(){return createHelpTicket(owner,{...input(),clientTicketId:randomUUID()});}
async function due(id:string){await prisma.helpAssistantJob.update({where:{id},data:{nextAt:new Date(0)}});}
async function finish(id:string){for(let i=0;i<4;i++){await due(id);const claim=await claimHelpAssistantJob();expect(claim?.id).toBe(id);await processHelpAssistantJob(id,claim!.leaseToken);}}
beforeAll(async()=>{
 const role=await prisma.role.create({data:{name:`help_production_${Date.now()}`}});
 await prisma.service.upsert({where:{key:'help'},create:{key:'help',name:'Помощь',defaultVisible:true,defaultEnabled:true},update:{}});
 const user=await prisma.user.create({data:{roleId:role.id,firstName:'QA Owner',isActive:true,profileStatus:'ACTIVE',currentProfileType:'EMPLOYEE'}});
 owner=await helpActor(user.id);
});
afterAll(async()=>{await prisma.$disconnect();await pool.end();});
test('a server process can die holding a lease; a later worker finishes exactly one persisted answer',async()=>{
 const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});
 await due(job.id);
 const code=`const a=require('./src/modules/help/help.assistant');const p=require('./src/prisma/client');(async()=>{const c=await a.claimHelpAssistantJob();if(!c)throw new Error('No job');console.log('claimed');})().finally(async()=>{await p.default.$disconnect();await p.pool.end();});`;
 const child=spawnSync(process.execPath,['-r','ts-node/register/transpile-only','-e',code],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:20000});
 expect(child.status).toBe(0);expect(child.stdout).toContain('claimed');
 const abandoned=await prisma.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});expect(abandoned.status).toBe('RUNNING');
 expect(await claimHelpAssistantJob()).toBeNull();
 await prisma.helpAssistantJob.update({where:{id:job.id},data:{leaseUntil:new Date(0)}});
 await finish(job.id);
 const completed=await prisma.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}});expect(completed.status).toBe('COMPLETED');
 const detail=await helpDetail(id,owner),answer=detail.messages.find(message=>message.id===job.messageId)!;
 expect(answer.text).toContain('принтер');expect((answer as any).assistantRun.status).toBe('completed');
 expect(await processHelpAssistantJob(job.id,abandoned.leaseToken!)).toBe(false);
 expect(await prisma.helpEvent.count({where:{ticketId:id,messageId:job.messageId,type:'MESSAGE_CREATED'}})).toBe(1);
 const event=await prisma.helpEvent.findFirstOrThrow({where:{ticketId:id,messageId:job.messageId,type:'MESSAGE_CREATED'}});
 expect(await prisma.helpNotification.count({where:{eventId:event.id,userId:owner.userId}})).toBe(1);
});
test('a correction fences a claimed stale job and preserves context in its successor',async()=>{
 const id=await create(),old=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});await due(old.id);
 const claim=await claimHelpAssistantJob();expect(claim?.id).toBe(old.id);
 await sendHelpMessage(id,owner,input('Бумага есть, USB подключен'));
 const jobs=await prisma.helpAssistantJob.findMany({where:{ticketId:id},orderBy:{revision:'asc'}});
 expect(jobs).toHaveLength(2);expect(jobs[0].status).toBe('SUPERSEDED');expect(jobs[1].taskId).toBe(old.taskId);
 expect((jobs[1].context as any[]).length).toBe(2);
 expect(await processHelpAssistantJob(old.id,claim!.leaseToken)).toBe(false);
 await finish(jobs[1].id);
 expect(await prisma.helpEvent.count({where:{ticketId:id,type:'MESSAGE_CREATED',messageId:old.messageId}})).toBe(0);
});
test('stop survives worker retries and never publishes a late final message',async()=>{
 const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});await due(job.id);
 const claim=await claimHelpAssistantJob();expect(claim?.id).toBe(job.id);
 await controlHelpAssistant(id,owner,job.id,false);
 expect(await processHelpAssistantJob(job.id,claim!.leaseToken)).toBe(false);
 expect((await prisma.helpAssistantJob.findUniqueOrThrow({where:{id:job.id}})).status).toBe('STOPPED');
 expect(await prisma.helpEvent.count({where:{ticketId:id,type:'MESSAGE_CREATED',messageId:job.messageId}})).toBe(0);
});
test('the account feed repairs missed progress and answer events with monotone cursors',async()=>{
 const before=await replayHelp(owner,0),id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});await finish(job.id);
 const replay=await replayHelp(owner,before.nextCursor);
 expect(replay.events.filter(event=>event.ticketId===id).length).toBeGreaterThanOrEqual(5);
 expect(replay.events[replay.events.length-1]?.id).toBe(replay.nextCursor);
 const again=await replayHelp(owner,replay.nextCursor);expect(again.events).toHaveLength(0);
});

test('chat and banner acknowledgements suppress only their own device, with durable per-token receipts',async()=>{
 const {Expo}=await import('expo-server-sdk');
 const {updateHelpPresence,acknowledgeHelpNotification,deliverHelpNotification}=await import('../src/modules/help/help.delivery');
 const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});await finish(job.id);
 const event=await prisma.helpEvent.findFirstOrThrow({where:{ticketId:id,messageId:job.messageId,type:'MESSAGE_CREATED'}});
 const notification=await prisma.helpNotification.findUniqueOrThrow({where:{eventId_userId:{eventId:event.id,userId:owner.userId}}});
 const phone='ExponentPushToken[help-qa-phone]',tablet='ExponentPushToken[help-qa-tablet]';
 await prisma.deviceToken.createMany({data:[{userId:owner.userId,token:phone,platform:'android'},{userId:owner.userId,token:tablet,platform:'android'}]});
 expect(await updateHelpPresence(owner.userId,'socket-phone',{sessionId:'session-phone',deviceId:'phone',pushToken:phone,active:true,ticketId:id})).toBe(true);
 expect(await acknowledgeHelpNotification(owner.userId,'wrong-socket',{sessionId:'session-phone',eventId:event.id,kind:'chat'})).toBe(false);
 expect(await acknowledgeHelpNotification(owner.userId,'socket-phone',{sessionId:'session-phone',eventId:event.id,kind:'chat'})).toBe(true);
 const spy=jest.spyOn(Expo.prototype,'sendPushNotificationsAsync');
 try{
  expect(await deliverHelpNotification(notification)).toBe(true);
  const sent=(spy.mock.calls as unknown as [any[]][]).flatMap(call=>call[0]);
  expect(sent.map(message=>message.to)).toEqual([tablet]);
  const calls=spy.mock.calls.length;expect(await deliverHelpNotification(notification)).toBe(true);expect(spy.mock.calls).toHaveLength(calls);
  const receipts=await prisma.helpNotificationDelivery.findMany({where:{notificationId:notification.id}});
  expect(receipts.map(receipt=>receipt.status).sort()).toEqual(['ACCEPTED','SUPPRESSED']);
 }finally{spy.mockRestore();await prisma.deviceToken.deleteMany({where:{userId:owner.userId}});}
});
test('expired presence cannot acknowledge delivery and read messages never schedule another push',async()=>{
 const {updateHelpPresence,acknowledgeHelpNotification,deliverHelpNotification}=await import('../src/modules/help/help.delivery');
 const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});await finish(job.id);
 const event=await prisma.helpEvent.findFirstOrThrow({where:{ticketId:id,messageId:job.messageId,type:'MESSAGE_CREATED'}});
 await updateHelpPresence(owner.userId,'expired-socket',{sessionId:'expired-session',deviceId:'expired-device',active:true,ticketId:id});
 await prisma.helpSession.update({where:{userId_sessionId:{userId:owner.userId,sessionId:'expired-session'}},data:{expiresAt:new Date(0)}});
 expect(await acknowledgeHelpNotification(owner.userId,'expired-socket',{sessionId:'expired-session',eventId:event.id,kind:'chat'})).toBe(false);
 await readHelpTicket(id,owner,(await helpDetail(id,owner)).lastSequence);
 const notification=await prisma.helpNotification.findUniqueOrThrow({where:{eventId_userId:{eventId:event.id,userId:owner.userId}}});
 expect(await deliverHelpNotification(notification)).toBe(true);
});

test('viewing progress before closing the app does not mark the future final answer as read',async()=>{
 const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});
 const progress=await prisma.helpMessage.findUniqueOrThrow({where:{id:job.messageId}});
 await readHelpTicket(id,owner,progress.sequence);
 const whileThinking=await helpDetail(id,owner);expect(whileThinking.lastReadSequence).toBeLessThan(progress.sequence);expect(whileThinking.ticket.unreadCount).toBe(0);
 await finish(job.id);
 const completed=await helpDetail(id,owner);expect(completed.ticket.unreadCount).toBe(1);expect(completed.firstUnreadSequence).toBe(progress.sequence);
});

test('real Socket.IO transport subscribes, receives the committed AI answer and acknowledges its exact chat',async()=>{
 const {createServer}=await import('node:http');const {Server}=await import('socket.io');
 const {registerHelpSocket,publishHelpUpdates}=await import('../src/modules/help/help.socket');
 const http=createServer(),io=new Server(http,{transports:['websocket']});
 io.use((socket,next)=>{socket.data.user={userId:owner.userId,exp:Math.floor(Date.now()/1000)+3600};next();});
 io.on('connection',socket=>registerHelpSocket(io,socket));
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const port=(http.address() as any).port,packets:string[]=[];
 const socket=new (globalThis as any).WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
 socket.addEventListener('message',(event:any)=>{const packet=String(event.data);packets.push(packet);if(packet==='2')socket.send('3');if(packet.startsWith('0'))socket.send('40');});
 const wait=async(predicate:(value:string)=>boolean)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const packet=packets.find(predicate);if(packet)return packet;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Socket acknowledgement timeout');};
 try{
  await wait(packet=>packet.startsWith('40'));
  socket.send('421["help:subscribe",{}]');expect(await wait(packet=>packet.startsWith('431'))).toContain('"ok":true');
  const id=await create(),job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id}});
  socket.send(`422${JSON.stringify(['help:presence',{sessionId:'socket-live-session',deviceId:'qa-device',active:true,ticketId:id}])}`);
  expect(await wait(packet=>packet.startsWith('432'))).toContain('"ok":true');
  await finish(job.id);await publishHelpUpdates(id);
  const packet=await wait(packet=>packet.startsWith('42')&&packet.includes('help:event')&&packet.includes('MESSAGE_CREATED'));
  const [,event]=JSON.parse(packet.slice(2));expect(event.ticketId).toBe(id);expect(event.messageId).toBe(job.messageId);
  socket.send(`423${JSON.stringify(['help:notification-ack',{sessionId:'socket-live-session',eventId:event.id,kind:'chat'}])}`);
  expect(await wait(packet=>packet.startsWith('433'))).toContain('"ok":true');
  expect(await prisma.helpNotificationAck.count({where:{userId:owner.userId,eventId:event.id,kind:'chat'}})).toBe(1);
 }finally{socket.close();await new Promise<void>(resolve=>io.close(()=>resolve()));if(http.listening)await new Promise<void>(resolve=>http.close(()=>resolve()));}
});

test('the additive SQL migration upgrades old message tables without deleting their contents',async()=>{
 const {readFileSync}=await import('node:fs');const path=await import('node:path');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('CREATE SCHEMA assistant_migration_qa');await client.query('SET LOCAL search_path TO assistant_migration_qa');
  await client.query('CREATE TABLE "User"(id INTEGER PRIMARY KEY); CREATE TABLE "HelpTicket"(id INTEGER PRIMARY KEY); CREATE TABLE "HelpMessage"(id INTEGER PRIMARY KEY,"authorId" INTEGER NOT NULL,text TEXT); CREATE TABLE "HelpEvent"(id INTEGER PRIMARY KEY,"actorId" INTEGER NOT NULL); CREATE TABLE "HelpNotification"(id INTEGER PRIMARY KEY); INSERT INTO "HelpMessage" VALUES(1,10,\'retained\')');
  await client.query(readFileSync(path.join(process.cwd(),'prisma/migrations/20261030110000_help_assistant_delivery/migration.sql'),'utf8'));
  const old=await client.query('SELECT text,"authorId","assistantState" FROM "HelpMessage" WHERE id=1');expect(old.rows[0]).toEqual({text:'retained',authorId:10,assistantState:null});
  await client.query('INSERT INTO "HelpMessage"(id,"authorId",text) VALUES(2,NULL,\'assistant\')');
  const tables=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='assistant_migration_qa'");expect(tables.rows.map(row=>row.tablename)).toContain('HelpAssistantJob');
  await client.query('ROLLBACK');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
});
