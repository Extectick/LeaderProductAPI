import prisma from '../../prisma/client';
import {resolveServiceAccessForUser} from '../../services/serviceAccess';
import {computeUserPermissions,getRoleHierarchyByName} from '../../middleware/auth';
import {EntityResolveError} from './entity.service';

/** Reuse the actual stock route's service policy and permission functions. */
export async function assertAppStockAccess(userId:number){
 const user=await prisma.user.findUnique({where:{id:userId},select:{isActive:true,deletedAt:true,profileStatus:true,employeeProfile:{select:{status:true}},role:{select:{name:true}}}});
 if(!user?.isActive||user.deletedAt||user.profileStatus==='BLOCKED'||user.employeeProfile?.status==='BLOCKED')throw new EntityResolveError('ENTITY_SESSION_REQUIRED',401);
 const access=await resolveServiceAccessForUser(userId,'stock_balances');
 if(!access?.isEmployee||!access.visible||!access.enabled)throw new EntityResolveError('ENTITY_ACCESS_DENIED',403);
 const roles=await getRoleHierarchyByName(user.role.name);
 if(roles.has('admin')||roles.has('administrator'))return;
 if(!(await computeUserPermissions(userId)).has('view_stock_balances'))throw new EntityResolveError('ENTITY_ACCESS_DENIED',403);
}
