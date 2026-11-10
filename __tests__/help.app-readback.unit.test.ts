jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()},role:{findMany:jest.fn()},rolePermissions:{findMany:jest.fn()}}}));
jest.mock('../src/lib/redis',()=>({connectRedis:jest.fn(),getRedis:jest.fn()}));
const mockTrace:string[]=[];
const mockCapture=jest.fn(async(path:string,read:()=>Promise<unknown>)=>{mockTrace.push('capture:'+path);return read();});
const mockKnowledgeValidate=jest.fn(async()=>{});
jest.mock('../src/modules/help/help.app-api-knowledge',()=>({helpAppApiKnowledgeFence:()=>({capture:mockCapture,validate:mockKnowledgeValidate})}));
import jwt from 'jsonwebtoken';
import prisma from '../src/prisma/client';
import {connectRedis} from '../src/lib/redis';
import {helpAppApiTools} from '../src/modules/help/help.app-api';

const actor={id:7,roleId:2,isActive:true,deletedAt:null,profileStatus:'ACTIVE',currentProfileType:'EMPLOYEE',employeeProfile:{status:'ACTIVE',departmentId:1,activeDepartmentId:1},departmentRoles:[]};
const env={...process.env};
const close={operationId:'POST /help/tickets/{id}/close',path:{id:41},body:{clientMessageId:'qa-close-message',text:'Закрыть тестовое обращение'}};
const detail=(status='CLOSED',id=41)=>({ticket:{id,status},messages:[]});
let journal:Map<string,string>,setJournal:jest.Mock;
const signal=()=>new AbortController().signal;
beforeEach(()=>{
 jest.clearAllMocks();mockTrace.length=0;process.env={...env,ACCESS_TOKEN_SECRET:'readback-fixture-only',HELP_APP_API_ORIGIN:'http://api:3000'};
 (prisma.user.findUnique as jest.Mock).mockResolvedValue(actor);
 (prisma.role.findMany as jest.Mock).mockResolvedValue([{id:2,name:'employee',parentRoleId:null}]);
 (prisma.rolePermissions.findMany as jest.Mock).mockResolvedValue([{roleId:2,permission:{name:'read_self'}}]);
 mockCapture.mockImplementation(async(path,read)=>{mockTrace.push('capture:'+path);return read();});mockKnowledgeValidate.mockResolvedValue(undefined);
 journal=new Map();setJournal=jest.fn(async(key:string,value:string,opts:any)=>{if(opts?.NX&&journal.has(key))return null;journal.set(key,value);return 'OK';});
 jest.mocked(connectRedis).mockResolvedValue({set:setJournal,get:jest.fn(async(key:string)=>journal.get(key)||null)} as any);
});
afterEach(()=>{process.env=env;});
function transportFixture(handler?:(url:URL,init:RequestInit)=>Response|Promise<Response>){
 return jest.fn(async(url:URL,init:RequestInit)=>{
  mockTrace.push('transport:'+init.method+' '+url.pathname);
  const claims=jwt.verify(String((init.headers as any).Authorization).slice(7),'readback-fixture-only') as any;
  expect(claims).toMatchObject({userId:7,role:'employee',permissions:['read_self'],helpApi:true});
  expect(init.redirect).toBe('error');
  return handler?handler(url,init):Response.json(detail());
 });
}

test('a mapped write executes once then one exact authorized GET inside the knowledge read fence',async()=>{
 const transport=transportFixture(),tools=helpAppApiTools(7,'qa-readback:1',{transport:transport as any});
 const out=JSON.parse(await tools.call('app_api_call',{...close,query:{ignoredMutationHint:'value'}},signal()));
 expect(transport.mock.calls.map(([url,init])=>[init.method,url.href])).toEqual([
  ['POST','http://api:3000/help/tickets/41/close?ignoredMutationHint=value'],['GET','http://api:3000/help/tickets/41'],
 ]);
 expect(out).toMatchObject({success:true,status:200,verification:{writeState:'accepted',status:'verified',target:{kind:'ticket',id:41},checkedFields:['status'],writeRepeated:false}});
 expect(mockCapture).toHaveBeenCalledTimes(1);expect(mockTrace.indexOf('capture:/help/tickets/41')).toBeLessThan(mockTrace.indexOf('transport:GET /help/tickets/41'));
 expect(tools.hasMutations()).toBe(true);expect(tools.hasEvidence()).toBe(true);
});

