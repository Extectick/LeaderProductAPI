jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:jest.fn(),$queryRaw:jest.fn(),helpMessage:{findMany:jest.fn(),findFirst:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>({helpActor:jest.fn(),requireHelpTicket:jest.fn(),HelpError:class extends Error{constructor(public status:number,public code:string,message:string){super(message);}}}));
jest.mock('../src/modules/help/help.context-store',()=>({
  ...jest.requireActual('../src/modules/help/help.context-store'),helpContextFingerprint:jest.fn(),
}));
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {helpContextFingerprint} from '../src/modules/help/help.context-store';
import {helpItBrief,helpBriefExcerpt} from '../src/modules/help/help.it-brief';
const db=prisma as any,actor={userId:9,canManage:true};
const row=(id:number,authorId:number|null=7,text=`Text ${id}`)=>({id,sequence:id,text,authorId,authorRole:authorId===7?'USER':authorId?'IT':'SYSTEM',assistantState:null});
const summary=()=>({version:1,model:'fixture',coveredThrough:10,fingerprint:'a'.repeat(64),items:[{kind:'constraint',text:'Chosen warehouse',messageIds:[2]}]});
beforeEach(()=>{
  jest.resetAllMocks();
  (helpActor as jest.Mock).mockResolvedValue(actor);
  (requireHelpTicket as jest.Mock).mockResolvedValue({id:1,ownerId:7,messageSequence:20,status:'OPEN',itRequested:true,members:[{userId:7,role:'OWNER'},{userId:9,role:'IT'}]});
  db.$transaction.mockImplementation((fn:any)=>fn(db));db.$queryRaw.mockResolvedValue([]);
  db.helpMessage.findFirst.mockImplementation(async(args:any)=>args.orderBy.sequence==='asc'?row(1):row(19,7,'Ошибка осталась'));
  db.helpMessage.findMany.mockImplementation(async(args:any)=>args.where.id?[{id:2}]:[row(20,null,'ИИ: всё работает'),row(19,7,'Ошибка осталась'),row(18,9,'Проверяю')]);
  (helpContextFingerprint as jest.Mock).mockResolvedValue({fingerprint:'a'.repeat(64),totalMessages:10});
});
test('keeps original owner request, latest owner correction and honest speaker provenance after IT joins',async()=>{
 const result=await helpItBrief(1,actor);
 expect(result.initialRequest).toMatchObject({text:'Text 1',messageIds:[1],provenance:'owner'});
 expect(result.latestRequest).toMatchObject({text:'Ошибка осталась',messageIds:[19],provenance:'owner'});
 expect(result.recentMessages).toEqual([expect.objectContaining({provenance:'it'}),expect.objectContaining({provenance:'owner'}),expect.objectContaining({provenance:'assistant'})]);
 expect(result.checks).toEqual([]);expect(result.summary).toBeNull();
 expect(db.helpMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({take:32,where:expect.objectContaining({ticketId:1,sequence:{lte:20}})}));
 expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'RepeatableRead'});
});
test('reads only a projection of cached memory and validates source hash and references',async()=>{
 db.$queryRaw.mockResolvedValue([{summary:summary(),privateToolBodies:'not-for-response'}]);
 const result=await helpItBrief(1,actor);
 expect(result.summary?.items[0]).toEqual({kind:'constraint',text:'Chosen warehouse',messageIds:[2],provenance:'summary'});
 expect(helpContextFingerprint).toHaveBeenCalledWith(db,1,7,10);
 expect(db.$queryRaw.mock.calls[0][0].join(' ')).toContain('"context"->\'helpContextSummary\'');
 expect(JSON.stringify(result)).not.toContain('not-for-response');
});
test.each(['changed','missing','future'])('drops %s summary instead of showing stale or unreferenced conditions',async(reason)=>{
 const candidate=summary();if(reason==='future')candidate.coveredThrough=30;
 db.$queryRaw.mockResolvedValue([{summary:candidate}]);
 if(reason==='changed')(helpContextFingerprint as jest.Mock).mockResolvedValue({fingerprint:'b'.repeat(64),totalMessages:10});
 if(reason==='missing')db.helpMessage.findMany.mockImplementation(async(args:any)=>args.where.id?[]:[row(19)]);
 expect((await helpItBrief(1,actor)).summary).toBeNull();
});
test('rejects before transcript reads when permissions fail',async()=>{
 (requireHelpTicket as jest.Mock).mockRejectedValue(new Error('HELP_NOT_FOUND'));
 await expect(helpItBrief(1,actor)).rejects.toThrow('HELP_NOT_FOUND');
 expect(db.helpMessage.findMany).not.toHaveBeenCalled();expect(db.$queryRaw).not.toHaveBeenCalled();
});
test('rechecks current membership and role before returning a private snapshot',async()=>{
 (requireHelpTicket as jest.Mock).mockResolvedValueOnce({id:1,ownerId:7,messageSequence:20}).mockRejectedValueOnce(new Error('REVOKED'));
 await expect(helpItBrief(1,actor)).rejects.toThrow('REVOKED');expect(helpActor).toHaveBeenCalledTimes(2);
});
test('rejects an ordinary owner using fresh rights rather than stale canManage flag',async()=>{
 const owner={userId:9,canManage:false};(helpActor as jest.Mock).mockResolvedValue(owner);
 await expect(helpItBrief(1,actor)).rejects.toMatchObject({status:403,code:'HELP_FORBIDDEN'});
 expect(requireHelpTicket).not.toHaveBeenCalled();expect(db.helpMessage.findMany).not.toHaveBeenCalled();
});
test('does not return the brief if management rights are revoked during reading',async()=>{
 (helpActor as jest.Mock).mockResolvedValueOnce(actor).mockResolvedValueOnce({...actor,canManage:false});
 await expect(helpItBrief(1,actor)).rejects.toMatchObject({status:403,code:'HELP_FORBIDDEN'});
});
test('tool operations are bounded with no bodies, args, arbitrary labels or implied business success',async()=>{
 db.helpMessage.findMany.mockResolvedValue([{...row(20,null),assistantState:{activities:[
  {kind:'analysis',status:'completed',text:'Everything succeeded'},
  {kind:'tool',status:'completed',toolName:'read_object',label:'Secret private label',text:'Private body',args:{password:'secret'}},
  {kind:'tool',status:'failed',toolName:'read_object',errorCode:'SOURCE_DENIED'},
  ...Array.from({length:30},()=>({kind:'knowledge',status:'stopped'})),
 ]}}]);
 const result=await helpItBrief(1,actor);
 expect(result.checks).toHaveLength(12);expect(result.checks[0]).toEqual({text:'read_object',messageIds:[20],provenance:'tool_execution',status:'completed'});
 expect(result.checks[1].errorCode).toBe('SOURCE_DENIED');
 expect(JSON.stringify(result)).not.toMatch(/Private body|secret|Everything succeeded|private label/);
});
test('does not treat a human-authored activity object as a recorded tool execution',async()=>{
 db.helpMessage.findMany.mockResolvedValue([{...row(20,7),assistantState:{activities:[{kind:'tool',status:'completed',toolName:'fake'}]}}]);
 expect((await helpItBrief(1,actor)).checks).toEqual([]);
});
test.each(['пароль: secret','password=secret','Authorization: Bearer abc','https://user:pw@example.org','https://host/path?token=secret'])('avoids credential copying into summary excerpt: %s',(input)=>{
 expect(helpBriefExcerpt(input)).toBe('Содержимое скрыто: откройте исходное сообщение.');
});
test('keeps excerpts bounded',()=>expect(helpBriefExcerpt('x'.repeat(1000))).toHaveLength(600));
test('latest owner update remains visible when it falls outside the recent-message tail',async()=>{
 db.helpMessage.findMany.mockResolvedValue(Array.from({length:32},(_,index)=>row(200-index,null)));
 expect((await helpItBrief(1,actor)).latestRequest).toMatchObject({messageIds:[19],text:'Ошибка осталась'});
});
