jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()}}}));
jest.mock('../src/modules/onec-personal/config',()=>({...jest.requireActual('../src/modules/onec-personal/config'),onecBases:jest.fn()}));
import prisma from '../src/prisma/client';
import {onecBases,OnecPersonalError} from '../src/modules/onec-personal/config';
import {helpRequesterContext} from '../src/modules/help/help.requester-context';
import {helpEntityLinks} from '../src/modules/help/help.entity-links';
const user={id:7,firstName:'Иван',lastName:'Петров',middleName:null,role:{name:'employee'},
  currentProfileType:'EMPLOYEE',isActive:true,deletedAt:null,profileStatus:'APPROVED'};
beforeEach(()=>{jest.clearAllMocks();(onecBases as jest.Mock).mockReturnValue([]);(prisma.user.findUnique as jest.Mock).mockResolvedValue(user)});
test('requester is server-bound and exposes only a small identity plus a confirmed self link',async()=>{
 const links=helpEntityLinks(),context=await helpRequesterContext(7,links);
 expect(context.value).toEqual({source:'authenticated_application_user',userId:7,displayName:'Петров Иван',role:'employee',roleDisplayName:'employee',profileType:'EMPLOYEE',
  work:{jobTitle:null,primaryDepartment:null,activeDepartment:null,departmentRoles:[],departmentRolesTruncated:false},
  onec:{integration:'disabled',personalAccess:'unavailable',network:'unknown',bases:[]},
  profile:{label:'Петров Иван',url:'leaderproduct://entity/v1/user/7',target:{v:1,source:'app',kind:'user',id:'7'}}});
 expect(links.sanitize('[Мой профиль](leaderproduct://entity/v1/user/7)')).toContain('](');
 const selected:string[]=[];
 function fields(select:Record<string,any>){for(const [name,value]of Object.entries(select)){selected.push(name);if(value?.select)fields(value.select);}}
 fields((prisma.user.findUnique as jest.Mock).mock.calls[0][0].select);
 expect(selected.join(',')).not.toMatch(/password|login|email|phone|Cipher|boundGuid|onecUserGuid|onecPhysicalPersonGuid/i);
 await context.validate();
});