test('retry replays only the write receipt, performs one fresh GET, and never replays stale private data or the private plan',async()=>{
 let get=0;const transport=transportFixture(async(_url,init)=>Response.json(init.method==='POST'?{...detail(),privateMemo:'initial-private-receipt'}:{...detail(),privateMemo:'readback-private-body',revision:++get}));
 const first=JSON.parse(await helpAppApiTools(7,'qa-readback:2',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(first.data.privateMemo).toBe('initial-private-receipt');
 const replay=JSON.parse(await helpAppApiTools(7,'qa-readback:2',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST','GET','GET']);expect(replay).toMatchObject({success:true,replayed:true,verification:{writeState:'accepted',replayed:true,status:'verified'}});
 expect(replay).not.toHaveProperty('data');expect(JSON.stringify(replay)).not.toMatch(/initial-private|readback-private|requesterId|expected/);expect(replay.verification).not.toHaveProperty('request');expect(replay).not.toHaveProperty('plan');
 for(const stored of journal.values()){
  expect(stored).not.toMatch(/initial-private|readback-private|verification|requesterId|expected|firstName|target|checkedFields/);
  expect(JSON.parse(JSON.parse(stored).output)).toMatchObject({success:true,replayed:true});
 }
});

test('an unknown write checks current state without declaring that the uncertain write executed',async()=>{
 const transport=transportFixture(async(_url,init)=>{if(init.method==='POST')throw Error('write acknowledgement lost');return Response.json(detail());});
 const tools=helpAppApiTools(7,'qa-readback:3',{transport:transport as any}),out=JSON.parse(await tools.call('app_api_call',close,signal()));
 expect(out).toMatchObject({error:'APP_API_WRITE_OUTCOME_UNKNOWN',verification:{writeState:'unknown',status:'state_matches',writeRepeated:false}});
 expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST','GET']);expect(tools.hasMutations()).toBe(true);
 expect(tools.hasEvidence()).toBe(true);
 const replay=JSON.parse(await helpAppApiTools(7,'qa-readback:3',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(replay.error).toBe('APP_API_WRITE_OUTCOME_UNKNOWN');expect(replay.verification.status).toBe('state_matches');expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST','GET','GET']);
});

test('a failed read after an acknowledged write does not run another GET or reclassify the write as unknown',async()=>{
 const transport=transportFixture(async(_url,init)=>{if(init.method==='GET')throw Error('read transport lost');return Response.json(detail());});
 const out=JSON.parse(await helpAppApiTools(7,'qa-readback:4',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(out).toMatchObject({success:true,verification:{writeState:'accepted',status:'unavailable',writeRepeated:false}});expect(out).not.toHaveProperty('error');
 expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST','GET']);
});

test('knowledge capture rejection occurs before a readback fetch, while the committed write receipt remains accepted',async()=>{
 mockCapture.mockRejectedValueOnce(Error('knowledge read fence unavailable'));
 const transport=transportFixture(),out=JSON.parse(await helpAppApiTools(7,'qa-readback:5',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(out).toMatchObject({success:true,verification:{writeState:'accepted',status:'unavailable'}});expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST']);
});

test('fresh ACL revocation after the write receipt but before readback prevents the GET',async()=>{
 const originalSet=setJournal.getMockImplementation()!;
 setJournal.mockImplementation(async(...args:any[])=>{const result=await originalSet(...args);if(args[2]?.XX)(prisma.user.findUnique as jest.Mock).mockResolvedValue({...actor,isActive:false});return result;});
 const transport=transportFixture();
 await expect(helpAppApiTools(7,'qa-readback:6',{transport:transport as any}).call('app_api_call',close,signal())).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
 expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST']);
});

test('fresh ACL revocation during readback rejects disclosure and does not retry either request',async()=>{
 const transport=transportFixture(async(_url,init)=>{if(init.method==='GET')(prisma.rolePermissions.findMany as jest.Mock).mockResolvedValue([]);return Response.json(detail());});
 await expect(helpAppApiTools(7,'qa-readback:7',{transport:transport as any}).call('app_api_call',close,signal())).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
 expect(transport.mock.calls.map(([,init])=>init.method)).toEqual(['POST','GET']);
});

test.each([403,404,500])('readback HTTP%i never converts an accepted mutation into verified state',async status=>{
 const transport=transportFixture(async(_url,init)=>init.method==='POST'?Response.json(detail()):Response.json({ok:false,error:{code:status===403?'FORBIDDEN':'NOT_FOUND'}},{status}));
 const out=JSON.parse(await helpAppApiTools(7,'qa-readback:8:'+status,{transport:transport as any}).call('app_api_call',close,signal()));
 expect(out.success).toBe(true);expect(out.verification.writeState).toBe('accepted');expect(out.verification.status).toBe(status===403?'forbidden':'unavailable');expect(transport).toHaveBeenCalledTimes(2);
});

test('a successful but mismatched read cannot verify the wrong resource or expected state',async()=>{
 for(const fresh of [detail('CLOSED',42),detail('OPEN',41)]){
  const key='qa-readback:9:'+fresh.ticket.id+fresh.ticket.status;
  const transport=transportFixture(async(_url,init)=>Response.json(init.method==='POST'?detail():fresh));
  const out=JSON.parse(await helpAppApiTools(7,key,{transport:transport as any}).call('app_api_call',close,signal()));
  expect(out).toMatchObject({success:true,verification:{writeState:'accepted',status:'mismatch'}});expect(transport).toHaveBeenCalledTimes(2);
 }
});
test('HTTP200 with an explicit readback business denial is not verified',async()=>{
 const transport=transportFixture(async(_url,init)=>init.method==='POST'?Response.json(detail()):Response.json({ok:false,error:{code:'FORBIDDEN'}}));
 const out=JSON.parse(await helpAppApiTools(7,'qa-readback:denied200',{transport:transport as any}).call('app_api_call',close,signal()));
 expect(out).toMatchObject({success:true,verification:{writeState:'accepted',status:'forbidden'}});expect(transport).toHaveBeenCalledTimes(2);
});

test('own-profile readback ignores model-supplied identity hints and verifies only supported normalized fields',async()=>{
 const transport=transportFixture(async(_url,init)=>Response.json(init.method==='PATCH'?{ok:true,data:{profile:{id:7,firstName:'Иван'}}}:{ok:true,data:{profile:{id:7,firstName:'Иван',email:'private@example.invalid'}}}));
 const out=JSON.parse(await helpAppApiTools(7,'qa-readback:10',{transport:transport as any}).call('app_api_call',{operationId:'PATCH /users/profile',body:{firstName:'  Иван  '}},signal()));
 expect(out.verification).toMatchObject({status:'verified',target:{kind:'profile',id:7},checkedFields:['firstName']});expect(transport.mock.calls[1][0].href).toBe('http://api:3000/users/7/profile');expect(JSON.stringify(out.verification)).not.toContain('Иван');expect(JSON.stringify(out.verification)).not.toContain('private@example.invalid');
 const hinted=JSON.parse(await helpAppApiTools(7,'qa-readback:10:hint',{transport:transport as any}).call('app_api_call',{operationId:'PATCH /users/profile',body:{firstName:'  Иван  ',userId:99}},signal()));
 expect(hinted.verification).toMatchObject({status:'resource_read',target:{kind:'profile',id:7},checkedFields:[]});expect(transport.mock.calls[3][0].href).toBe('http://api:3000/users/7/profile');
});

test('a POST classified as read performs no write receipt or post-action readback',async()=>{
 const transport=transportFixture(async()=>Response.json({tickets:[]}));
 const out=JSON.parse(await helpAppApiTools(7,'qa-readback:11',{transport:transport as any}).call('app_api_call',{operationId:'POST /help/tickets/summaries',body:{ids:[41]}},signal()));
 expect(out.success).toBe(true);expect(out).not.toHaveProperty('verification');expect(transport).toHaveBeenCalledTimes(1);expect(setJournal).not.toHaveBeenCalled();
});
