const mockDb = {
  helpTicket: {findMany:jest.fn(),findUnique:jest.fn(),findFirst:jest.fn()},
  helpMessage: {findMany:jest.fn(),findFirst:jest.fn(),groupBy:jest.fn(),count:jest.fn()},
  helpEvent: {findMany:jest.fn(),findFirst:jest.fn()},
  user: {findMany:jest.fn()},
  $queryRaw:jest.fn(),
};
const mockTransaction=jest.fn((work:(db:typeof mockDb)=>unknown)=>work(mockDb));
jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:(...args:any[])=>mockTransaction(...args as [any])}}));
jest.mock('../src/services/serviceAccess',()=>({explainServiceAccessForUser:jest.fn()}));
jest.mock('../src/modules/help/help.assistant',()=>({helpAssistantConfiguration:()=>({enabled:true})}));
import {helpDetail,helpTicketSummaries,listHelpTickets,syncHelpTicket} from '../src/modules/help/help.service';

const actor={userId:7,canManage:false};
const ticket=(id:number)=>({id,ownerId:7,title:`Ticket ${id}`,status:'OPEN',messageSequence:20,members:[{userId:7,role:'OWNER',lastReadSequence:id}],sourceTicketId:null,itRequested:false});
const message=(id:number)=>({id:id*100,ticketId:id,sequence:20,authorId:null,authorRole:'ASSISTANT',kind:'TEXT',text:'Answer',attachments:[],reactions:[],replyTo:null});
describe('Help reads use bounded work without changing visible data',()=>{
  beforeEach(()=>{
    jest.clearAllMocks();
    mockDb.helpTicket.findFirst.mockResolvedValue(null);
    mockDb.helpMessage.findFirst.mockResolvedValue(null);
    mockDb.helpMessage.count.mockResolvedValue(0);
    mockDb.helpEvent.findFirst.mockResolvedValue(null);
    mockDb.helpEvent.findMany.mockResolvedValue([]);
    mockDb.user.findMany.mockResolvedValue([{id:7,firstName:'Alex',lastName:'',avatarUrl:null}]);
  });
  test.each([1,50])('%i tickets use one batched unread/authors/status query, not one per ticket',async count=>{
    const rows=Array.from({length:count},(_,index)=>ticket(index+1));
    mockDb.helpTicket.findMany.mockResolvedValue(rows);
    mockDb.$queryRaw.mockResolvedValue(rows.map(row=>({id:row.id*100})));
    mockDb.helpMessage.findMany.mockResolvedValue(rows.map(row=>message(row.id)));
    mockDb.helpMessage.groupBy.mockResolvedValue([{ticketId:1,_count:{_all:3}}]);
    const result=await listHelpTickets(actor,'OPEN',false);
    expect(result.tickets).toHaveLength(count);
    expect(result.tickets[0]).toMatchObject({id:1,unreadCount:3,lastReadSequence:1,lastMessage:{id:100,author:{id:0,name:'ИИ'}}});
    for(const method of [mockDb.$queryRaw,mockDb.helpMessage.findMany,mockDb.helpMessage.groupBy,mockDb.user.findMany,mockDb.helpEvent.findMany])expect(method).toHaveBeenCalledTimes(1);
    expect(mockDb.helpMessage.findFirst).not.toHaveBeenCalled();
    expect(mockDb.helpMessage.count).not.toHaveBeenCalled();
    const predicates=mockDb.helpMessage.groupBy.mock.calls[0][0].where.AND;
    expect(predicates).toContainEqual({OR:[{authorId:{not:7}},{authorId:null}]});
    expect(predicates).toContainEqual({kind:{not:'ASSISTANT_PROGRESS'}});
    expect(predicates[2].OR).toEqual(rows.map(row=>({ticketId:row.id,sequence:{gt:row.id}})));
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({isolationLevel:'RepeatableRead'}));
  });
  test('only the selected 50 tickets are enriched; an inaccessible source stays hidden',async()=>{
    const rows=Array.from({length:51},(_,index)=>({...ticket(index+1),sourceTicketId:999}));
    mockDb.helpTicket.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    mockDb.$queryRaw.mockResolvedValue([]);
    mockDb.helpMessage.groupBy.mockResolvedValue([]);
    const result=await listHelpTickets(actor,'OPEN',false);
    expect(result.nextCursor).toBe(50);
    expect(result.tickets).toHaveLength(50);
    expect(result.tickets[0]).toMatchObject({sourceTicket:null,sourceTicketId:null,lastMessage:null,unreadCount:0});
    expect(mockDb.helpMessage.groupBy.mock.calls[0][0].where.AND[2].OR).toHaveLength(50);
    expect(mockDb.helpTicket.findMany.mock.calls[1][0]).toMatchObject({where:{id:{in:[999]},members:{some:{userId:7,role:'OWNER'}}}});
  });
  test('an empty page does not run enrichment queries',async()=>{
    mockDb.helpTicket.findMany.mockResolvedValue([]);
    expect(await listHelpTickets(actor,'OPEN',false)).toEqual({tickets:[],nextCursor:null});
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.helpMessage.groupBy).not.toHaveBeenCalled();
  });
  test('detail reuses the tail message and preserves closure metadata',async()=>{
    mockDb.helpTicket.findUnique.mockResolvedValue(ticket(1));
    mockDb.helpMessage.findMany.mockResolvedValue([message(1)]);
    mockDb.helpEvent.findMany.mockResolvedValue([{messageId:100,type:'TICKET_CLOSED'}]);
    const result=await helpDetail(1,actor);
    expect(result.ticket.lastMessage).toBe(result.messages[0]);
    expect(result.ticket.lastMessage?.ticketStatusChange).toBe('CLOSED');
    expect(result.hasOlder).toBe(false);expect(result.hasNewer).toBe(false);
    // The only findFirst left on a short tail is firstUnread metadata, not a
    // duplicate latest-message lookup or redundant boundary probes.
    expect(mockDb.helpMessage.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.helpEvent.findMany).toHaveBeenCalledTimes(1);
  });
  test('detail still rejects an unrelated user before reading history',async()=>{
    mockDb.helpTicket.findUnique.mockResolvedValue({...ticket(1),members:[{userId:8,role:'OWNER'}]});
    await expect(helpDetail(1,actor)).rejects.toMatchObject({status:404});
    expect(mockDb.helpMessage.findMany).not.toHaveBeenCalled();
  });
  test('a delta containing the current tail reuses its mapped last message',async()=>{
    mockDb.helpTicket.findUnique.mockResolvedValue(ticket(1));
    mockDb.helpMessage.findMany.mockResolvedValue([message(1)]);
    mockDb.helpEvent.findMany.mockResolvedValueOnce([{id:21,ticketId:1,messageId:100,type:'MESSAGE_CREATED'}]).mockResolvedValueOnce([]);
    const result=await syncHelpTicket(1,actor,{after:20});
    expect(result.ticket.lastMessage).toBe(result.messages[0]);
    expect(result.nextCursor).toBe(21);
    expect(mockDb.helpMessage.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.helpEvent.findMany).toHaveBeenCalledTimes(2);
  });
  test('batch summary enriches only authorized rows and deduplicates requested IDs',async()=>{
    mockDb.helpTicket.findMany.mockResolvedValue([ticket(1)]);
    mockDb.$queryRaw.mockResolvedValue([{id:100}]);
    mockDb.helpMessage.findMany.mockResolvedValue([message(1)]);
    mockDb.helpMessage.groupBy.mockResolvedValue([]);
    const result=await helpTicketSummaries(actor,[1,999,1]);
    expect(mockDb.helpTicket.findMany).toHaveBeenCalledWith({where:{id:{in:[1,999]},members:{some:{userId:7,role:'OWNER'}}},include:{members:true}});
    expect(result.tickets.map(row=>row.id)).toEqual([1]);
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.helpMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.helpMessage.findMany.mock.calls[0][0].where).toEqual({id:{in:[100]}});
  });
  test('a manager can refresh queue summaries; missing rows are omitted',async()=>{
    mockDb.helpTicket.findMany.mockResolvedValue([]);
    expect(await helpTicketSummaries({...actor,canManage:true},[999])).toEqual({tickets:[]});
    expect(mockDb.helpTicket.findMany.mock.calls[0][0].where).toEqual({id:{in:[999]}});
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
  });
  test.each([[0],[-1],[2147483648],[1.5],Array(201).fill(1)].map(ids=>[ids]))('invalid or unbounded summary IDs are rejected before SQL: %j',async ids=>{
    await expect(helpTicketSummaries(actor,ids)).rejects.toMatchObject({status:400});
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  test('empty summaries perform no database work',async()=>{
    expect(await helpTicketSummaries(actor,[])).toEqual({tickets:[]});
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
