jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()},role:{findMany:jest.fn()},rolePermissions:{findMany:jest.fn()}}}));
jest.mock('../src/lib/redis',()=>({connectRedis:jest.fn(),getRedis:jest.fn()}));
import jwt from 'jsonwebtoken';
import prisma from '../src/prisma/client';
import {connectRedis} from '../src/lib/redis';
import {helpAppApiTools,helpAppApiPath,redactHelpAppApi} from '../src/modules/help/help.app-api';
import {getAppApiOperation} from '../src/modules/help/help.app-api-catalog';
const actor={id:7,roleId:2,isActive:true,deletedAt:null,profileStatus:'ACTIVE',currentProfileType:'EMPLOYEE',employeeProfile:{status:'ACTIVE',departmentId:1,activeDepartmentId:1},departmentRoles:[{roleId:3,departmentId:1}]};
const signal=()=>new AbortController().signal;
const env={...process.env};let journal:Map<string,string>;
beforeEach(()=>{
 jest.clearAllMocks();process.env={...env,ACCESS_TOKEN_SECRET:'fixture-only',HELP_APP_API_ORIGIN:'http://api:3000'};
 (prisma.user.findUnique as jest.Mock).mockResolvedValue(actor);
 (prisma.role.findMany as jest.Mock).mockResolvedValue([{id:2,name:'employee',parentRoleId:null},{id:3,name:'departmentmanager',parentRoleId:null}]);
 (prisma.rolePermissions.findMany as jest.Mock).mockResolvedValue([{roleId:2,permission:{name:'read_self'}},{roleId:3,permission:{name:'manage_users'}}]);
 journal=new Map();jest.mocked(connectRedis).mockResolvedValue({set:jest.fn(async(key:string,value:string,opts:any)=>{if(opts?.NX&&journal.has(key))return null;journal.set(key,value);return 'OK'}),get:jest.fn(async(key:string)=>journal.get(key)||null)} as any);
});afterEach(()=>{process.env=env});
test('catalogue discovery and operation schema use real routes without network',async()=>{
 const transport=jest.fn(),tools=helpAppApiTools(7,'55:3',{transport});
 const result=JSON.parse(await tools.call('app_api_search',{query:'чаты',limit:20},signal()));expect(result.operations.some((op:any)=>op.path.startsWith('/help/tickets'))).toBe(true);
 expect(JSON.parse(await tools.call('app_api_operation',{operationId:'GET /help/tickets/{id}'},signal())).operation.path).toBe('/help/tickets/{id}');
 expect(transport).not.toHaveBeenCalled();expect(tools.hasEvidence()).toBe(false);
});
test('requests use actual principal and ordinary primary role token claims',async()=>{
 const transport=jest.fn(async(_url:any,init:any)=>{const token=init.headers.Authorization.slice(7),claims=jwt.verify(token,'fixture-only') as any;expect(claims).toMatchObject({userId:7,role:'employee',permissions:['read_self']});expect(claims.permissions).not.toContain('manage_users');return Response.json({id:7,firstName:'Иван',passwordHash:'hidden',accessToken:token,avatarUrl:'https://store/x?X-Amz-Signature=secret'});});
 const tools=helpAppApiTools(7,'55:3',{transport:transport as any});
 const output=JSON.parse(await tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:7}},signal()));
 expect(output).toMatchObject({success:true,status:200,data:{id:7,firstName:'Иван',avatarUrl:'[private URL]'}});expect(output.data).not.toHaveProperty('passwordHash');expect(output.data).not.toHaveProperty('accessToken');expect(tools.hasEvidence()).toBe(true);
 expect(transport.mock.calls[0][0].href).toBe('http://api:3000/users/7/profile');expect(transport.mock.calls[0][1].redirect).toBe('error');
});
test('API denials are returned as real statuses rather than lack of tool capability',async()=>{
 const transport=jest.fn(async()=>Response.json({code:'FORBIDDEN',message:'Нет доступа'},{status:403})),tools=helpAppApiTools(7,'55:3',{transport:transport as any});
 expect(JSON.parse(await tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:8}},signal()))).toMatchObject({error:'APP_API_FORBIDDEN',status:403});
});
test('arbitrary URLs, extra identity, traversal, credential fields and special transports never execute',async()=>{
 const transport=jest.fn(),tools=helpAppApiTools(7,'55:3',{transport});
 for(const input of [{operationId:'GET https://evil.test/'},{operationId:'GET /users/{userId}/profile',path:{userId:'../1'}},{operationId:'GET /users/{userId}/profile',path:{userId:7},userId:1},{operationId:'POST /help/tickets',body:{password:'secret'}},{operationId:'POST /auth/login',body:{email:'x',password:'y'}}])expect(JSON.parse(await tools.call('app_api_call',input,signal())).error).toBeTruthy();
 expect(transport).not.toHaveBeenCalled();
});
test('role revocation before disclosure rejects even an already received API response',async()=>{
 const transport=jest.fn(async()=>{(prisma.user.findUnique as jest.Mock).mockResolvedValue({...actor,isActive:false});return Response.json({private:'data'});});
 const tools=helpAppApiTools(7,'55:3',{transport:transport as any});
 await expect(tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:7}},signal())).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
});
test('completed mutations replay the same receipt across run attempts; uncertain writes never repeat',async()=>{
 const transport=jest.fn(async()=>Response.json({id:99})),input={operationId:'POST /help/tickets',body:{clientTicketId:'fixture-ticket',clientMessageId:'fixture-message',text:'Example'}};
 const tools=helpAppApiTools(7,'55:3',{transport:transport as any});
 const first=await tools.call('app_api_call',input,signal());expect(JSON.parse(first).success).toBe(true);
 expect(JSON.parse(await helpAppApiTools(7,'55:3',{transport:transport as any}).call('app_api_call',input,signal()))).toMatchObject({success:true,status:200,replayed:true});expect(JSON.parse(await helpAppApiTools(7,'55:3',{transport:transport as any}).call('app_api_call',{...input,body:{...input.body,clientTicketId:'regenerated-id',clientMessageId:'another-id'}},signal()))).toMatchObject({success:true,replayed:true});expect(transport).toHaveBeenCalledTimes(1);
 const fail=jest.fn(async()=>{throw Error('connection lost')});
 const failed=helpAppApiTools(7,'55:4',{transport:fail as any});expect(JSON.parse(await failed.call('app_api_call',input,signal())).error).toBe('APP_API_WRITE_OUTCOME_UNKNOWN');
 expect(JSON.parse(await helpAppApiTools(7,'55:4',{transport:fail as any}).call('app_api_call',input,signal())).error).toBe('APP_API_WRITE_OUTCOME_UNKNOWN');expect(fail).toHaveBeenCalledTimes(1);
});
test('bounded local URL construction and recursive output redaction do not pass tokens',()=>{
 const op=getAppApiOperation('GET /help/tickets/{id}')!;expect(helpAppApiPath(op,{id:52},{q:'слово & знак'})).toBe('/help/tickets/52?q=%D1%81%D0%BB%D0%BE%D0%B2%D0%BE+%26+%D0%B7%D0%BD%D0%B0%D0%BA');
 expect(()=>helpAppApiPath(op,{id:'//host'})).toThrow();
 expect(redactHelpAppApi({password:'secret',apiKey:'secret',deviceToken:'secret',nested:{cookie:'secret',name:'safe'},stack:'private'})).toEqual({nested:{name:'safe'}});
});

