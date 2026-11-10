jest.mock('../src/prisma/client',()=>({__esModule:true,default:{
  $transaction:jest.fn(),$queryRaw:jest.fn(),helpMember:{findFirst:jest.fn()},
}}));
jest.mock('../src/modules/help/help.assistant',()=>({helpAssistantConfiguration:()=>({enabled:true})}));
jest.mock('../src/services/serviceAccess',()=>({explainServiceAccessForUser:jest.fn()}));
import prisma from '../src/prisma/client';
import {readAllHelp,readHelpTicket} from '../src/modules/help/help.service';

const client=prisma as any;
const actor={userId:7,canManage:false};
let db:any,lastRead:number,tail:number,readable:number|null;
beforeEach(()=>{
  jest.clearAllMocks();lastRead=2;tail=4;readable=4;
  db={
    $executeRaw:jest.fn(),
    helpTicket:{findUnique:jest.fn(async({where}:any)=>({id:where.id,messageSequence:tail,members:[{userId:7,role:'OWNER',lastReadSequence:lastRead}]}))},
    helpMessage:{findFirst:jest.fn(async({where}:any)=>readable===null?null:{sequence:Math.min(readable,where.sequence.lte)})},
    helpMember:{update:jest.fn(async({data}:any)=>{lastRead=data.lastReadSequence;})},
    helpEvent:{create:jest.fn(async()=>({id:50}))},
  };
  client.$transaction.mockImplementation((work:any)=>work(db));
  client.helpMember.findFirst.mockResolvedValue({ticketId:200});
  client.$queryRaw.mockResolvedValue([]);
});
test('no-op individual reads skip the readable-tail lookup and writes',async()=>{
  lastRead=4;
  expect(await readHelpTicket(3,actor)).toBe(false);
  expect(db.helpMessage.findFirst).not.toHaveBeenCalled();
  expect(db.helpMember.update).not.toHaveBeenCalled();
  expect(db.helpEvent.create).not.toHaveBeenCalled();
});
test('progress-only tail never advances a read cursor to a future answer',async()=>{
  readable=2;
  expect(await readHelpTicket(3,actor)).toBe(false);
  expect(db.helpMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{ticketId:3,sequence:{lte:4},kind:{not:'ASSISTANT_PROGRESS'}}}));
  expect(db.helpMember.update).not.toHaveBeenCalled();
});
test('read-all filters no-op and progress-only memberships before opening ticket transactions',async()=>{
  expect(await readAllHelp(actor)).toEqual([]);
  expect(client.$transaction).not.toHaveBeenCalled();
  const query=client.$queryRaw.mock.calls[0][0];
  expect(query.text).toContain('t."messageSequence">m."lastReadSequence"');
  expect(query.text).toContain('msg.sequence>m."lastReadSequence"');
  expect(query.text).toContain("msg.kind<>'ASSISTANT_PROGRESS'");
  expect(query.text).toContain("m.role='OWNER'");
  expect(query.text).toContain('LIMIT 100');
});
test('read-all pages by ticket ID within its initial upper bound and preserves the selected sequence',async()=>{
  const batch=Array.from({length:100},(_,index)=>({ticketId:index+1,messageSequence:4}));
  client.$queryRaw.mockResolvedValueOnce(batch).mockResolvedValueOnce([{ticketId:150,messageSequence:3}]).mockResolvedValueOnce([]);
  // Simulate independently unread memberships; each transaction sees its own cursor.
  db.helpTicket.findUnique.mockImplementation(async({where}:any)=>({id:where.id,messageSequence:tail,members:[{userId:7,role:'OWNER',lastReadSequence:2}]}));
  const ids=await readAllHelp(actor);
  expect(ids).toEqual([...batch.map(row=>row.ticketId),150]);
  expect(client.$queryRaw).toHaveBeenCalledTimes(3);
  expect(client.$queryRaw.mock.calls[0][0].values).toEqual([7,0,200]);
  expect(client.$queryRaw.mock.calls[1][0].values).toEqual([7,100,200]);
  expect(client.$queryRaw.mock.calls[2][0].values).toEqual([7,150,200]);
  expect(db.helpMessage.findFirst.mock.calls[db.helpMessage.findFirst.mock.calls.length-1][0].where.sequence).toEqual({lte:3});
  expect(db.helpEvent.create).toHaveBeenCalledTimes(101);
});
test('a cursor advanced by another reader after candidate selection remains a no-op',async()=>{
  lastRead=4;
  client.$queryRaw.mockResolvedValueOnce([{ticketId:1,messageSequence:4}]).mockResolvedValueOnce([]);
  expect(await readAllHelp(actor)).toEqual([]);
  expect(db.helpMember.update).not.toHaveBeenCalled();
  expect(db.helpEvent.create).not.toHaveBeenCalled();
});
test('membership is rechecked under the ticket lock; manager candidates include IT membership',async()=>{
  const manager={...actor,canManage:true};
  client.$queryRaw.mockResolvedValueOnce([{ticketId:1,messageSequence:4}]);
  db.helpTicket.findUnique.mockResolvedValue({id:1,messageSequence:4,members:[]});
  await expect(readAllHelp(manager)).rejects.toMatchObject({code:'HELP_NOT_FOUND'});
  expect(client.helpMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{userId:7}}));
  expect(client.$queryRaw.mock.calls[0][0].text).not.toContain("m.role='OWNER'");
  expect(db.helpMember.update).not.toHaveBeenCalled();
});
