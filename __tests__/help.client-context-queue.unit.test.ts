jest.mock('../src/prisma/client',()=>({__esModule:true,default:{}}));
jest.mock('../src/modules/help/help.service',()=>({HelpError:class extends Error{},publishHelpEvent:jest.fn(async()=>({id:90}))}));
import {enqueueHelpAssistant} from '../src/modules/help/help.assistant';
const env={...process.env};
const client={v:1 as const,app:{platform:'android' as const,version:'0.1.46.19'},origin:{screen:'entity/app/user',state:'previous' as const,target:{v:1 as const,source:'app' as const,kind:'user' as const,id:'7'}}};
let db:any;
beforeEach(()=>{
 process.env={...env,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};
 db={helpTicket:{findUniqueOrThrow:jest.fn(async()=>({id:54,ownerId:7,status:'OPEN',itRequested:false,members:[{userId:7,role:'OWNER'}]})),update:jest.fn(async()=>({messageSequence:2}))},
 helpMessage:{findMany:jest.fn(async()=>[{id:10,sequence:1,text:'Что это за профиль?'}]),create:jest.fn(async()=>({id:11})),findUnique:jest.fn(async()=>null),update:jest.fn()},
 helpAssistantJob:{findFirst:jest.fn(async()=>null),create:jest.fn(async({data}:any)=>({...data,createdAt:new Date(),step:0}))}};
});
afterEach(()=>{process.env=env});
test('the accepted client snapshot survives the durable job but never enters public progress/message text',async()=>{
 await enqueueHelpAssistant(db,54,7,1,client);
 const context=db.helpAssistantJob.create.mock.calls[0][0].data.context;
 expect(context).toEqual({inputs:[{id:10,sequence:1,text:'Что это за профиль?'}],clientContext:client});
 expect(JSON.stringify(db.helpMessage.create.mock.calls)).not.toContain('clientContext');
 expect(JSON.stringify(db.helpMessage.update.mock.calls)).not.toContain('clientContext');
 expect(JSON.stringify(db.helpMessage.update.mock.calls)).not.toContain('entity/app/user');
});
test('old clients retain their original array context and do not inherit another request snapshot',async()=>{
 await enqueueHelpAssistant(db,54,7,1);
 expect(db.helpAssistantJob.create.mock.calls[0][0].data.context).toEqual([{id:10,sequence:1,text:'Что это за профиль?'}]);
});
test('invalid internal hints cannot bypass request parsing into a model prompt',async()=>{
 await enqueueHelpAssistant(db,54,7,1,{...client,requester:{userId:99}} as any);
 expect(Array.isArray(db.helpAssistantJob.create.mock.calls[0][0].data.context)).toBe(true);
});
test('human handoff still prevents creation of another AI job',async()=>{
 db.helpTicket.findUniqueOrThrow.mockResolvedValue({ownerId:7,status:'OPEN',itRequested:true,members:[]});
 await enqueueHelpAssistant(db,54,7,1,client);
 expect(db.helpAssistantJob.create).not.toHaveBeenCalled();
});