test('HTTP200 with an explicit business error is not reported as successful execution',async()=>{
 const transport=jest.fn(async()=>Response.json({ok:false,code:'BUSINESS_DENIED',message:'Отказ'})),tools=helpAppApiTools(7,'55:5',{transport:transport as any});
 expect(JSON.parse(await tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:7}},signal()))).toMatchObject({error:'APP_API_FAILED',status:200,data:{ok:false,code:'BUSINESS_DENIED'}});
});

test('mutation receipts never replay private resource data and reject changed principal grants across attempts',async()=>{
 const transport=jest.fn(async()=>Response.json({id:99,memo:'private customer detail'})),input={operationId:'POST /help/tickets',body:{clientTicketId:'fixture-ticket',clientMessageId:'fixture-message',text:'Example'}};
 const first=await helpAppApiTools(7,'55:6',{transport:transport as any}).call('app_api_call',input,signal());expect(first).toContain('private customer detail');
 const replay=await helpAppApiTools(7,'55:6',{transport:transport as any}).call('app_api_call',input,signal());expect(JSON.parse(replay).replayed).toBe(true);expect(replay).not.toContain('private customer detail');expect(JSON.parse(replay)).not.toHaveProperty('data');
 (prisma.rolePermissions.findMany as jest.Mock).mockResolvedValue([]);
 await expect(helpAppApiTools(7,'55:6',{transport:transport as any}).call('app_api_call',input,signal())).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});expect(transport).toHaveBeenCalledTimes(1);
});

test('signed broker marker and trusted read-through header preserve personal 1C guidance',async()=>{
 let status=502;const transport=jest.fn(async(_url:any,init:any)=>{expect((jwt.verify(init.headers.Authorization.slice(7),'fixture-only') as any).helpApi).toBe(true);return Response.json(status===200?{cached:'snapshot'}:{code:'LEGACY_ERROR'},{status,headers:{'X-Help-App-API-Error':'HELP_API_PERSONAL_ONEC_REQUIRED'}})});
 const tools=helpAppApiTools(7,'55:7',{transport:transport as any});
 expect(JSON.parse(await tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:7}},signal()))).toMatchObject({error:'APP_API_PERSONAL_ONEC_REQUIRED',code:'HELP_API_PERSONAL_ONEC_REQUIRED',status:502});
 status=200;expect(JSON.parse(await tools.call('app_api_call',{operationId:'GET /users/{userId}/profile',path:{userId:7}},signal()))).toMatchObject({success:true,data:{cached:'snapshot'},liveOnecReadBlocked:true});
});
