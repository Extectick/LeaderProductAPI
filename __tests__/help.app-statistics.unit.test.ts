jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn(),groupBy:jest.fn()},role:{findUnique:jest.fn()},rolePermissions:{findFirst:jest.fn()}}}));
import prisma from '../src/prisma/client';
import {helpUserStatistics,validateHelpUserStatisticsAccess} from '../src/modules/help/help.app-statistics';
const signal=new AbortController().signal;
const user={roleId:1,isActive:true,deletedAt:null,profileStatus:'ACTIVE',employeeProfile:{status:'ACTIVE'},departmentRoles:[]};
beforeEach(()=>{
 jest.clearAllMocks();(prisma.user.findUnique as jest.Mock).mockResolvedValue(user);
 (prisma.role.findUnique as jest.Mock).mockImplementation(async({where})=>({name:where.id===1?'admin':'employee',parentRoleId:null}));
 (prisma.rolePermissions.findFirst as jest.Mock).mockResolvedValue(null);
 (prisma.user.groupBy as jest.Mock).mockResolvedValue([{isActive:true,_count:{_all:95}},{isActive:false,_count:{_all:7}}]);
});
test('returns only a consistent aggregate of non-deleted application accounts, never online status or identities',async()=>{
 const tools=helpUserStatistics(1),out=JSON.parse(await tools.call({},signal));
 expect(out).toMatchObject({success:true,source:'application_database',scope:'non_deleted_accounts',total:102,enabled:95,disabled:7});
 expect(new Date(out.asOf).toISOString()).toBe(out.asOf);expect(out.enabledDefinition).toContain('not online');
 expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);expect(prisma.user.groupBy).toHaveBeenCalledWith({by:['isActive'],where:{deletedAt:null},_count:{_all:true}});
 expect(Object.keys(out).sort()).toEqual(['asOf','disabled','enabled','enabledDefinition','scope','source','success','total'].sort());
 expect(tools.hasEvidence()).toBe(true);expect(prisma.rolePermissions.findFirst).not.toHaveBeenCalled();
});
test('an employee without manage_users is denied before reading counts',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,roleId:2});const tools=helpUserStatistics(5);
 expect(JSON.parse(await tools.call({},signal))).toEqual({error:'APP_USER_STATS_FORBIDDEN'});expect(tools.hasEvidence()).toBe(false);expect(prisma.user.groupBy).not.toHaveBeenCalled();
});
test('a global role inherits the same admin bypass as the user administration endpoint',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,roleId:2});
 (prisma.role.findUnique as jest.Mock).mockImplementation(async({where})=>where.id===2?{name:'specialized',parentRoleId:1}:{name:'administrator',parentRoleId:null});
 await expect(validateHelpUserStatisticsAccess(5)).resolves.toBeUndefined();expect(prisma.rolePermissions.findFirst).not.toHaveBeenCalled();
});
test('department ancestry can grant manage_users, but an admin name on a department role alone is not a bypass',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,roleId:2,departmentRoles:[{roleId:3}]});
 (prisma.role.findUnique as jest.Mock).mockImplementation(async({where})=>({name:where.id===3?'admin':'employee',parentRoleId:where.id===3?4:null}));
 await expect(validateHelpUserStatisticsAccess(5)).rejects.toMatchObject({code:'HELP_APP_STATS_FORBIDDEN'});
 (prisma.rolePermissions.findFirst as jest.Mock).mockResolvedValue({roleId:4});
 await expect(validateHelpUserStatisticsAccess(5)).resolves.toBeUndefined();
 expect(prisma.rolePermissions.findFirst).toHaveBeenLastCalledWith({where:{roleId:{in:[2,3,4]},permission:{name:'manage_users'}},select:{roleId:true}});
});
test.each([{isActive:false},{deletedAt:new Date()},{profileStatus:'BLOCKED'},{employeeProfile:{status:'BLOCKED'}}])('blocked/deleted/disabled requester is denied: %j',async change=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,...change});
 expect(JSON.parse(await helpUserStatistics(1).call({},signal))).toEqual({error:'APP_USER_STATS_FORBIDDEN'});expect(prisma.user.groupBy).not.toHaveBeenCalled();
});
test('unknown arguments and aborted requests do not query accounts or privileges',async()=>{
 const tools=helpUserStatistics(1);expect(JSON.parse(await tools.call({includeEmails:true},signal))).toEqual({error:'APP_USER_STATS_ARGUMENTS'});
 await expect(tools.call({},AbortSignal.abort())).rejects.toThrow();expect(prisma.user.findUnique).not.toHaveBeenCalled();expect(prisma.user.groupBy).not.toHaveBeenCalled();
});
test('revocation during the aggregate read prevents evidence and disclosure',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(user).mockResolvedValue({...user,isActive:false});
 const tools=helpUserStatistics(1);await expect(tools.call({},signal)).rejects.toMatchObject({code:'HELP_APP_STATS_FORBIDDEN'});expect(tools.hasEvidence()).toBe(false);
});
test('subsequent publication validates current privileges using its transaction',async()=>{
 const tools=helpUserStatistics(1);await tools.call({},signal);
 const tx={user:{findUnique:jest.fn().mockResolvedValue({...user,isActive:false})}};
 await expect(tools.validate(tx as any)).rejects.toMatchObject({code:'HELP_APP_STATS_FORBIDDEN'});expect(tx.user.findUnique).toHaveBeenCalled();
});
test('zero users is verified evidence; no previously read data means validation has no side effect',async()=>{
 const tools=helpUserStatistics(1);await tools.validate();expect(prisma.user.findUnique).not.toHaveBeenCalled();
 (prisma.user.groupBy as jest.Mock).mockResolvedValue([]);expect(JSON.parse(await tools.call({},signal))).toMatchObject({total:0,enabled:0,disabled:0});expect(tools.hasEvidence()).toBe(true);
});
