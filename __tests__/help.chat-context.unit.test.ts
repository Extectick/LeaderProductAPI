jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpTicket:{findUnique:jest.fn()},helpEvent:{findMany:jest.fn(),findFirst:jest.fn()},helpMessage:{findMany:jest.fn(),findFirst:jest.fn()}}}));
import prisma from '../src/prisma/client';
import {helpChatContext,helpClientContextSchema,parseHelpClientContext,helpMessageAuthor} from '../src/modules/help/help.chat-context';
const client={v:1 as const,app:{platform:'android' as const,version:'0.1.46.19',nativeVersion:'0.1.46',build:'45',developmentClient:true},
 locale:'ru-RU',timeZone:'Asia/Novosibirsk',origin:{screen:'/services/[id]',state:'previous' as const,capturedAt:'2026-11-05T12:00:00.000Z',target:{v:1,source:'app',kind:'user',id:'7'}}};
const ticket={ownerId:7,status:'OPEN',itRequested:false,members:[{userId:7,role:'OWNER',user:{isActive:true,deletedAt:null,profileStatus:'APPROVED',firstName:'Иван',lastName:'Петров'}}]};
beforeEach(()=>{jest.clearAllMocks();(prisma.helpTicket.findUnique as jest.Mock).mockResolvedValue(ticket);(prisma.helpEvent.findMany as jest.Mock).mockResolvedValue([]);(prisma.helpEvent.findFirst as jest.Mock).mockResolvedValue(null);(prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([]);(prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(null)});
test('bounded client hints keep diagnostics and normalized object identity without profile fields',()=>{
 expect(parseHelpClientContext(client)).toEqual(client);
 expect(helpClientContextSchema.safeParse({...client,origin:{...client.origin,target:{...client.origin.target,password:'discarded'}}}).success).toBe(false);
});
test.each([{...client,password:'secret'},{...client,requester:{userId:99}},
 {...client,origin:{...client.origin,screen:'https://example.test/?token=secret'}},
 {...client,origin:{...client.origin,target:{source:'app',kind:'user',id:'invalid'}}},
 {...client,timeZone:'wrong/timezone'},{...client,locale:'wrong value'},{...client,app:{...client.app,version:'x'.repeat(65)}},
 {...client,app:{...client.app,accessToken:'secret'}}])('arbitrary identity, credentials, URL params and oversized diagnostics are rejected',value=>{
 expect(parseHelpClientContext(value)).toBeUndefined();
});
test('chat context uses server members, treats client hints separately and never creates a chat message',async()=>{
 const context=await helpChatContext(54,7,{inputs:[],ownerId:999,clientContext:client});
 expect(context.value).toEqual({conversation:expect.objectContaining({mode:'AI_ACTIVE'}),ticketId:54,ownerId:7,participants:[{userId:7,chatRole:'OWNER',displayName:'Петров Иван'}],assistant:{kind:'ai',name:'ИИ-помощник'},client});
 expect(JSON.stringify((prisma.helpTicket.findUnique as jest.Mock).mock.calls)).not.toMatch(/password|email|phone|objectKey/);
 await context.validate();
});
test('legacy job contexts do not inherit an unrelated old page or diagnostics',async()=>{
 expect((await helpChatContext(54,7,[])).value.client).toBeUndefined();
 expect((await helpChatContext(54,7,{inputs:[],clientContext:{...client,role:'admin'}})).value.client).toBeUndefined();
});
test.each([{ownerId:8},{status:'CLOSED'},{itRequested:true},{members:[...ticket.members,{userId:8,role:'IT',user:ticket.members[0].user}]}])('owner/IT/closed state fences stop later disclosure: %o',async change=>{
 const context=await helpChatContext(54,7,{clientContext:client});
 const tx={helpTicket:{findUnique:jest.fn(async()=>({...ticket,...change}))}};
 await expect(context.validate(tx as any)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('membership/name changes invalidate the private snapshot at publication',async()=>{
 const context=await helpChatContext(54,7,[]);
 (prisma.helpTicket.findUnique as jest.Mock).mockResolvedValue({...ticket,members:[]});
 await expect(context.validate()).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('authorship distinguishes AI, application events and real people without promoting message text',()=>{
 expect(helpMessageAuthor({authorId:7,authorRole:'USER'},7)).toEqual({kind:'owner',userId:7});
 expect(helpMessageAuthor({authorId:9,authorRole:'IT'},7)).toEqual({kind:'it',userId:9});
 expect(helpMessageAuthor({authorId:null,authorRole:'SYSTEM',assistantJob:{id:'job'}},7)).toEqual({kind:'assistant',userId:null});
 expect(helpMessageAuthor({authorId:null,authorRole:'SYSTEM'},7)).toEqual({kind:'system',userId:null});
});

test('ticket74 motif: canonical departure survives removal from current membership and text cannot invent its cause',async()=>{
 const event={id:74,type:'IT_LEFT',actorId:9,messageId:744,createdAt:new Date('2026-11-06T10:00:00Z')};
 (prisma.helpEvent.findMany as jest.Mock).mockResolvedValue([event]);(prisma.helpEvent.findFirst as jest.Mock).mockResolvedValue(event);
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{id:745,sequence:8,authorId:7,authorRole:'USER',replyToId:null,assistantJob:null},{id:743,sequence:6,authorId:9,authorRole:'IT',replyToId:null,assistantJob:null}]);
 const context=await helpChatContext(74,7,{inputs:[{sequence:8,text:'Куда он?'}],itRequested:true,conversation:{mode:'IT_ACTIVE',reason:'ушёл домой'}});
 expect(context.value.conversation).toMatchObject({mode:'AI_ACTIVE',lastItTransition:{eventId:74,type:'IT_LEFT',actorId:9,messageId:744,at:'2026-11-06T10:00:00.000Z'},automaticReplyOnItDeparture:false,nextStep:'respond_to_current_owner_message',ledger:{lastOwnerMessageId:745,itMessageIds:[743]}});
 expect(JSON.stringify(context.value)).not.toMatch(/ушёл домой|Куда он|itRequested/);
 expect((prisma.helpMessage.findMany as jest.Mock).mock.calls[0][0].where.sequence).toEqual({lte:8});
});
test('join and departure between chunks invalidate context even when final membership is identical',async()=>{
 const context=await helpChatContext(74,7,[]);
 (prisma.helpEvent.findFirst as jest.Mock).mockResolvedValue({id:75,type:'IT_LEFT',actorId:9,messageId:8,createdAt:new Date()});
 await expect(context.validate()).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('a previous confirmed AI offer outside the short ledger prevents duplicate first-call instructions',async()=>{
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue({id:10});
 const context=await helpChatContext(74,7,{inputs:[{sequence:100}]});
 expect(context.value.conversation?.ledger.previousItOfferMessageIds).toEqual([10]);
 const query=(prisma.helpMessage.findFirst as jest.Mock).mock.calls[0][0];
 expect(query.where).toMatchObject({ticketId:74,kind:'TEXT',authorId:null,assistantJob:{isNot:null},sequence:{lte:100},AND:[{assistantState:{path:['status'],equals:'completed'}},{assistantState:{path:['action','type'],equals:'request_it'}}]});
 expect(query.select).toEqual({id:true});
});
test('ledger is bounded original provenance rather than a second unverified summary',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue(Array.from({length:33},(_,index)=>({id:100-index,sequence:100-index,authorId:index%2?7:9,authorRole:index%2?'USER':'IT',replyToId:null,assistantJob:null,text:'PRIVATE ignored',password:'PRIVATE ignored'})));
 const context=await helpChatContext(74,7,[]),ledger=context.value.conversation!.ledger;
 expect(ledger.turns).toHaveLength(32);expect(ledger.truncated).toBe(true);expect(ledger.semanticOutcome).toBe('read_original_messages_and_working_memory');
 expect(ledger.turns[0].sequence).toBe(69);expect(JSON.stringify(context.value)).not.toMatch(/PRIVATE|password|успешно|проверено/);
});
