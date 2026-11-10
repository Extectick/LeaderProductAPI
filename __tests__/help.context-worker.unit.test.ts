jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpAssistantJob:{findUnique:jest.fn()},helpAttachment:{findMany:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>({HelpError:class extends Error{},helpActor:jest.fn(async()=>({userId:7,canManage:false})),requireHelpTicket:jest.fn(async()=>({ownerId:7})),helpTransaction:jest.fn(),publishHelpEvent:jest.fn(async()=>({id:100}))}));
jest.mock('../src/modules/help/help.openai-answer',()=>({prepareHelpOpenAIAnswer:jest.fn()}));
jest.mock('../src/modules/help/help.assistant-lease',()=>({withHelpAssistantLease:jest.fn((_id,_token,work)=>work(new AbortController().signal))}));
jest.mock('../src/modules/help/help.context-store',()=>({saveHelpContextSummary:jest.fn(),helpContextFingerprint:jest.fn(),HelpContextError:class extends Error{constructor(code:string){super(code);Object.assign(this,{code,status:409})}}}));
import prisma from '../src/prisma/client';
import {prepareHelpOpenAIAnswer} from '../src/modules/help/help.openai-answer';
import {helpTransaction} from '../src/modules/help/help.service';
import {saveHelpContextSummary,helpContextFingerprint} from '../src/modules/help/help.context-store';
import {processHelpAssistantJob} from '../src/modules/help/help.assistant';
const env={...process.env},hash='a'.repeat(64);
let db:any,job:any,ticket:any;
const memory={version:1,model:'fixture',coveredThrough:1,fingerprint:hash,items:[{kind:'constraint',text:'PRIVATE_MEMORY',messageIds:[1]}]};
beforeEach(()=>{
 jest.clearAllMocks();process.env={...env,HELP_AI_PROVIDER:'openai'};
 job={id:'job',ticketId:3,ownerId:7,messageId:20,provider:'openai',status:'RUNNING',leaseToken:'lease',leaseUntil:new Date(Date.now()+90000),createdAt:new Date(),step:3,attempts:1,context:[{text:'Оригинал',sequence:1}]};
 ticket={id:3,ownerId:7,status:'OPEN',itRequested:false,members:[]};
 (prisma.helpAssistantJob.findUnique as jest.Mock).mockImplementation(async()=>job);
 (prepareHelpOpenAIAnswer as jest.Mock).mockResolvedValue({mode:'openai',text:'Готовый ответ',sources:[],contextSummary:memory,contextRevision:{throughSequence:1,fingerprint:hash}});
 (helpContextFingerprint as jest.Mock).mockResolvedValue({fingerprint:hash,totalMessages:1});
 (saveHelpContextSummary as jest.Mock).mockImplementation(async()=>{job.context={inputs:job.context,helpContextSummary:memory}});
 db={helpAssistantJob:{findUnique:jest.fn(async()=>job),findUniqueOrThrow:jest.fn(async()=>job),updateMany:jest.fn(async()=>({count:1}))},helpTicket:{findUniqueOrThrow:jest.fn(async()=>ticket),update:jest.fn()},helpMessage:{findUnique:jest.fn(async()=>({assistantState:{activityVersion:1,activities:[]}})),update:jest.fn()}};
 (helpTransaction as jest.Mock).mockImplementation((_id,fn)=>fn(db));
});
afterEach(()=>{process.env=env});
test('memory is saved privately after a successful final claim and is absent from public assistantState',async()=>{
 await expect(processHelpAssistantJob('job','lease')).resolves.toBe(true);
 expect(saveHelpContextSummary).toHaveBeenCalledWith(db,job,memory);
 expect(db.helpAssistantJob.updateMany.mock.invocationCallOrder[0]).toBeLessThan((saveHelpContextSummary as jest.Mock).mock.invocationCallOrder[0]);
 expect(JSON.stringify(db.helpMessage.update.mock.calls)).not.toContain('PRIVATE_MEMORY');
 expect(db.helpMessage.update.mock.calls.at(-1)[0].data.assistantState.contextMessageCount).toBe(1);
});
test.each(['lost-claim','changed-owner','cancel','IT'])('a %s cannot publish or persist a new memory',async(reason)=>{
 (prepareHelpOpenAIAnswer as jest.Mock).mockImplementation(async()=>{
  if(reason==='changed-owner')ticket.ownerId=99;if(reason==='cancel')job.status='STOPPED';if(reason==='IT')ticket.itRequested=true;
  return{mode:'openai',text:'Готовый ответ',sources:[],contextSummary:memory,contextRevision:{throughSequence:1,fingerprint:hash}};
 });
 if(reason==='lost-claim')db.helpAssistantJob.updateMany.mockResolvedValue({count:0});
 db.helpAssistantJob.findMany=jest.fn(async()=>[]);
 await expect(processHelpAssistantJob('job','lease')).resolves.toBe(false);
 expect(saveHelpContextSummary).not.toHaveBeenCalled();expect(db.helpMessage.update.mock.calls.some(([x]:any)=>x.data.kind==='TEXT')).toBe(false);
});
test('a changed transcript blocks the final answer before the claim or summary write',async()=>{
 (helpContextFingerprint as jest.Mock).mockResolvedValue({fingerprint:'b'.repeat(64),totalMessages:1});
 await expect(processHelpAssistantJob('job','lease')).resolves.toBe(false);
 expect(saveHelpContextSummary).not.toHaveBeenCalled();expect(db.helpMessage.update.mock.calls.some(([x]:any)=>x.data.kind==='TEXT')).toBe(false);
});
