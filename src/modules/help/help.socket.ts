import { Server, Socket } from 'socket.io';
import prisma from '../../prisma/client';
import { helpActor, requireHelpTicket, visibleHelpWhere } from './help.service';
import { sendPushToUser } from '../../services/pushService';

let helpIo:Server|null=null;
let eventCursor=0;
let polling=false;
const validId=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function isHelpRoom(room:unknown) { return typeof room==='string'&&/^help(?::|$)/i.test(room); }
async function deliverEvent(event:any) {
  if(!helpIo) return;
  const sockets=await helpIo.fetchSockets();
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
      socket.data.helpSubscribed=true;
      if(typeof ack==='function') ack({ok:true});
    } catch { if(typeof ack==='function') ack({ok:false,code:'HELP_FORBIDDEN'}); }
  });
  socket.on('help:unsubscribe',()=>{socket.data.helpSubscribed=false;});
  socket.on('help:typing',async(payload:any)=>{
    if(!payload||!validId(payload.ticketId)||typeof payload.typing!=='boolean') return;
    if(Date.now()-lastTypingAt<700&&payload.typing) return;
    lastTypingAt=Date.now();
    try {
      const actor=await check();
      const ticket=await requireHelpTicket(prisma,payload.ticketId,actor,false);
      if(ticket.status!=='OPEN') return;
      const user=await prisma.user.findUnique({where:{id:userId},select:{firstName:true,lastName:true}});
      const sockets=await io.fetchSockets();
      for(const target of sockets) {
        if(!target.data.helpSubscribed||target.data.user?.userId===userId) continue;
        try {
          if(target.data.user?.exp&&Date.now()>=target.data.user.exp*1000) continue;
          const recipient=await helpActor(Number(target.data.user?.userId));
          await requireHelpTicket(prisma,ticket.id,recipient);
          target.emit('help:typing',{ticketId:ticket.id,userId,name:[user?.firstName,user?.lastName].filter(Boolean).join(' ')||'Сотрудник',typing:payload.typing,expiresAt:Date.now()+5000});
        } catch { /* ACL checked for recipients too. */ }
      }
    } catch { /* Invalid/unauthorized typing is not broadcast. */ }
  });
}
async function deliverNotification(row:any) {
  try {
    const actor=await helpActor(row.userId);
    const ticket=await requireHelpTicket(prisma,row.ticketId,actor);
    const member=ticket.members.find(m=>m.userId===row.userId);
    const message=row.messageId?await prisma.helpMessage.findUnique({where:{id:row.messageId}}):null;
    const event=await prisma.helpEvent.findUnique({where:{id:row.eventId},select:{type:true}});
    const settings=await prisma.userNotificationSettings.findUnique({where:{userId:row.userId}});
    const statusEvent=event?.type==='TICKET_CLOSED'||event?.type==='TICKET_REOPENED';
    if(settings?.inAppNotificationsEnabled===false||(statusEvent?settings?.pushStatusChanged===false:settings?.pushNewMessage===false)||(message&&member&&member.lastReadSequence>=message.sequence)) return true;
    const result=await sendPushToUser(row.userId,{title:`Обращение #${ticket.id}`,body:message?'Новое сообщение в обращении':(ticket.status==='CLOSED'?'Обращение закрыто':'Обращение обновлено'),channelId:'help-message',data:{type:'HELP_MESSAGE',ticketId:ticket.id,messageId:row.messageId,eventId:row.eventId}});
    return result.ok||result.reason==='no_tokens';
  } catch(error:any) { return error?.status===403||error?.status===404; }
}
async function pumpHelp() {
  if(polling) return; polling=true;
  try {
    const events=await prisma.helpEvent.findMany({where:{id:{gt:eventCursor}},orderBy:{id:'asc'},take:200});
    for(const event of events) {await deliverEvent(event);eventCursor=event.id;}
    const notifications=await prisma.helpNotification.findMany({where:{deliveredAt:null,dueAt:{lte:new Date()},attempts:{lt:10}},orderBy:{id:'asc'},take:30});
    for(const row of notifications) {
      const claimed=await prisma.helpNotification.updateMany({where:{id:row.id,deliveredAt:null,dueAt:{lte:new Date()}},data:{dueAt:new Date(Date.now()+60000),attempts:{increment:1}}});
      if(!claimed.count) continue;
      const ok=await deliverNotification(row);
      await prisma.helpNotification.update({where:{id:row.id},data:ok?{deliveredAt:new Date()}:{dueAt:new Date(Date.now()+Math.min(3600000,15000*2**row.attempts))}});
    }
  } catch(error:any) { console.error('[help] delivery retry',{code:error?.code,name:error?.name}); }
  finally {polling=false;}
}
export async function startHelpDelivery(io:Server) {
  helpIo=io;
  eventCursor=(await prisma.helpEvent.findFirst({orderBy:{id:'desc'},select:{id:true}}))?.id||0;
  const timer=setInterval(()=>void pumpHelp(),3000);timer.unref();
  void pumpHelp();
  return ()=>clearInterval(timer);
}
