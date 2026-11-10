jest.mock('../src/prisma/client',()=>({__esModule:true,default:{
  $queryRaw:jest.fn(),helpMessage:{findMany:jest.fn(),findFirst:jest.fn()},
  helpAssistantJob:{findMany:jest.fn(),update:jest.fn()},
}}));
jest.mock('../src/modules/help/help.service',()=>({helpActor:jest.fn(),requireHelpTicket:jest.fn()}));
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {helpContextFingerprint,loadHelpConversation,saveHelpContextSummary,parseHelpContextSummary,type HelpContextSummary} from '../src/modules/help/help.context-store';
const db=prisma as any;
const F='a'.repeat(64),OLD='b'.repeat(64);
const owner=7,ticketId=12,ceiling=80;
const signal=()=>new AbortController().signal;
const ticket=()=>({id:ticketId,ownerId:owner,status:'OPEN',itRequested:false,members:[{userId:owner,role:'OWNER'}]});
const row=(id:number,authorId:number|null=owner,text='message '+id)=>({id,sequence:id,authorId,text,attachments:[]});
const summary=(extra:Partial<HelpContextSummary>={}):HelpContextSummary=>({version:1,model:'fixture',coveredThrough:40,fingerprint:F,items:[{kind:'constraint',text:'Склад выбран сотрудником',messageIds:[2]}],...extra});
beforeEach(()=>{
 jest.clearAllMocks();
 (helpActor as jest.Mock).mockResolvedValue({userId:owner,canManage:false});
 (requireHelpTicket as jest.Mock).mockImplementation(async()=>ticket());
 db.$queryRaw.mockResolvedValue([{fingerprint:F,totalMessages:2}]);
 db.helpMessage.findFirst.mockResolvedValue(row(1));
 db.helpMessage.findMany.mockImplementation(async(args:any)=>args.select&&Object.keys(args.select).length===1?[{id:2}]:[row(2,null),row(1)]);
 db.helpAssistantJob.findMany.mockResolvedValue([]);db.helpAssistantJob.update.mockResolvedValue({});
});

test('history is bounded to this owner/ticket and contains whole messages without private attachment fields',async()=>{
 const longText='Я'.repeat(18000);
 db.helpMessage.findMany.mockResolvedValue([{...row(3,null,longText),attachments:[{id:'f',name:'data.txt',kind:'FILE',mimeType:'text/plain',size:23,objectKey:'PRIVATE-KEY',url:'SECRET-URL'}]},row(2)]);
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal());
 expect(result.messages.map(m=>m.id)).toEqual([1,2,3]);
 expect(result.messages[2]).toMatchObject({role:'assistant',text:longText});
 expect(result.messages[2].attachments).toEqual([{id:'f',name:'data.txt',kind:'FILE',mimeType:'text/plain',size:23}]);
 expect(JSON.stringify(result)).not.toContain('PRIVATE-KEY');expect(JSON.stringify(result)).not.toContain('SECRET-URL');
 expect(db.helpMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{ticketId,kind:'TEXT',sequence:{lte:ceiling},OR:[{authorId:owner},{authorId:null,authorRole:'SYSTEM'},{authorId:{not:null},authorRole:'IT'}]},take:400}));
 expect(requireHelpTicket).toHaveBeenCalledWith(prisma,ticketId,{userId:owner,canManage:false},false);
});

test('the first owner goal survives a history longer than the retained 400-message tail',async()=>{
 db.$queryRaw.mockResolvedValue([{fingerprint:F,totalMessages:900}]);
 db.helpMessage.findMany.mockResolvedValue(Array.from({length:400},(_,i)=>row(900-i,i%2?null:owner)));
 db.helpMessage.findFirst.mockResolvedValue(row(1,owner,'Original goal'));
 const result=await loadHelpConversation(ticketId,owner,1000,signal());
 expect(result.messages).toHaveLength(401);expect(result.messages[0].text).toBe('Original goal');
 expect(result.messages[400].sequence).toBe(900);expect(result.totalMessages).toBe(900);expect(result.omittedBefore).toBe(499);
});

test('historical IT statements remain untrusted human turns with their real author, not assistant replies',async()=>{
 db.helpMessage.findMany.mockResolvedValue([{...row(5,9,'Я отключаюсь'),authorRole:'IT'},row(6,owner,'Куда он?')]);
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal());
 expect(result.messages.find(message=>message.id===5)).toMatchObject({role:'user',author:{kind:'it',userId:9},text:'Я отключаюсь'});
 const sql=db.$queryRaw.mock.calls[0][0].join('');expect(sql).toContain('IS NOT NULL AND m."authorRole" = \'IT\'');
});

