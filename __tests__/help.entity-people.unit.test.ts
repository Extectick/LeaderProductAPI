jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn(),findFirst:jest.fn(),findMany:jest.fn(),count:jest.fn()}}}));
import prisma from '../src/prisma/client';
import {helpPeopleTools,canReadForeignPeople} from '../src/modules/help/help.entity-people';
import {helpEntityLinks} from '../src/modules/help/help.entity-links';
const actor={isActive:true,deletedAt:null,profileStatus:'APPROVED',role:{name:'employee'},currentProfileType:'EMPLOYEE',employeeProfile:{id:5},departmentRoles:[]};
const signal=new AbortController().signal;
beforeEach(()=>{jest.clearAllMocks();(prisma.user.findUnique as jest.Mock).mockResolvedValue(actor);(prisma.user.findFirst as jest.Mock).mockResolvedValue({id:2,firstName:'Иван',lastName:'Тестовый',middleName:null});(prisma.user.findMany as jest.Mock).mockResolvedValue([{id:2,firstName:'Иван',lastName:'Тестовый',middleName:null}]);(prisma.user.count as jest.Mock).mockResolvedValue(1)});
test('employee search returns confirmed app identities and names without selecting private contact/auth fields',async()=>{
 const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);const out=JSON.parse(await tools.call('app_search_people',{query:'Тестовый Иван'},signal));
 expect(out).toMatchObject({success:true,truncated:false,people:[{id:2,label:'Тестовый Иван',url:'leaderproduct://entity/v1/user/2',target:{v:1,source:'app',kind:'user',id:'2'}}]});
 expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({select:{id:true,firstName:true,lastName:true,middleName:true},where:expect.objectContaining({AND:expect.any(Array)})}));
 expect(JSON.stringify((prisma.user.findMany as jest.Mock).mock.calls)).not.toMatch(/email|phone|password|telegram|onecUserGuid/);
 expect(tools.hasEvidence()).toBe(true);expect(catalog.sanitize('[Иван](leaderproduct://entity/v1/user/2)')).toContain('](');
});
test('profile ACL matches self/employee/admin semantics instead of granting foreign profiles to clients',async()=>{
 const client={...actor,role:{name:'client'},currentProfileType:'CLIENT',employeeProfile:null};
 expect(canReadForeignPeople(client)).toBe(false);expect(canReadForeignPeople({...client,role:{name:'Administrator'}})).toBe(true);expect(canReadForeignPeople({...client,departmentRoles:[{id:3}]})).toBe(true);
 (prisma.user.findUnique as jest.Mock).mockResolvedValue(client);(prisma.user.findMany as jest.Mock).mockResolvedValue([]);
 await helpPeopleTools(1,helpEntityLinks()).call('app_search_people',{query:'Тест'},signal);
 const where=(prisma.user.findMany as jest.Mock).mock.calls[0][0].where;
 expect(where.AND.at(-1)).toEqual({id:1});
});
test('invalid and aborted requests do not query the directory',async()=>{
 const tools=helpPeopleTools(1,helpEntityLinks());
 expect(JSON.parse(await tools.call('app_search_people',{query:'a'},signal))).toEqual({error:'APP_PEOPLE_ARGUMENTS'});
 expect(JSON.parse(await tools.call('app_search_people',{query:'Иван',includeSecrets:true},signal))).toEqual({error:'APP_PEOPLE_ARGUMENTS'});
 await expect(tools.call('app_search_people',{query:'Иван'},AbortSignal.abort())).rejects.toThrow();
 expect(prisma.user.findUnique).not.toHaveBeenCalled();
});
test('result truncation is explicit and a connection/account change blocks later disclosure',async()=>{
 (prisma.user.findMany as jest.Mock).mockResolvedValue([{id:2,firstName:'Первый'},{id:3,firstName:'Второй'}]);
 const tools=helpPeopleTools(1,helpEntityLinks());const out=JSON.parse(await tools.call('app_search_people',{query:'Иван',limit:1},signal));
 expect(out.truncated).toBe(true);expect(out.people).toHaveLength(1);
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...actor,isActive:false});await expect(tools.validate()).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('deletion of an exposed profile blocks a subsequent final validation',async()=>{
 const tools=helpPeopleTools(1,helpEntityLinks());await tools.call('app_search_people',{query:'Иван'},signal);
 (prisma.user.count as jest.Mock).mockResolvedValue(0);await expect(tools.validate()).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});

