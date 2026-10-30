import { Server, Socket } from 'socket.io';
import prisma, {pool} from '../../prisma/client';
import { helpActor, requireHelpTicket, visibleHelpWhere } from './help.service';
import { acknowledgeHelpNotification, deliverHelpNotification, maintainHelpDelivery, updateHelpPresence } from './help.delivery';

let helpIo:Server|null=null;
let eventCursor=0;
let polling=false;
const validId=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function isHelpRoom(room:unknown) { return typeof room==='string'&&/^help(?::|$)/i.test(room); }
async function deliverEvent(event:any) {
  if(!helpIo) return;
  const recipients=await prisma.helpMember.findMany({where:{ticketId:event.ticketId},select:{userId:true}});
  const managers=await helpManagerIds();
  const ids=[...new Set([...recipients.map(row=>row.userId),...managers])];
  const sockets=(await Promise.all(ids.map(id=>helpIo!.local.in(`help:user:${id}`).fetchSockets()))).flat();
  await Promise.all(sockets.filter(s=>s.data.helpSubscribed).map(async socket=>{
    try {
      if(socket.data.user?.exp && Date.now()>=socket.data.user.exp*1000) return;
      const actor=await helpActor(Number(socket.data.user?.userId));
      await requireHelpTicket(prisma,event.ticketId,actor);
      socket.emit('help:event',event);
    } catch { /* Revoked access never receives ticket metadata. */ }
  }));
}
export async function publishHelpUpdates(ticketId:number) {
  const event=await prisma.helpEvent.findFirst({where:{ticketId},orderBy:{id:'desc'}});
  if(event) await deliverEvent(event);
}
export function registerHelpSocket(io:Server,socket:Socket) {
  helpIo=io;
  const userId=Number(socket.data.user?.userId);
  let lastTypingAt=0;
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
    if(Date.now()-lastTypingAt<700&&payload.typing) return;
    lastTypingAt=Date.now();
    try {
      const actor=await check();
      const ticket=await requireHelpTicket(prisma,payload.ticketId,actor,false);
      if(ticket.status!=='OPEN') return;
      const user=await prisma.user.findUnique({where:{id:userId},select:{firstName:true,lastName:true,avatarUrl:true,employeeProfile:{select:{avatarUrl:true}}}});
      const ids=[...new Set([...ticket.members.map(member=>member.userId),...await helpManagerIds()])];
      const sockets=(await Promise.all(ids.map(id=>io.local.in(`help:user:${id}`).fetchSockets()))).flat();
      for(const target of sockets) {
        if(!target.data.helpSubscribed||target.data.user?.userId===userId) continue;
        try {
          if(target.data.user?.exp&&Date.now()>=target.data.user.exp*1000) continue;
          const recipient=await helpActor(Number(target.data.user?.userId));
          await requireHelpTicket(prisma,ticket.id,recipient);
          target.emit('help:typing',{ticketId:ticket.id,userId,name:[user?.firstName,user?.lastName].filter(Boolean).join(' ')||'Сотрудник',avatarUrl:user?.employeeProfile?.avatarUrl||user?.avatarUrl||null,typing:payload.typing,expiresAt:Date.now()+5000});
        } catch { /* ACL checked for recipients too. */ }
      }
    } catch { /* Invalid/unauthorized typing is not broadcast. */ }
  });
}
export async function pumpHelp() {
  if(polling) return; polling=true;
  try {
    const events=await prisma.helpEvent.findMany({where:{id:{gt:eventCursor}},orderBy:{id:'asc'},take:200});
    for(const event of events) {await deliverEvent(event);eventCursor=event.id;}
    const notifications=await prisma.helpNotification.findMany({where:{deliveredAt:null,dueAt:{lte:new Date()},attempts:{lt:10}},orderBy:{id:'asc'},take:30});
    for(const row of notifications) {
      // A session advisory lock prevents overlapping push attempts across API replicas.
      const connection=await pool.connect();let locked=false;
      try{
        locked=(await connection.query('SELECT pg_try_advisory_lock(181932, $1::int) AS locked',[row.id])).rows[0].locked;
        if(!locked)continue;
        if(row.attempts===0){
          const event=await prisma.helpEvent.findUnique({where:{id:row.eventId}});
          if(event)await deliverEvent(event);
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
  } catch(error:any) { console.error('[help] delivery retry',{code:error?.code,name:error?.name}); }
  finally {polling=false;}
}
export async function startHelpDelivery(io:Server) {
  helpIo=io;
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
