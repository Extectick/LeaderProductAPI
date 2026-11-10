jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()},role:{findMany:jest.fn()},rolePermissions:{findMany:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>{
 class HelpError extends Error{constructor(public status:number,public code:string,message:string){super(message)}}
 return {HelpError,helpActor:jest.fn()};
});
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import prisma from '../src/prisma/client';
import {helpActor,HelpError} from '../src/modules/help/help.service';
import {helpGatewayTools,requestGatewayDiagnosis} from '../src/modules/help/help.gateway-tools';
const actor={userId:7,canManage:true};
const user={roleId:2,isActive:true,deletedAt:null,profileStatus:'APPROVED',employeeProfile:{status:'ACTIVE'},departmentRoles:[]};
const live=()=>({ok:true,gateway:'nsk',observedAt:new Date().toISOString(),endpoint:'192.168.30.1:22',results:{disk:{availableGiB:42},services:{smbd:'active'}}});
let server:http.Server|undefined,folder:string|undefined;
const signal=()=>new AbortController().signal;
async function socket(handler:http.RequestListener){folder=await mkdtemp(path.join(os.tmpdir(),'help-gw-'));const socketPath=path.join(folder,'control.sock');server=http.createServer(handler);await new Promise<void>(resolve=>server!.listen(socketPath,resolve));return socketPath;}
beforeEach(()=>{jest.clearAllMocks();(helpActor as jest.Mock).mockResolvedValue(actor);(prisma.user.findUnique as jest.Mock).mockResolvedValue(user);(prisma.role.findMany as jest.Mock).mockResolvedValue([{id:2,name:'admin',parentRoleId:null}]);(prisma.rolePermissions.findMany as jest.Mock).mockResolvedValue([])});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}if(folder){await rm(folder,{recursive:true,force:true});folder=undefined;}});
test('saved inventory explains gateway roles, file shares and dual WAN without claiming live status',async()=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:false});const transport=jest.fn(),tools=helpGatewayTools(7,{transport});
 const value=JSON.parse(await tools.call('app_gateway_info',{},signal()));
 expect(value).toMatchObject({success:true,source:'saved_infrastructure_inventory',live:false,inventoryDate:'2026-11-06'});expect(value.gateways).toHaveLength(2);
 expect(value.gateways[0].services.some((service:any)=>service.name==='Samba')).toBe(true);expect(value.gateways[1].providers.map((row:any)=>row.address)).toEqual(['91.144.170.136','95.80.103.205/24']);
 expect(JSON.stringify(value)).toContain('files_nsk');expect(JSON.stringify(value)).not.toMatch(/IdentityFile|ed25519|known_hosts|password|authorized_keys/);expect(transport).not.toHaveBeenCalled();expect(tools.hasEvidence()).toBe(true);
});
test('invalid gateway, command, host, identity and key overrides never contact the executor',async()=>{
 const transport=jest.fn(),tools=helpGatewayTools(7,{transport});
 for(const args of [{gateway:'unknown'},{gateway:'nsk',command:'sudo reboot'},{gateway:'nsk',host:'host.invalid'},{gateway:'nsk',userId:1},{gateway:'nsk',key:'secret'},{gateway:'nsk',kind:'restart'}])expect(JSON.parse(await tools.call('app_gateway_diagnostics',args,signal())).error).toBe('APP_GATEWAY_ARGUMENTS');
 await expect(tools.call('app_gateway_diagnostics',{gateway:'nsk'},AbortSignal.abort())).rejects.toThrow();expect(helpActor).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();
});
test('normal Help user can read inventory but cannot perform privileged live diagnostics',async()=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:false});const transport=jest.fn(),tools=helpGatewayTools(7,{transport});
 expect(JSON.parse(await tools.call('app_gateway_diagnostics',{gateway:'nsk'},signal())).error).toBe('APP_GATEWAY_FORBIDDEN');expect(transport).not.toHaveBeenCalled();expect(prisma.user.findUnique).not.toHaveBeenCalled();
});
test('live diagnostics recheck actor and grants before publication and use the supplied transaction',async()=>{
 const transport=jest.fn(async()=>live()),tools=helpGatewayTools(7,{transport});
 const value=JSON.parse(await tools.call('app_gateway_diagnostics',{gateway:'nsk',kind:'files'},signal()));expect(value).toMatchObject({success:true,live:true,source:'live_gateway_readonly',results:{disk:{availableGiB:42}}});
 expect(transport).toHaveBeenCalledWith({gateway:'nsk',kind:'files'},expect.any(AbortSignal),'/run/leader-help-gateways/control.sock');expect(helpActor).toHaveBeenCalledTimes(2);
 const db={user:{findUnique:jest.fn(async()=>user)},role:{findMany:jest.fn(async()=>[{id:2,name:'admin',parentRoleId:null}])},rolePermissions:{findMany:jest.fn(async()=>[])}};
 await tools.validate(db as any);expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({where:{id:7}}));
 db.rolePermissions.findMany.mockResolvedValue([{roleId:2,permission:{name:'manage_help'}}] as never);await expect(tools.validate(db as any)).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
});
test('revocation during SSH request prevents returning an already prepared result',async()=>{
 const transport=jest.fn(async()=>{(helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:false});return live()});const tools=helpGatewayTools(7,{transport});
 await expect(tools.call('app_gateway_diagnostics',{gateway:'nsk'},signal())).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
});
test('unavailable executor and denied service have safe errors without raw SSH diagnostics',async()=>{
 const tools=helpGatewayTools(7,{transport:jest.fn(async()=>{throw Error('password=private ssh key /private/path')})});
 expect(await tools.call('app_gateway_diagnostics',{gateway:'omsk'},signal())).not.toMatch(/private|password|key/);
 (helpActor as jest.Mock).mockRejectedValue(new HelpError(403,'HELP_FORBIDDEN','secret internal detail'));
 expect(JSON.parse(await helpGatewayTools(7).call('app_gateway_info',{},signal())).error).toBe('APP_GATEWAY_FORBIDDEN');
});
test('Unix HTTP transport sends only fixed operation fields and strips credential result fields',async()=>{
 let body='';const socketPath=await socket((req,res)=>{expect(req.url).toBe('/diagnose');expect(req.method).toBe('POST');req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...live(),results:{state:'active',privateKey:'hidden',nested:{password:'hidden',port:1194}}}));});});
 const value=await requestGatewayDiagnosis({gateway:'nsk',kind:'vpn'},signal(),socketPath) as any;
 expect(JSON.parse(body)).toEqual({gateway:'nsk',kind:'vpn'});expect(value.results).toEqual({state:'active',nested:{port:1194}});expect(JSON.stringify(value)).not.toContain('hidden');
});
test('mismatched host identities, oversized output and private key content fail closed',async()=>{
 let mode='mismatch';const socketPath=await socket((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(mode==='mismatch'?{...live(),gateway:'omsk'}:mode==='large'?{...live(),results:{text:'x'.repeat(129*1024)}}:{...live(),results:{text:'-----BEGIN OPENSSH PRIVATE KEY-----'}}));});
 for(const next of ['mismatch','large','private']){mode=next;await expect(requestGatewayDiagnosis({gateway:'nsk'},signal(),socketPath)).rejects.toThrow();}
});
test('an aborted socket request closes without producing late model data',async()=>{
 const socketPath=await socket((_req,_res)=>{}),controller=new AbortController();const result=requestGatewayDiagnosis({gateway:'nsk'},controller.signal,socketPath);controller.abort();await expect(result).rejects.toMatchObject({name:'AbortError'});
});
test.each(['dhcp','devices','printers','smb'])('new %s observation retains privilege and publication checks',async kind=>{
 const transport=jest.fn(async()=>live()),tools=helpGatewayTools(7,{transport});
 expect(JSON.parse(await tools.call('app_gateway_diagnostics',{gateway:'nsk',kind},signal()))).toMatchObject({success:true,live:true});
 expect(transport).toHaveBeenCalledWith({gateway:'nsk',kind},expect.any(AbortSignal),expect.any(String));
 (helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:false});
 await expect(tools.validate()).rejects.toMatchObject({code:'HELP_PEOPLE_UNAVAILABLE'});
 expect(JSON.parse(await helpGatewayTools(7,{transport}).call('app_gateway_diagnostics',{gateway:'nsk',kind},signal())).error).toBe('APP_GATEWAY_FORBIDDEN');
});