const base={key:'torg',label:'Торговая база',rpcUrl:'https://fixture.invalid/hs/mcp/rpc',legacyGuidBinding:false,allowVpnHttp:false};
test('work context separates primary and active departments, department roles and unavailable job title',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,role:{name:'employee',displayName:'Сотрудник'},employeeProfile:{status:'APPROVED',department:{id:2,name:'Продажи'},activeDepartment:{id:3,name:'Логистика'}},
  departmentRoles:[{department:{id:3,name:'Логистика'},role:{name:'dispatcher',displayName:'Диспетчер'}}]});
 const {value}=await helpRequesterContext(7,helpEntityLinks());
 expect(value.roleDisplayName).toBe('Сотрудник');expect(value.work).toEqual({jobTitle:null,primaryDepartment:{id:2,name:'Продажи'},activeDepartment:{id:3,name:'Логистика'},
  departmentRoles:[{department:{id:3,name:'Логистика'},role:{name:'dispatcher',displayName:'Диспетчер'}}],departmentRolesTruncated:false});
});
test('saved verification is dated and does not claim current network or object rights',async()=>{
 const verifiedAt=new Date('2026-11-05T00:00:00Z');(onecBases as jest.Mock).mockReturnValue([base,{...base,key:'wms',label:'Склад'}]);
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,employeeProfile:{status:'APPROVED'},onecConnections:[{baseKey:'torg',verifiedAt,revision:2}]});
 const {value}=await helpRequesterContext(7,helpEntityLinks());
 expect(value.onec).toEqual({integration:'enabled',personalAccess:'eligible',network:'unknown',bases:[
  {key:'torg',label:'Торговая база',authorization:'saved_verified',verifiedAt:verifiedAt.toISOString()},
  {key:'wms',label:'Склад',authorization:'required',verifiedAt:null}]});
 expect(JSON.stringify(value)).not.toMatch(/rpcUrl|https:|revision|Cipher|password|login|boundGuid/);
 expect((prisma.user.findUnique as jest.Mock).mock.calls[0][0].select.onecConnections).toMatchObject({
  where:{baseKey:{in:['torg','wms']},verifiedAt:{not:null},loginCipher:{not:null},passwordCipher:{not:null}},
  select:{baseKey:true,verifiedAt:true,revision:true}});
});
test('a blocked or absent employee profile does not claim personal 1C access',async()=>{
 (onecBases as jest.Mock).mockReturnValue([base]);
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,employeeProfile:{status:'BLOCKED'},onecConnections:[{baseKey:'torg',verifiedAt:new Date(),revision:1}]});
 expect((await helpRequesterContext(7,helpEntityLinks())).value.onec).toMatchObject({personalAccess:'unavailable',bases:[{authorization:'unavailable',verifiedAt:null}]});
});
test('a broken 1C catalog is explicit and does not prevent ordinary profile context',async()=>{
 (onecBases as jest.Mock).mockImplementation(()=>{throw new OnecPersonalError('ONEC_NOT_CONFIGURED',503)});
 expect((await helpRequesterContext(7,helpEntityLinks())).value.onec).toEqual({integration:'not_configured',personalAccess:'unavailable',network:'unknown',bases:[]});
});
test.each(['department','connection-revision','catalog-binding'])('a changed %s is fenced by transaction-scoped validation',async change=>{
 (onecBases as jest.Mock).mockReturnValue([base]);
 const actor={...user,employeeProfile:{status:'APPROVED',department:{id:2,name:'Продажи'}},onecConnections:[{baseKey:'torg',verifiedAt:new Date('2026-11-05T00:00:00Z'),revision:1}]};
 (prisma.user.findUnique as jest.Mock).mockResolvedValue(actor);const context=await helpRequesterContext(7,helpEntityLinks());
 const updated=change==='department'?{...actor,employeeProfile:{status:'APPROVED',department:{id:3,name:'Склад'}}}:change==='connection-revision'?{...actor,onecConnections:[{...actor.onecConnections[0],revision:2}]}:actor;
 if(change==='catalog-binding')(onecBases as jest.Mock).mockReturnValue([{...base,rpcUrl:'https://changed.invalid/hs/mcp/rpc'}]);
 const tx={user:{findUnique:jest.fn(async()=>updated)}};
 await expect(context.validate(tx as any)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('many department roles are bounded and explicitly marked truncated',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,departmentRoles:Array.from({length:21},(_,id)=>({department:{id,name:'Отдел '+id},role:{name:'role',displayName:'Роль'}}))});
 const {value}=await helpRequesterContext(7,helpEntityLinks());expect(value.work?.departmentRoles).toHaveLength(20);expect(value.work?.departmentRolesTruncated).toBe(true);
});
test('clients can receive their own identity without access to the employee directory',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,role:{name:'client'},currentProfileType:'CLIENT'});
 expect((await helpRequesterContext(7,helpEntityLinks())).value.profile.url).toBe('leaderproduct://entity/v1/user/7');
});
test.each([{isActive:false},{deletedAt:new Date()},{profileStatus:'BLOCKED'}, {role:{name:'client'}},{firstName:'Новое имя'}])('revocation or changed identity is checked inside the supplied publication transaction: %o',async change=>{
 const context=await helpRequesterContext(7,helpEntityLinks());
 const tx={user:{findUnique:jest.fn(async()=>({...user,...change}))}};
 await expect(context.validate(tx as any)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
 expect(tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({where:{id:7}}));
});
test.each([null,{...user,isActive:false},{...user,profileStatus:'BLOCKED'}])('unavailable users cannot establish context: %o',async row=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue(row);
 await expect(helpRequesterContext(7,helpEntityLinks())).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
