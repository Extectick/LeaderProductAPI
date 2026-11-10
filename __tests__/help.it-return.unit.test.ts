jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:jest.fn()}}));
jest.mock('../src/modules/help/help.assistant',()=>({cancelHelpAssistant:jest.fn(),enqueueHelpAssistant:jest.fn(),helpAssistantConfiguration:jest.fn()}));
import {createHash} from 'node:crypto';
import prisma from '../src/prisma/client';
import {continueHelpWithAi,helpItAction,sendHelpMessage} from '../src/modules/help/help.service';
import {helpAssistantConfiguration,enqueueHelpAssistant} from '../src/modules/help/help.assistant';
let db:any,ticket:any;const owner={userId:7,canManage:false},it={userId:8,canManage:true};
beforeEach(()=>{
 jest.clearAllMocks();
 (helpAssistantConfiguration as jest.Mock).mockReturnValue({enabled:true});
 ticket={id:24,ownerId:7,status:'OPEN',itRequested:true,messageSequence:4,members:[{userId:7,role:'OWNER'}]};
 db={$executeRaw:jest.fn(),helpTicket:{findUnique:jest.fn(async()=>ticket),update:jest.fn(async({data})=>Object.assign(ticket,{...data,...(data.messageSequence?{messageSequence:ticket.messageSequence+data.messageSequence.increment}:{})}))},
  helpMessage:{findUnique:jest.fn(async()=>null),create:jest.fn(async({data})=>({id:101,...data}))},
  helpEvent:{create:jest.fn(async({data})=>({id:100,...data}))},helpMember:{findMany:jest.fn(async()=>[]),update:jest.fn(),upsert:jest.fn(async({create})=>{ticket.members.push(create);})},
  helpNotification:{createMany:jest.fn()},role:{findMany:jest.fn(async()=>[])},user:{findMany:jest.fn(async()=>[]),findUnique:jest.fn(async()=>({lastName:'Иванов',firstName:'Иван'}))},helpAttachment:{findMany:jest.fn(async()=>[])}};
 (prisma.$transaction as jest.Mock).mockImplementation(work=>work(db));
});
test('return to AI is owner-scoped, durable, idempotent and does not replay the previous prompt',async()=>{
 await continueHelpWithAi(24,owner);await continueHelpWithAi(24,owner);
 expect(ticket.itRequested).toBe(false);expect(ticket.messageSequence).toBe(5);
 expect(db.helpMessage.create).toHaveBeenCalledTimes(1);
 expect(db.helpMessage.create.mock.calls[0][0].data).toMatchObject({kind:'SYSTEM',authorRole:'SYSTEM',authorId:7,text:'Продолжаем с AI'});
 expect(db.helpEvent.create).toHaveBeenCalledWith({data:{ticketId:24,actorId:7,type:'AI_RESUMED',messageId:101}});
 expect(enqueueHelpAssistant).not.toHaveBeenCalled();
 await sendHelpMessage(24,owner,{clientMessageId:'new-input',text:'Продолжим'});
 expect(enqueueHelpAssistant).toHaveBeenCalledWith(db,24,7,6,undefined);
});
test.each(['closed','disabled','joined','other'] as const)('return fails safely for %s',async scenario=>{
 let actor=owner;let code='';
 if(scenario==='closed'){ticket.status='CLOSED';code='TICKET_CLOSED';}
 if(scenario==='disabled'){(helpAssistantConfiguration as jest.Mock).mockReturnValue({enabled:false});code='HELP_AI_DISABLED';}
 if(scenario==='joined'){ticket.members.push({userId:8,role:'IT'});code='HELP_IT_ALREADY_JOINED';}
 if(scenario==='other'){ticket.members.push({userId:8,role:'IT'});actor=it;code='HELP_FORBIDDEN';}
 await expect(continueHelpWithAi(24,actor)).rejects.toMatchObject({code});
 expect(ticket.itRequested).toBe(true);expect(db.helpTicket.update).not.toHaveBeenCalled();expect(db.helpEvent.create).not.toHaveBeenCalled();
});
test('IT may join after owner returned to AI, without a second request',async()=>{
 await continueHelpWithAi(24,owner);
 await helpItAction(24,it,true);
 expect(db.helpMember.upsert).toHaveBeenCalledTimes(1);expect(ticket.itRequested).toBe(true);
});
test('claim wins before cancel: normal messaging resumes and join has the real surname-first author text',async()=>{
 await helpItAction(24,it,true);await helpItAction(24,it,true);
 expect(db.helpMember.upsert).toHaveBeenCalledTimes(1);
 expect(db.helpMessage.create.mock.calls[0][0].data).toMatchObject({authorId:8,kind:'SYSTEM',text:'Иванов Иван подключился'});
 await expect(continueHelpWithAi(24,owner)).rejects.toMatchObject({code:'HELP_IT_ALREADY_JOINED'});
 await sendHelpMessage(24,owner,{clientMessageId:'after-join',text:'Здравствуйте'});
 expect(db.helpMessage.create).toHaveBeenCalledTimes(2);
});
test('pending IT blocks new sends but returns the committed receipt for a durable retry',async()=>{
 const input={clientMessageId:'durable-original',text:'Исходное сообщение'};
 await expect(sendHelpMessage(24,owner,input)).rejects.toMatchObject({code:'HELP_WAITING_FOR_IT'});
 expect(db.helpMessage.create).not.toHaveBeenCalled();expect(enqueueHelpAssistant).not.toHaveBeenCalled();
 const requestHash=createHash('sha256').update(JSON.stringify({kind:'TEXT',text:input.text,attachmentIds:[],replyToId:null,forwardedFromId:null,rating:null,sourceTicketId:null})).digest('hex');
 db.helpMessage.findUnique.mockResolvedValue({id:90,requestHash});
 await expect(sendHelpMessage(24,owner,input)).resolves.toBeUndefined();
 await expect(sendHelpMessage(24,owner,{...input,text:'Подмена'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect(db.helpMessage.create).not.toHaveBeenCalled();
});
test('an owner with management rights cannot create a fake self-join',async()=>{
 await expect(helpItAction(24,{...owner,canManage:true},true)).rejects.toMatchObject({code:'HELP_FORBIDDEN'});
 expect(db.helpMember.upsert).not.toHaveBeenCalled();expect(db.helpMessage.create).not.toHaveBeenCalled();
});
