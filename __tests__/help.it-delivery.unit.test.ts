jest.mock('../src/prisma/client',()=>({__esModule:true,default:{
 helpMessage:{findUnique:jest.fn()},helpEvent:{findUnique:jest.fn(),findFirst:jest.fn()},userNotificationSettings:{findUnique:jest.fn()},deviceToken:{findMany:jest.fn()},helpNotificationDelivery:{findMany:jest.fn(),upsert:jest.fn()},helpNotificationAck:{findMany:jest.fn()},helpSession:{findMany:jest.fn(),upsert:jest.fn()},
}}));
jest.mock('../src/modules/help/help.service',()=>({helpActor:jest.fn(),requireHelpTicket:jest.fn()}));
jest.mock('../src/services/pushService',()=>({sendPushToUser:jest.fn()}));
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {sendPushToUser} from '../src/services/pushService';
import {deliverHelpNotification,updateHelpPresence} from '../src/modules/help/help.delivery';
const db=prisma as any,row={id:1,userId:8,ticketId:24,messageId:101,eventId:102};
beforeEach(()=>{
 jest.clearAllMocks();
 (helpActor as jest.Mock).mockResolvedValue({userId:8,canManage:true});
 (requireHelpTicket as jest.Mock).mockResolvedValue({id:24,title:'Проверка',itRequested:true,members:[]});
 db.helpMessage.findUnique.mockResolvedValue({text:'Вызван IT-специалист',authorRole:'SYSTEM',sequence:3});
 db.helpEvent.findUnique.mockResolvedValue({type:'IT_REQUESTED'});db.helpEvent.findFirst.mockResolvedValue({id:102});
 db.userNotificationSettings.findUnique.mockResolvedValue(null);db.deviceToken.findMany.mockResolvedValue([{token:'ExponentPushToken[test]'}]);
 db.helpNotificationDelivery.findMany.mockResolvedValue([]);db.helpNotificationAck.findMany.mockResolvedValue([]);db.helpSession.findMany.mockResolvedValue([]);
 (sendPushToUser as jest.Mock).mockResolvedValue({ok:true});
});
test.each([false,true])('obsolete queued request push is suppressed after return/join (joined=%s)',async joined=>{
 (requireHelpTicket as jest.Mock).mockResolvedValue({id:24,itRequested:joined,members:joined?[{userId:9,role:'IT'}]:[]});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();expect(db.deviceToken.findMany).not.toHaveBeenCalled();
});
test('handoff system message has the ticket notification title, not the assistant title',async()=>{
 expect(await deliverHelpNotification(row)).toBe(true);
 expect(sendPushToUser).toHaveBeenCalledWith(8,expect.objectContaining({title:'Вызов IT-специалиста',body:'Обращение #24: Проверка',channelId:'help-it-request',priority:'high',data:expect.objectContaining({type:'HELP_MESSAGE',eventType:'IT_REQUESTED',recipientUserId:8})}),expect.any(Object));
});

test('queued creation notifications from an older release never turn into IT alerts',async()=>{
 db.helpEvent.findUnique.mockResolvedValue({type:'TICKET_CREATED'});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();expect(db.deviceToken.findMany).not.toHaveBeenCalled();
});
test('IT calls are independent from ordinary new-message preferences',async()=>{
 db.userNotificationSettings.findUnique.mockResolvedValue({inAppNotificationsEnabled:true,pushNewMessage:false});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).toHaveBeenCalledTimes(1);
});
test('global notifications off still prevents an IT system notification',async()=>{
 db.userNotificationSettings.findUnique.mockResolvedValue({inAppNotificationsEnabled:false,pushNewMessage:true});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();
});
test('a revoked IT permission cannot receive a queued IT call',async()=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:8,canManage:false});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();
});
test('the caller never receives their own IT alert from an old queued record',async()=>{
 (requireHelpTicket as jest.Mock).mockResolvedValue({id:24,ownerId:8,itRequested:true,members:[]});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();
});
test('a banner ACK suppresses only that device and keeps the other device eligible',async()=>{
 db.deviceToken.findMany.mockResolvedValue([{token:'ExponentPushToken[test]'},{token:'ExponentPushToken[other]'}]);
 db.helpNotificationAck.findMany.mockResolvedValue([{sessionId:'active'}]);
 db.helpSession.findMany.mockResolvedValue([{sessionId:'active',deviceId:'ExponentPushToken[test]'}]);
 expect(await deliverHelpNotification(row)).toBe(true);
 expect(sendPushToUser).toHaveBeenCalledTimes(1);
 expect(sendPushToUser).toHaveBeenCalledWith(8,expect.objectContaining({channelId:'help-it-request'}),{includeTokens:['ExponentPushToken[other]']});
});
test('a confirmed web chat suppresses both phone pushes with durable receipts',async()=>{
 db.helpEvent.findUnique.mockResolvedValue({type:'MESSAGE_CREATED'});
 db.deviceToken.findMany.mockResolvedValue([{token:'ExponentPushToken[test]'},{token:'ExponentPushToken[other]'}]);
 db.helpNotificationAck.findMany.mockResolvedValue([{sessionId:'web-session',kind:'chat'}]);
 db.helpSession.findMany.mockResolvedValue([{sessionId:'web-session',deviceId:'web-installation',active:true,ticketId:24,expiresAt:new Date(Date.now()+45000)}]);
 expect(await deliverHelpNotification(row)).toBe(true);
 expect(sendPushToUser).not.toHaveBeenCalled();expect(db.helpNotificationDelivery.upsert).toHaveBeenCalledTimes(2);
 for(const [call] of db.helpNotificationDelivery.upsert.mock.calls)expect(call.create.status).toBe('SUPPRESSED');
 expect(db.helpNotificationAck.findMany).toHaveBeenCalledWith({where:{userId:8,eventId:102}});
});
test('inactive phone presence keeps the active browser session in its own per-user session row',async()=>{
 await updateHelpPresence(8,'socket-web',{sessionId:'session-web',deviceId:'web-installation',active:true,ticketId:24});
 await updateHelpPresence(8,'socket-phone',{sessionId:'session-phone',deviceId:'phone-installation',active:false,ticketId:24});
 expect(db.helpSession.upsert.mock.calls.map(([call]:any[])=>call.where)).toEqual([{userId_sessionId:{userId:8,sessionId:'session-web'}},{userId_sessionId:{userId:8,sessionId:'session-phone'}}]);
 expect(db.helpSession.upsert.mock.calls[0][0].update).toMatchObject({active:true,ticketId:24,socketId:'socket-web'});
 expect(db.helpSession.upsert.mock.calls[1][0].update).toMatchObject({active:false,ticketId:null,socketId:'socket-phone'});
});
test('a previously accepted IT request is not sent to the same token twice',async()=>{
 const {helpTokenHash}=await import('../src/modules/help/help.delivery');
 db.helpNotificationDelivery.findMany.mockResolvedValue([{tokenHash:helpTokenHash('ExponentPushToken[test]'),status:'ACCEPTED'}]);
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();
});

test('an earlier call cannot alert again after return to AI and a new confirmed call',async()=>{
 db.helpEvent.findFirst.mockResolvedValue({id:103});
 expect(await deliverHelpNotification(row)).toBe(true);expect(sendPushToUser).not.toHaveBeenCalled();
});
