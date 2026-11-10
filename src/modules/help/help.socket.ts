import { Server, Socket } from 'socket.io';
import prisma, {pool} from '../../prisma/client';
import { helpActor, requireHelpTicket } from './help.service';
import { acknowledgeHelpNotification, deliverHelpNotification, maintainHelpDelivery, updateHelpPresence } from './help.delivery';

let helpIo:Server|null=null;
let eventCursor=0;
let polling=false;
let pollingNotifications=false;
const validId=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function isHelpRoom(room:unknown) { return typeof room==='string'&&/^help(?::|$)/i.test(room); }
type DeliverySocket = Awaited<ReturnType<Server['fetchSockets']>>[number];
const liveSubscriber=(socket:DeliverySocket)=>socket.data.helpSubscribed&&validId(Number(socket.data.user?.userId))&&(!socket.data.user?.exp||Date.now()<socket.data.user.exp*1000);
/** Deduplicate only transport deliveries, never cache authorization across events. */
const recentDeliveries=new Map<number,{at:number;sockets:Set<string>}>();
const eventJobs=new Map<number,Promise<void>>();
const ticketPublications=new Map<number,{again:boolean;work:Promise<void>}>();
async function recipientSockets(io:Server,ids:number[]) {
  if(!ids.length)return [];
  // One local adapter lookup also deduplicates sessions that share several rooms.
  return io.local.in([...new Set(ids)].map(id=>`help:user:${id}`)).fetchSockets();
}
async function authorizedRecipients(sockets:DeliverySocket[],ticketId:number,emit:(socket:DeliverySocket)=>void) {
  const users=new Map<number,DeliverySocket[]>();
  for(const socket of sockets){
    if(!liveSubscriber(socket))continue;
    const id=Number(socket.data.user.userId),sessions=users.get(id)??[];
    sessions.push(socket);users.set(id,sessions);
  }
  const entries=[...users];let next=0;
  // Bound DB pressure for a large IT queue; each user is checked once per event.
  await Promise.all(Array.from({length:Math.min(8,entries.length)},async()=>{
    while(next<entries.length){
      const [id,sessions]=entries[next++];
      try{
        const actor=await helpActor(id);
        await requireHelpTicket(prisma,ticketId,actor);
        for(const socket of sessions)if(liveSubscriber(socket))emit(socket);
      }catch{ /* Revoked access never receives ticket metadata. */ }
    }
  }));
}
async function deliverEvent(event:any,repeat=false):Promise<void> {
  if(!helpIo)return;
  const running=eventJobs.get(event.id);
  if(running){await running;return deliverEvent(event,repeat);}
  const io=helpIo;
  const work=(async()=>{
    const [recipients,managers]=await Promise.all([
      prisma.helpMember.findMany({where:{ticketId:event.ticketId},select:{userId:true}}),helpManagerIds(),
    ]);
    const sockets=await recipientSockets(io,[...recipients.map(row=>row.userId),...managers]);
    const now=Date.now();
    for(const [id,value] of recentDeliveries)if(now-value.at>5000)recentDeliveries.delete(id);
    let delivered=recentDeliveries.get(event.id);
    if(!delivered){delivered={at:now,sockets:new Set()};recentDeliveries.set(event.id,delivered);}
    while(recentDeliveries.size>2048)recentDeliveries.delete(recentDeliveries.keys().next().value!);
    const seen=delivered.sockets;
    await authorizedRecipients(sockets.filter(socket=>repeat||!seen.has(socket.id)),event.ticketId,socket=>{
      socket.emit('help:event',event);seen.add(socket.id);
    });
  })();
  eventJobs.set(event.id,work);
  try{await work;}finally{if(eventJobs.get(event.id)===work)eventJobs.delete(event.id);}
}
export function publishHelpUpdates(ticketId:number):Promise<void> {
  const pending=ticketPublications.get(ticketId);
  if(pending){pending.again=true;return pending.work;}
  const job={again:false,work:Promise.resolve()};
  // Each call is only a wakeup. While delivery is busy, merge further wakeups
  // and then fetch the newest committed event. REST replay retains every event.
  job.work=Promise.resolve().then(async()=>{
    do {
      job.again=false;
      const event=await prisma.helpEvent.findFirst({where:{ticketId},orderBy:{id:'desc'}});
      if(event)await deliverEvent(event);
    }while(job.again);
  }).finally(()=>{if(ticketPublications.get(ticketId)===job)ticketPublications.delete(ticketId);});
  ticketPublications.set(ticketId,job);
  return job.work;
}
export async function publishHelpUpdatesBatch(ids:number[]) {
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
    while(next<ids.length){
      const id=ids[next++];
      await publishHelpUpdates(id).catch(error=>console.warn('[help] live delivery deferred',{code:error?.code}));
    }
  }));
}
export function registerHelpSocket(io:Server,socket:Socket) {
  helpIo=io;
  const userId=Number(socket.data.user?.userId);
  let lastTypingAt=0;
  let lastTypingTicket:number|undefined,lastTypingState:boolean|undefined;
  const check=async()=>{
    if(socket.data.user?.exp&&Date.now()>=socket.data.user.exp*1000) throw new Error('Expired');
    return helpActor(userId);
  };
  socket.on('help:subscribe',async(payload:any={},ack?:Function)=>{
    try {
      const actor=await check();
      if(payload.ticketId!==undefined) {
        if(!validId(payload.ticketId)) throw new Error('Bad ticket');
        await requireHelpTicket(prisma,payload.ticketId,actor);
      }
      socket.data.helpSubscribed=true;await socket.join(`help:user:${userId}`);
      if(typeof ack==='function') ack({ok:true});
    } catch { if(typeof ack==='function') ack({ok:false,code:'HELP_FORBIDDEN'}); }
  });
  socket.on('help:unsubscribe',()=>{socket.data.helpSubscribed=false;void socket.leave(`help:user:${userId}`);});
  socket.on('help:presence',async(payload:any,ack?:Function)=>{try{await check();const ok=await updateHelpPresence(userId,socket.id,payload);if(typeof ack==='function')ack({ok});}catch{if(typeof ack==='function')ack({ok:false});}});
  const notificationAck=async(payload:any,ack?:Function)=>{try{await check();const ok=await acknowledgeHelpNotification(userId,socket.id,payload);if(typeof ack==='function')ack({ok});}catch{if(typeof ack==='function')ack({ok:false});}};
  socket.on('help:notification-ack',notificationAck);socket.on('help:notification:ack',notificationAck);
  socket.on('disconnect',()=>{void prisma.helpSession.updateMany({where:{userId,socketId:socket.id},data:{active:false,ticketId:null,expiresAt:new Date()}}).catch(()=>{});});
  socket.on('help:typing',async(payload:any)=>{
    if(!payload||!validId(payload.ticketId)||typeof payload.typing!=='boolean') return;
    // Deliver true -> false immediately, but suppress repeated stop packets.
    // Recheck false after the throttle window so a transient delivery failure
    // never suppresses that state forever.
    if(Date.now()-lastTypingAt<700&&(payload.typing||lastTypingState===false&&lastTypingTicket===payload.ticketId)) return;
    lastTypingAt=Date.now();
    lastTypingState=payload.typing;lastTypingTicket=payload.ticketId;
    try {
      const actor=await check();
      const ticket=await requireHelpTicket(prisma,payload.ticketId,actor,false);
      if(ticket.status!=='OPEN') return;
      const user=await prisma.user.findUnique({where:{id:userId},select:{firstName:true,lastName:true,avatarUrl:true,employeeProfile:{select:{avatarUrl:true}}}});
      const sockets=await recipientSockets(io,[...ticket.members.map(member=>member.userId),...await helpManagerIds()]);
      const typing={ticketId:ticket.id,userId,name:[user?.firstName,user?.lastName].filter(Boolean).join(' ')||'Сотрудник',avatarUrl:user?.employeeProfile?.avatarUrl||user?.avatarUrl||null,typing:payload.typing,expiresAt:Date.now()+5000};
      await authorizedRecipients(sockets.filter(target=>Number(target.data.user?.userId)!==userId),ticket.id,target=>target.emit('help:typing',typing));
    } catch { /* Invalid/unauthorized typing is not broadcast. */ }
  });
}
async function pumpHelpEvents() {
  if(polling) return; polling=true;
  try {
    const events=await prisma.helpEvent.findMany({where:{id:{gt:eventCursor}},orderBy:{id:'asc'},take:200});
    const latestAssistant=new Map<string,number>();
    for(const event of events)if(event.type==='ASSISTANT_UPDATED'&&event.messageId!==null&&event.messageId!==undefined)latestAssistant.set(`${event.ticketId}:${event.messageId}`,event.id);
    for(const event of events) {
      // Only transport wakeups are coalesced. Never edit the journal, skip final
      // events, or advance a cursor past a delivery that failed.
      const superseded=event.type==='ASSISTANT_UPDATED'&&event.messageId!==null&&event.messageId!==undefined&&latestAssistant.get(`${event.ticketId}:${event.messageId}`)!==event.id;
      if(!superseded)await deliverEvent(event);
      eventCursor=event.id;
    }
  } catch(error:any) { console.error('[help] event delivery retry',{code:error?.code,name:error?.name}); }
  finally {polling=false;}
}
async function pumpHelpNotifications() {
  if(pollingNotifications)return;pollingNotifications=true;
  try {
    const notifications=await prisma.helpNotification.findMany({where:{deliveredAt:null,dueAt:{lte:new Date()},attempts:{lt:10}},orderBy:{id:'asc'},take:30});
    for(const row of notifications) {
      // A session advisory lock prevents overlapping push attempts across API replicas.
      const connection=await pool.connect();let locked=false;
      try{
        locked=(await connection.query('SELECT pg_try_advisory_lock(181932, $1::int) AS locked',[row.id])).rows[0].locked;
        if(!locked)continue;
        if(row.attempts===0){
          const event=await prisma.helpEvent.findUnique({where:{id:row.eventId}});
          if(event)await deliverEvent(event,true);
          await prisma.helpNotification.updateMany({where:{id:row.id,deliveredAt:null,attempts:0},data:{dueAt:new Date(Date.now()+2500),attempts:{increment:1}}});
          continue;
        }
        const claimed=await prisma.helpNotification.updateMany({where:{id:row.id,deliveredAt:null,dueAt:{lte:new Date()}},data:{dueAt:new Date(Date.now()+60000),attempts:{increment:1}}});
        if(!claimed.count)continue;
        const ok=await deliverHelpNotification(row);
        await prisma.helpNotification.update({where:{id:row.id},data:ok?{deliveredAt:new Date()}:{dueAt:new Date(Date.now()+Math.min(3600000,15000*2**row.attempts))}});
      }finally{
        if(locked)await connection.query('SELECT pg_advisory_unlock(181932, $1::int)',[row.id]).catch(()=>{});
        connection.release();
      }
    }
  } catch(error:any) { console.error('[help] notification delivery retry',{code:error?.code,name:error?.name}); }
  finally {pollingNotifications=false;}
}
export async function pumpHelp() {
  // Push providers may be slow; their retries must never stop the live-event cursor.
  await Promise.all([pumpHelpEvents(),pumpHelpNotifications()]);
}
export async function startHelpDelivery(io:Server) {
  helpIo=io;recentDeliveries.clear();
  eventCursor=(await prisma.helpEvent.findFirst({orderBy:{id:'desc'},select:{id:true}}))?.id||0;
  const timer=setInterval(()=>void pumpHelp(),500);timer.unref();
  void pumpHelp();
  const maintenance=setInterval(()=>void maintainHelpDelivery().catch(error=>console.warn('[help] maintenance retry',{code:error?.code})),6*3600000);maintenance.unref();
  return ()=>{clearInterval(timer);clearInterval(maintenance);};
}

let managersAt=0,managerIds:number[]=[];
async function helpManagerIds(){
 if(Date.now()-managersAt<30000)return managerIds;
 const roles=await prisma.role.findMany({select:{id:true,name:true,parentRoleId:true,permissions:{where:{permission:{name:'manage_help'}},select:{permissionId:true}}}});
 const ids=new Set(roles.filter(role=>role.permissions.length||['admin','administrator'].includes(role.name)).map(role=>role.id));
 for(let i=0;i<roles.length;i++)for(const role of roles)if(role.parentRoleId&&ids.has(role.parentRoleId))ids.add(role.id);
 managerIds=(await prisma.user.findMany({where:{isActive:true,deletedAt:null,OR:[{roleId:{in:[...ids]}},{departmentRoles:{some:{roleId:{in:[...ids]}}}}]},select:{id:true}})).map(user=>user.id);managersAt=Date.now();return managerIds;
}