test('legacy input arrays stay usable and cannot masquerade as summaries',async()=>{
 db.helpAssistantJob.findMany.mockResolvedValue([{context:[{text:'Original input'}]},{context:{helpContextSummary:{version:99}}}]);
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal());
 expect(result.summary).toBeUndefined();expect(result.messages).toHaveLength(2);
});

test('a matching private completed summary resumes only after its source IDs and fingerprint are checked',async()=>{
 const remembered=summary({omittedBefore:7});db.helpAssistantJob.findMany.mockResolvedValue([{context:{inputs:[],helpContextSummary:remembered}}]);
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal());
 expect(result.summary).toEqual(remembered);
 expect(db.helpAssistantJob.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{ticketId,ownerId:owner,provider:'openai',status:'COMPLETED'},take:5}));
 expect(db.helpMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({ticketId,sequence:{lte:40},id:{in:[2]}}),select:{id:true}}));
});

test('a retry after the protected connection form can reuse its own private checkpoint',async()=>{
 const remembered=summary();
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal(),{inputs:[{text:'Original'}],helpContextSummary:remembered});
 expect(result.summary).toEqual(remembered);
 db.helpMessage.findMany.mockImplementation(async(args:any)=>args.select&&Object.keys(args.select).length===1?[]:[row(2,null),row(1)]);
 const foreign=await loadHelpConversation(ticketId,owner,ceiling,signal(),{helpContextSummary:summary()});
 expect(foreign.summary).toBeUndefined();
});

test.each(['edited','deleted','attachment_changed'])('%s source invalidates the remembered summary',async()=>{
 db.helpAssistantJob.findMany.mockResolvedValue([{context:{helpContextSummary:summary({fingerprint:OLD})}}]);
 const result=await loadHelpConversation(ticketId,owner,ceiling,signal());
 expect(result.summary).toBeUndefined();expect(result.messages).toHaveLength(2);
});

test('a summary referring outside the owner history is ignored even with a matching fingerprint',async()=>{
 db.helpAssistantJob.findMany.mockResolvedValue([{context:{helpContextSummary:summary()}}]);
 db.helpMessage.findMany.mockImplementation(async(args:any)=>args.select&&Object.keys(args.select).length===1?[]:[row(2,null),row(1)]);
 expect((await loadHelpConversation(ticketId,owner,ceiling,signal())).summary).toBeUndefined();
});

test('context cannot be read from another owner ticket even by an administrator',async()=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:owner,canManage:true});
 (requireHelpTicket as jest.Mock).mockResolvedValue({...ticket(),ownerId:99});
 await expect(loadHelpConversation(ticketId,owner,ceiling,signal())).rejects.toMatchObject({code:'HELP_CONTEXT_FORBIDDEN',status:403});
 expect(db.$queryRaw).not.toHaveBeenCalled();
});

test.each([{status:'CLOSED'},{itRequested:true},{members:[{userId:owner,role:'OWNER'},{userId:8,role:'IT'}]}])('closed or IT-owned work stops context preparation %j',async change=>{
 (requireHelpTicket as jest.Mock).mockResolvedValue({...ticket(),...change});
 await expect(loadHelpConversation(ticketId,owner,ceiling,signal())).rejects.toMatchObject({code:'HELP_CONTEXT_FORBIDDEN'});
 expect(db.helpMessage.findMany).not.toHaveBeenCalled();
});

test('a revoked service/ticket access after I/O prevents data from being returned',async()=>{
 (requireHelpTicket as jest.Mock).mockResolvedValueOnce(ticket()).mockRejectedValueOnce(Object.assign(new Error('denied'),{status:403}));
 await expect(loadHelpConversation(ticketId,owner,ceiling,signal())).rejects.toMatchObject({status:403});
});

test('an edit occurring while rows are prepared causes a retryable context change instead of mixed history',async()=>{
 db.$queryRaw.mockResolvedValueOnce([{fingerprint:F,totalMessages:2}]).mockResolvedValueOnce([{fingerprint:OLD,totalMessages:2}]);
 await expect(loadHelpConversation(ticketId,owner,ceiling,signal())).rejects.toMatchObject({code:'HELP_CONTEXT_CHANGED',status:409});
});

