jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:jest.fn()}}));
jest.mock('../src/modules/help/help.assistant',()=>({cancelHelpAssistant:jest.fn(),enqueueHelpAssistant:jest.fn(),helpAssistantConfiguration:jest.fn()}));
import prisma from '../src/prisma/client';
import {changeHelpStatus,closeHelpByIt,helpItAction,leaveHelpIt,sendHelpMessage} from '../src/modules/help/help.service';
import {cancelHelpAssistant,enqueueHelpAssistant,helpAssistantConfiguration} from '../src/modules/help/help.assistant';
const owner={userId:7,canManage:false},it={userId:8,canManage:true};
let db:any,ticket:any,messages:any[],events:any[];
beforeEach(()=>{
 jest.clearAllMocks();(helpAssistantConfiguration as jest.Mock).mockReturnValue({enabled:true});
 ticket={id:24,ownerId:7,status:'OPEN',closedAt:null,itRequested:false,messageSequence:5,members:[{userId:7,role:'OWNER'}]};messages=[];events=[];
 db={$executeRaw:jest.fn(),helpTicket:{findUnique:jest.fn(async()=>ticket),update:jest.fn(async({data})=>Object.assign(ticket,{...data,...(data.messageSequence?{messageSequence:ticket.messageSequence+data.messageSequence.increment}:{})}))},
  helpMessage:{findUnique:jest.fn(async({where})=>{const key=where.ticketId_authorId_clientMessageId;return messages.find(m=>m.authorId===key.authorId&&m.clientMessageId===key.clientMessageId)??null;}),findFirst:jest.fn(async()=>messages[messages.length-1]??null),create:jest.fn(async({data})=>{const message={id:100+messages.length,...data};messages.push(message);return message;})},
  helpEvent:{findFirst:jest.fn(async({where})=>events.find(e=>e.messageId===where.messageId&&e.type===where.type)??null),create:jest.fn(async({data})=>{const e={id:200+events.length,...data};events.push(e);return e;})},
  helpMember:{findMany:jest.fn(async()=>[]),update:jest.fn(),upsert:jest.fn(async({create})=>{ticket.members.push(create);}),delete:jest.fn(async({where})=>{ticket.members=ticket.members.filter((m:any)=>m.userId!==where.ticketId_userId.userId);})},
  helpNotification:{createMany:jest.fn()},role:{findMany:jest.fn(async()=>[])},user:{findMany:jest.fn(async()=>[]),findUnique:jest.fn(async()=>({lastName:'Иванов',firstName:'Иван'}))},helpAttachment:{findMany:jest.fn(async()=>[])}};
 (prisma.$transaction as jest.Mock).mockImplementation(work=>work(db));
});
test('IT takes over an unrequested AI chat once, using the existing cancellation fence',async()=>{
 await helpItAction(24,it,true);await helpItAction(24,it,true);
 expect(ticket.itRequested).toBe(true);expect(ticket.members).toContainEqual({ticketId:24,userId:8,role:'IT'});
 expect(cancelHelpAssistant).toHaveBeenCalledTimes(1);expect(cancelHelpAssistant).toHaveBeenCalledWith(db,24,'handoff');
 expect(messages).toHaveLength(1);expect(messages[0].text).toBe('Иванов Иван подключился');
 expect(db.$executeRaw).toHaveBeenCalled();
});
test('leaving as last specialist records one real event and restores AI for the next owner message',async()=>{
 await helpItAction(24,it,true);(enqueueHelpAssistant as jest.Mock).mockClear();
 await leaveHelpIt(24,it);await leaveHelpIt(24,it);
 expect(ticket.itRequested).toBe(false);expect(ticket.members).toEqual([{userId:7,role:'OWNER'}]);
 expect(messages[messages.length-1]).toMatchObject({authorId:8,kind:'SYSTEM',text:'Иванов Иван отключился'});
 expect(events.filter(e=>e.type==='IT_LEFT')).toHaveLength(1);
 expect(enqueueHelpAssistant).not.toHaveBeenCalled();
 await sendHelpMessage(24,owner,{clientMessageId:'after-leave',text:'Продолжим'});
 expect(enqueueHelpAssistant).toHaveBeenCalledWith(db,24,7,8,undefined);
});
test('leaving one of several specialists does not return the chat to AI',async()=>{
 await helpItAction(24,it,true);ticket.members.push({ticketId:24,userId:9,role:'IT'});
 await leaveHelpIt(24,it);
 expect(ticket.itRequested).toBe(true);expect(ticket.members).toContainEqual({ticketId:24,userId:9,role:'IT'});
 expect(enqueueHelpAssistant).not.toHaveBeenCalled();
});
test('an owner cannot leave IT membership, and a non-manager cannot take over',async()=>{
 await expect(leaveHelpIt(24,{...owner,canManage:true})).rejects.toMatchObject({code:'HELP_FORBIDDEN'});
 await expect(helpItAction(24,{userId:9,canManage:false},true)).rejects.toMatchObject({code:'HELP_NOT_FOUND'});
 expect(messages).toHaveLength(0);expect(db.helpMember.delete).not.toHaveBeenCalled();
});
test('IT closure contains no fabricated rating; owner feedback preserves closure time and is durable',async()=>{
 await helpItAction(24,it,true);await closeHelpByIt(24,it);
 const closedAt=ticket.closedAt;expect(ticket.status).toBe('CLOSED');expect(closedAt).toBeInstanceOf(Date);
 expect(messages[messages.length-1]).toMatchObject({kind:'SYSTEM',text:'Иванов Иван закрыл обращение'});expect(messages[messages.length-1].rating).toBeUndefined();
 await closeHelpByIt(24,it);expect(events.filter(e=>e.type==='TICKET_CLOSED')).toHaveLength(1);
 const input={clientMessageId:'owner-feedback',text:'Спасибо',rating:4};
 await changeHelpStatus(24,owner,input,'close');await changeHelpStatus(24,owner,input,'close');
 expect(messages[messages.length-1]).toMatchObject({kind:'CLOSURE',rating:4,text:'Спасибо',authorId:7});
 expect(ticket.closedAt).toBe(closedAt);expect(events.filter(e=>e.type==='TICKET_CLOSED')).toHaveLength(1);
 expect(events[events.length-1].type).toBe('MESSAGE_CREATED');
 await expect(changeHelpStatus(24,owner,{...input,clientMessageId:'duplicate-feedback'},'close')).rejects.toMatchObject({code:'HELP_FEEDBACK_ALREADY_SENT'});
 await expect(changeHelpStatus(24,owner,{...input,text:'Подмена'},'close')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
test('rating after IT closure does not restart the 72-hour reopening window',async()=>{
 await helpItAction(24,it,true);await closeHelpByIt(24,it);
 const closedAt=new Date(Date.now()-73*3600_000);ticket.closedAt=closedAt;
 await changeHelpStatus(24,owner,{clientMessageId:'late-feedback',rating:5},'close');
 expect(ticket.closedAt).toBe(closedAt);
 await expect(changeHelpStatus(24,owner,{clientMessageId:'reopen-expired',text:'Снова'},'reopen')).rejects.toMatchObject({code:'REOPEN_EXPIRED'});
});
test('owner can reopen after IT closure without first submitting a rating',async()=>{
 await helpItAction(24,it,true);await closeHelpByIt(24,it);
 await changeHelpStatus(24,owner,{clientMessageId:'reopen',text:'Не решено'},'reopen');
 expect(ticket.status).toBe('OPEN');expect(ticket.closedAt).toBeNull();expect(events[events.length-1].type).toBe('TICKET_REOPENED');
});
test('only an active joined specialist can close, and closed chat cannot be claimed or left',async()=>{
 await expect(closeHelpByIt(24,it)).rejects.toMatchObject({code:'HELP_NOT_FOUND'});
 await helpItAction(24,it,true);
 await expect(closeHelpByIt(24,owner)).rejects.toMatchObject({code:'HELP_FORBIDDEN'});
 await closeHelpByIt(24,it);
 await expect(helpItAction(24,{userId:9,canManage:true},true)).rejects.toMatchObject({code:'TICKET_CLOSED'});
 await expect(leaveHelpIt(24,it)).rejects.toMatchObject({code:'TICKET_CLOSED'});
});
