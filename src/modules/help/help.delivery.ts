import {createHash} from 'node:crypto';
import {Expo} from 'expo-server-sdk';
import prisma from '../../prisma/client';
import {helpActor,requireHelpTicket} from './help.service';
import {sendPushToUser} from '../../services/pushService';
export const HELP_SESSION_TTL_MS=45000;
export const helpTokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function helpNotificationSuppressed(token:string,acks:Array<{sessionId:string}>,sessions:Array<{sessionId:string;deviceId:string}>) {
  return acks.some(ack=>sessions.some(session=>session.sessionId===ack.sessionId&&session.deviceId===token));
}
/** A presence hint alone never suppresses a push: the current event needs an ACK. */
export async function deliverHelpNotification(row:{id:number;userId:number;ticketId:number;messageId:number|null;eventId:number}) {
  try{
    const actor=await helpActor(row.userId),ticket=await requireHelpTicket(prisma,row.ticketId,actor);
    const member=ticket.members.find(item=>item.userId===row.userId);
    const message=row.messageId?await prisma.helpMessage.findUnique({where:{id:row.messageId}}):null;
    const event=await prisma.helpEvent.findUnique({where:{id:row.eventId},select:{type:true}});
    const settings=await prisma.userNotificationSettings.findUnique({where:{userId:row.userId}});
    const statusEvent=['TICKET_CLOSED','TICKET_REOPENED'].includes(event?.type??'');
    if((statusEvent?settings?.pushStatusChanged===false:settings?.pushNewMessage===false)||(message&&member&&member.lastReadSequence>=message.sequence))return true;
    const tokens=(await prisma.deviceToken.findMany({where:{userId:row.userId},select:{token:true}})).map(item=>item.token).filter(token=>Expo.isExpoPushToken(token));
    if(!tokens.length)return true;
    const [receipts,acks,sessions]=await Promise.all([
      prisma.helpNotificationDelivery.findMany({where:{notificationId:row.id}}),
      prisma.helpNotificationAck.findMany({where:{userId:row.userId,eventId:row.eventId}}),
      prisma.helpSession.findMany({where:{userId:row.userId}}),
    ]);
    let complete=true;
    for(const token of tokens){
      const tokenHash=helpTokenHash(token);
      if(receipts.some(receipt=>receipt.tokenHash===tokenHash))continue;
      const suppressed=helpNotificationSuppressed(token,acks,sessions);
      let status=suppressed?'SUPPRESSED':'';
      if(!suppressed){
        const result=await sendPushToUser(row.userId,{title:message?.authorRole==='SYSTEM'?`ИИ · ${ticket.title}`:`Обращение #${ticket.id}`,body:message?message.text.slice(0,160):ticket.status==='CLOSED'?'Обращение закрыто':'Обращение обновлено',channelId:'help-message',data:{type:'HELP_MESSAGE',recipientUserId:row.userId,ticketId:ticket.id,messageId:row.messageId,eventId:row.eventId,assistant:Boolean(message?.assistantState),senderRole:message?.authorRole,ticketTitle:ticket.title,preview:message?.text.slice(0,160)}}, {includeTokens:[token]});
        if(result.ok)status='ACCEPTED';else if(result.reason==='no_tokens')status='INVALID';else complete=false;
      }
      if(status)await prisma.helpNotificationDelivery.upsert({where:{notificationId_tokenHash:{notificationId:row.id,tokenHash}},create:{notificationId:row.id,tokenHash,status},update:{status}});
    }
    return complete;
  }catch(error:any){return error?.status===403||error?.status===404;}
}
export async function updateHelpPresence(userId:number,socketId:string,input:any) {
  if(typeof input?.sessionId!=='string'||input.sessionId.length<8||input.sessionId.length>200||typeof input.deviceId!=='string'||input.deviceId.length>250||typeof input.active!=='boolean')return false;
  const actor=await helpActor(userId);
  const id=input.ticketId??null;
  if(id!==null){if(!Number.isSafeInteger(id)||id<=0)return false;await requireHelpTicket(prisma,id,actor);}
  let deviceId=input.deviceId;
  if(typeof input.pushToken==='string'&&input.pushToken.length<250&&await prisma.deviceToken.findFirst({where:{userId,token:input.pushToken}}))deviceId=input.pushToken;
  else if(Expo.isExpoPushToken(deviceId)&&!await prisma.deviceToken.findFirst({where:{userId,token:deviceId}}))return false;
  await prisma.helpSession.upsert({where:{userId_sessionId:{userId,sessionId:input.sessionId}},create:{userId,sessionId:input.sessionId,socketId,deviceId,active:input.active,ticketId:input.active?id:null,expiresAt:new Date(Date.now()+HELP_SESSION_TTL_MS)},update:{socketId,deviceId,active:input.active,ticketId:input.active?id:null,expiresAt:new Date(Date.now()+HELP_SESSION_TTL_MS)}});
  return true;
}
export async function acknowledgeHelpNotification(userId:number,socketId:string,input:any) {
  const kind=input?.kind??input?.disposition;
  if(!Number.isSafeInteger(input?.eventId)||typeof input.sessionId!=='string'||!['chat','banner'].includes(kind))return false;
  const session=await prisma.helpSession.findUnique({where:{userId_sessionId:{userId,sessionId:input.sessionId}}});
  if(!session?.active||session.socketId!==socketId||session.expiresAt.getTime()<Date.now())return false;
  const event=await prisma.helpEvent.findUnique({where:{id:input.eventId}});if(!event)return false;
  await requireHelpTicket(prisma,event.ticketId,await helpActor(userId));
  if(kind==='chat'&&session.ticketId!==event.ticketId)return false;
  await prisma.helpNotificationAck.upsert({where:{userId_eventId_sessionId:{userId,eventId:event.id,sessionId:input.sessionId}},create:{userId,eventId:event.id,sessionId:input.sessionId,kind},update:{kind}});
  return true;
}
/** Bounded maintenance preserves unsent notifications and every user message. */
export async function maintainHelpDelivery(now=new Date()) {
  const cutoff=new Date(now.getTime()-30*86400000),jobsCutoff=new Date(now.getTime()-180*86400000);
  return prisma.$transaction(async db=>{
    const sessions=await db.helpSession.deleteMany({where:{expiresAt:{lt:cutoff}}});
    const acknowledgements=await db.helpNotificationAck.deleteMany({where:{createdAt:{lt:cutoff}}});
    const notifications=await db.helpNotification.deleteMany({where:{deliveredAt:{lt:cutoff}}});
    const jobs=await db.helpAssistantJob.deleteMany({where:{status:'COMPLETED',completedAt:{lt:jobsCutoff}}});
    return {sessions:sessions.count,acknowledgements:acknowledgements.count,notifications:notifications.count,jobs:jobs.count};
  });
}
export async function helpDeliveryDiagnostics() {
  const [queued,running,failed,pendingNotifications,exhaustedNotifications,oldest]=await Promise.all([
    prisma.helpAssistantJob.count({where:{status:'QUEUED'}}),
    prisma.helpAssistantJob.count({where:{status:'RUNNING'}}),
    prisma.helpAssistantJob.count({where:{status:'ERROR'}}),
    prisma.helpNotification.count({where:{deliveredAt:null,attempts:{lt:10}}}),
    prisma.helpNotification.count({where:{deliveredAt:null,attempts:{gte:10}}}),
    prisma.helpNotification.findFirst({where:{deliveredAt:null,attempts:{lt:10}},orderBy:{createdAt:'asc'},select:{createdAt:true}}),
  ]);
  return {queued,running,failed,pendingNotifications,exhaustedNotifications,oldestNotificationAgeMs:oldest?Math.max(0,Date.now()-oldest.createdAt.getTime()):0};
}
