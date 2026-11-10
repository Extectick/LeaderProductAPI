import type {Prisma} from '@prisma/client';
import {z} from 'zod';
import prisma from '../../prisma/client';

type Reader=Prisma.TransactionClient;
class HelpAppStatisticsError extends Error {
  readonly code='HELP_APP_STATS_FORBIDDEN';
  constructor(){super('HELP_APP_STATS_FORBIDDEN');}
}
/** Same global admin bypass and inherited manage_users grant as /users/admin/list. */
export async function validateHelpUserStatisticsAccess(userId:number,db:Reader=prisma){
  const user=await db.user.findUnique({where:{id:userId},select:{roleId:true,isActive:true,deletedAt:true,profileStatus:true,
    employeeProfile:{select:{status:true}},departmentRoles:{select:{roleId:true}}}});
  if(!user?.isActive||user.deletedAt||user.profileStatus==='BLOCKED'||user.employeeProfile?.status==='BLOCKED')throw new HelpAppStatisticsError();
  const all=new Set<number>();
  async function chain(start:number,global:boolean){
    const seen=new Set<number>();let id:number|null=start,admin=false;
    while(id!==null&&!seen.has(id)){
      if(seen.size>=64)throw new HelpAppStatisticsError();
      seen.add(id);all.add(id);
      const role:{name:string;parentRoleId:number|null}|null=await db.role.findUnique({where:{id},select:{name:true,parentRoleId:true}});
      if(!role)throw new HelpAppStatisticsError();
      if(global&&['admin','administrator'].includes(role.name))admin=true;
      id=role.parentRoleId;
    }
    return admin;
  }
  if(await chain(user.roleId,true))return;
  for(const role of user.departmentRoles)await chain(role.roleId,false);
  const permission=await db.rolePermissions.findFirst({where:{roleId:{in:[...all]},permission:{name:'manage_users'}},select:{roleId:true}});
  if(!permission)throw new HelpAppStatisticsError();
}

export function helpUserStatistics(userId:number){
  let evidence=false;
  return {
    definition:{type:'function',name:'app_get_user_stats',strict:true,
      description:'Прочитать текущие счётчики учётных записей именно приложения LeaderProduct. Требует текущего права manage_users или глобальной административной роли. Возвращает только количество неудалённых, включённых и отключённых учётных записей и время проверки. isActive — флаг учётной записи, не онлайн и не активность за период. Никаких имён, почты, телефонов, паролей или списка пользователей. Для количества не используй поиск профилей или 1С.',
      parameters:{type:'object',additionalProperties:false,properties:{},required:[]}},
    hasEvidence:()=>evidence,
    validate:async(db?:Reader)=>{if(evidence)await validateHelpUserStatisticsAccess(userId,db);},
    async call(input:unknown,signal:AbortSignal){
      if(!z.object({}).strict().safeParse(input).success)return JSON.stringify({error:'APP_USER_STATS_ARGUMENTS'});
      signal.throwIfAborted();
      try{await validateHelpUserStatisticsAccess(userId);}catch(error){if(error instanceof HelpAppStatisticsError)return JSON.stringify({error:'APP_USER_STATS_FORBIDDEN'});throw error;}
      signal.throwIfAborted();
      // One aggregate query gives a consistent snapshot without fetching identities.
      const rows=await prisma.user.groupBy({by:['isActive'],where:{deletedAt:null},_count:{_all:true}});
      signal.throwIfAborted();await validateHelpUserStatisticsAccess(userId);signal.throwIfAborted();
      const enabled=rows.find(row=>row.isActive)?._count._all??0;
      const disabled=rows.find(row=>!row.isActive)?._count._all??0;
      evidence=true;
      return JSON.stringify({success:true,source:'application_database',scope:'non_deleted_accounts',asOf:new Date().toISOString(),
        total:enabled+disabled,enabled,disabled,enabledDefinition:'isActive=true; not online status or activity over a period'});
    },
  };
}