test('a successful empty search is evidence of no matches under those conditions',async()=>{
 (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
 const tools=helpPeopleTools(1,helpEntityLinks());const output=JSON.parse(await tools.call('app_search_people',{query:'НетСовпадения'},signal));
 expect(output).toMatchObject({success:true,people:[],entityLinks:[],truncated:false});expect(tools.hasEvidence()).toBe(true);expect(prisma.user.count).not.toHaveBeenCalled();
});
test('a known APP id can be read without a name search and only then establishes link provenance',async()=>{
 const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);
 expect(catalog.isConfirmed('leaderproduct://entity/v1/user/2')).toBe(false);
 const output=JSON.parse(await tools.call('app_get_person',{userId:2},signal));
 expect(output).toEqual({success:true,person:{id:2,displayName:'Тестовый Иван',label:'Тестовый Иван',url:'leaderproduct://entity/v1/user/2',target:{v:1,source:'app',kind:'user',id:'2'}},
  entityLinks:[{label:'Тестовый Иван',url:'leaderproduct://entity/v1/user/2',target:{v:1,source:'app',kind:'user',id:'2'}}]});
 expect(prisma.user.findFirst).toHaveBeenCalledWith({where:{id:2,isActive:true,deletedAt:null,profileStatus:{not:'BLOCKED'}},select:{id:true,firstName:true,lastName:true,middleName:true}});
 expect(prisma.user.findMany).not.toHaveBeenCalled();expect(tools.hasEvidence()).toBe(true);expect(catalog.isConfirmed(output.person.url)).toBe(true);
});
test('a client can read self by APP id but cannot read another profile',async()=>{
 const client={...actor,role:{name:'client'},currentProfileType:'CLIENT',employeeProfile:null};(prisma.user.findUnique as jest.Mock).mockResolvedValue(client);
 const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);
 expect(JSON.parse(await tools.call('app_get_person',{userId:2},signal))).toEqual({error:'APP_PEOPLE_UNAVAILABLE'});
 expect(prisma.user.findFirst).not.toHaveBeenCalled();expect(catalog.isConfirmed('leaderproduct://entity/v1/user/2')).toBe(false);expect(tools.hasEvidence()).toBe(false);
 (prisma.user.findFirst as jest.Mock).mockResolvedValue({id:1,firstName:'Клиент',lastName:null,middleName:null});
 expect(JSON.parse(await tools.call('app_get_person',{userId:1},signal))).toMatchObject({success:true,person:{id:1,displayName:'Клиент',url:'leaderproduct://entity/v1/user/1'}});
});
test.each([{}, {userId:0},{userId:-1},{userId:1.5},{userId:2147483648},{userId:'2'},{userId:2,includeSecrets:true}])('invalid APP id arguments are rejected before data access: %o',async input=>{
 const tools=helpPeopleTools(1,helpEntityLinks());expect(JSON.parse(await tools.call('app_get_person',input,signal))).toEqual({error:'APP_PEOPLE_ARGUMENTS'});
 expect(prisma.user.findUnique).not.toHaveBeenCalled();expect(prisma.user.findFirst).not.toHaveBeenCalled();
});
test('missing or unavailable profiles never establish a link',async()=>{
 (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);
 expect(JSON.parse(await tools.call('app_get_person',{userId:2},signal))).toEqual({error:'APP_PEOPLE_UNAVAILABLE'});
 expect(catalog.isConfirmed('leaderproduct://entity/v1/user/2')).toBe(false);expect(tools.hasEvidence()).toBe(false);
});
test('losing foreign-profile access during read prevents disclosure and registration',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(actor).mockResolvedValue({...actor,role:{name:'client'},employeeProfile:null,currentProfileType:'CLIENT'});
 const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);
 await expect(tools.call('app_get_person',{userId:2},signal)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
 expect(catalog.isConfirmed('leaderproduct://entity/v1/user/2')).toBe(false);
});
test('blocking or deleting an exposed profile is rechecked before subsequent disclosure',async()=>{
 const tools=helpPeopleTools(1,helpEntityLinks());await tools.call('app_get_person',{userId:2},signal);
 expect(prisma.user.count).toHaveBeenCalledWith({where:{id:{in:[2]},isActive:true,deletedAt:null,profileStatus:{not:'BLOCKED'}}});
 (prisma.user.count as jest.Mock).mockResolvedValue(0);await expect(tools.validate()).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});
test('an aborted id read neither queries a profile nor registers a URL',async()=>{
 const catalog=helpEntityLinks(),tools=helpPeopleTools(1,catalog);
 await expect(tools.call('app_get_person',{userId:2},AbortSignal.abort())).rejects.toThrow();
 expect(prisma.user.findUnique).not.toHaveBeenCalled();expect(prisma.user.findFirst).not.toHaveBeenCalled();expect(catalog.isConfirmed('leaderproduct://entity/v1/user/2')).toBe(false);
});