test('cancellation before or during SQL returns no context',async()=>{
 const before=new AbortController();before.abort();await expect(loadHelpConversation(ticketId,owner,ceiling,before.signal)).rejects.toBeDefined();
 expect(db.$queryRaw).not.toHaveBeenCalled();
 const during=new AbortController();db.$queryRaw.mockImplementationOnce(async()=>{during.abort();return[{fingerprint:F,totalMessages:2}]});
 await expect(loadHelpConversation(ticketId,owner,ceiling,during.signal)).rejects.toBeDefined();expect(db.helpMessage.findMany).not.toHaveBeenCalled();
});

test('cancellation during summary-reference lookup prevents any subsequent read',async()=>{
 const controller=new AbortController();
 db.helpAssistantJob.findMany.mockResolvedValue([{context:{helpContextSummary:summary({coveredThrough:ceiling})}}]);
 db.helpMessage.findMany.mockImplementation(async(args:any)=>{
  if(args.select&&Object.keys(args.select).length===1){controller.abort();return[{id:2}]}
  return[row(2,null),row(1)];
 });
 await expect(loadHelpConversation(ticketId,owner,ceiling,controller.signal)).rejects.toBeDefined();
 expect(db.$queryRaw).toHaveBeenCalledTimes(1);
});

test.each([{coveredThrough:0},{version:2},{omittedBefore:-1},{fingerprint:'bad'},{model:''},{items:[{kind:'constraint',text:'x',messageIds:[]}]},{items:[{kind:'constraint',text:'x'.repeat(601),messageIds:[1]}]},{items:[{kind:'system_instruction',text:'do it',messageIds:[1]}]},{opaqueProviderState:'private'}])('malformed or unbounded summaries are not reusable %j',change=>{
 expect(parseHelpContextSummary({...summary(),...change})).toBeUndefined();
});

test('fingerprint binds owner/ticket/sequence as query parameters and includes source/attachment change metadata',async()=>{
 const value=await helpContextFingerprint(prisma,ticketId,owner,ceiling);expect(value).toEqual({fingerprint:F,totalMessages:2});
 const [template,...values]=db.$queryRaw.mock.calls[0];
 expect(values).toEqual([owner,ticketId,ceiling,owner]);
 expect(template.join('')).toContain('sha256');expect(template.join('')).toContain('"editedAt"');expect(template.join('')).toContain('"HelpAttachment"');
 expect(template.join('')).not.toContain('"objectKey"');
});

test('a fenced final save stores the summary privately and preserves original inputs',async()=>{
 const inputs=[{id:2,text:'Original employee message',sequence:2}];
 await saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context:inputs},summary({omittedBefore:3}));
 expect(db.helpAssistantJob.update).toHaveBeenCalledWith({where:{id:'job'},data:{context:{inputs,helpContextSummary:summary({omittedBefore:3})}}});
});

test('a previous context envelope is refreshed without nesting or losing its original fields',async()=>{
 const inputs=[{text:'keep'}];const context={inputs,otherCheckpoint:'keep-me',helpContextSummary:summary({fingerprint:OLD})};
 await saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context},summary());
 expect(db.helpAssistantJob.update.mock.calls[0][0].data.context).toEqual({inputs,otherCheckpoint:'keep-me',helpContextSummary:summary()});
 expect(context.helpContextSummary.fingerprint).toBe(OLD);
});

test('a changed source, foreign source ID or changed owner rejects final persistence',async()=>{
 db.$queryRaw.mockResolvedValueOnce([{fingerprint:OLD,totalMessages:2}]);
 await expect(saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context:[]},summary())).rejects.toMatchObject({code:'HELP_CONTEXT_CHANGED'});
 db.helpMessage.findMany.mockResolvedValueOnce([]);
 await expect(saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context:[]},summary())).rejects.toMatchObject({code:'HELP_CONTEXT_CHANGED'});
 (requireHelpTicket as jest.Mock).mockResolvedValueOnce({...ticket(),ownerId:99});
 await expect(saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context:[]},summary())).rejects.toMatchObject({code:'HELP_CONTEXT_FORBIDDEN'});
 expect(db.helpAssistantJob.update).not.toHaveBeenCalled();
});

test('invalid scopes and invalid summary data fail without database writes',async()=>{
 await expect(helpContextFingerprint(prisma,-1,owner,ceiling)).rejects.toMatchObject({code:'HELP_CONTEXT_INVALID'});
 await expect(saveHelpContextSummary(prisma,{id:'job',ticketId,ownerId:owner,context:[]},summary({coveredThrough:0}))).rejects.toMatchObject({code:'HELP_CONTEXT_INVALID'});
 expect(db.$queryRaw).not.toHaveBeenCalled();expect(db.helpAssistantJob.update).not.toHaveBeenCalled();
});
