import { ProfileType, type Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prisma/client';
import type { HelpEntityLinks } from './help.entity-links';
import {helpUserStatistics} from './help.app-statistics';

const schema = z.object({query:z.string().trim().min(2).max(120),limit:z.number().int().min(1).max(20).optional()}).strict();
const personSchema=z.object({userId:z.number().int().min(1).max(2147483647)}).strict();
type Requester = {isActive:boolean;deletedAt:Date|null;profileStatus:string;role:{name:string};currentProfileType:string|null;employeeProfile:{id:number}|null;departmentRoles:Array<{id:number}>};
/** Mirrors GET /users/:id/profile's existing self/employee/admin access. */
export function canReadForeignPeople(requester: Requester) {
  const role = String(requester.role?.name || '').trim().toLowerCase().replace(/[\s_-]+/g,'');
  return ['admin','administrator','employee','departmentmanager'].includes(role) || !!requester.employeeProfile ||
    requester.departmentRoles.length > 0 || requester.currentProfileType === ProfileType.EMPLOYEE;
}
export type HelpPeopleTools = {definitions:unknown[];call:(name:string,args:unknown,signal:AbortSignal)=>Promise<string>;validate:()=>Promise<void>;hasEvidence:()=>boolean;
  hasStatsEvidence?:()=>boolean;validateAppAccess?:(db:Prisma.TransactionClient)=>Promise<void>};
export function helpPeopleTools(userId: number, links: HelpEntityLinks): HelpPeopleTools {
  const statistics=helpUserStatistics(userId);
  const exposed = new Set<number>();
  let readPerformed=false;
  async function requester() {
    const user = await prisma.user.findUnique({where:{id:userId},select:{
      isActive:true,deletedAt:true,profileStatus:true,role:{select:{name:true}},currentProfileType:true,
      employeeProfile:{select:{id:true}},departmentRoles:{select:{id:true},take:1},
    }});
    if (!user?.isActive || user.deletedAt || user.profileStatus==='BLOCKED') throw new Error('HELP_PEOPLE_UNAVAILABLE');
    return user;
  }
  async function validate() {
    await statistics.validate();
    if (!readPerformed) return;
    const user=await requester();
    if (!canReadForeignPeople(user) && [...exposed].some(id=>id!==userId)) throw new Error('HELP_PEOPLE_UNAVAILABLE');
    if(!exposed.size)return;
    const count=await prisma.user.count({where:{id:{in:[...exposed]},isActive:true,deletedAt:null,profileStatus:{not:'BLOCKED'}}});
    if(count!==exposed.size)throw new Error('HELP_PEOPLE_UNAVAILABLE');
  }
  return {
    definitions:[{type:'function',name:'app_search_people',strict:false,description:'Найти профиль сотрудника в приложении по имени или фамилии и получить подтверждённую ссылку на карточку. Только чтение публичных для сотрудника имён и APP id; никаких паролей, телефонов, почты или логинов. Для бизнес-данных сотрудника в 1С используй личные инструменты 1С отдельно.',parameters:{type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:2,maxLength:120},limit:{type:'integer',minimum:1,maximum:20}},required:['query']}},
      {type:'function',name:'app_get_person',strict:true,description:'Прочитать доступный профиль приложения по известному APP userId, например из текущей открытой карточки, и получить имя с подтверждённой ссылкой. Не требует ФИО для поиска. APP userId — положительное целое число, не GUID 1С. Действуют те же права просмотра собственного/чужого профиля, что в приложении. Возвращает только имя и APP id, без контактов и реквизитов авторизации.',parameters:{type:'object',additionalProperties:false,properties:{userId:{type:'integer',minimum:1,maximum:2147483647}},required:['userId']}},statistics.definition],
    hasEvidence:()=>readPerformed||statistics.hasEvidence(),
    hasStatsEvidence:statistics.hasEvidence,
    validateAppAccess:statistics.validate,
    validate,
    async call(name,input,signal) {
      if(name==='app_get_user_stats')return statistics.call(input,signal);
      if(name==='app_get_person'){
        const parsed=personSchema.safeParse(input);
        if(!parsed.success)return JSON.stringify({error:'APP_PEOPLE_ARGUMENTS'});
        signal.throwIfAborted();const actor=await requester();signal.throwIfAborted();
        if(parsed.data.userId!==userId&&!canReadForeignPeople(actor))return JSON.stringify({error:'APP_PEOPLE_UNAVAILABLE'});
        const row=await prisma.user.findFirst({where:{id:parsed.data.userId,isActive:true,deletedAt:null,profileStatus:{not:'BLOCKED'}},
          select:{id:true,firstName:true,lastName:true,middleName:true}});
        signal.throwIfAborted();
        if(!row)return JSON.stringify({error:'APP_PEOPLE_UNAVAILABLE'});
        readPerformed=true;exposed.add(row.id);
        await validate();signal.throwIfAborted();
        const displayName=[row.lastName,row.firstName,row.middleName].filter(Boolean).join(' ').trim().slice(0,300);
        const link=links.register({v:1,source:'app',kind:'user',id:String(row.id)},displayName||'Профиль пользователя');
        return JSON.stringify({success:true,person:{id:row.id,displayName,...link},entityLinks:[link]});
      }
      const args=name==='app_search_people'?schema.safeParse(input):null;
      if(!args?.success)return JSON.stringify({error:'APP_PEOPLE_ARGUMENTS'});
      signal.throwIfAborted();const actor=await requester();signal.throwIfAborted();
      const broad=canReadForeignPeople(actor),limit=args.data.limit||10;
      const tokens=args.data.query.split(/\s+/u).filter(Boolean).slice(0,6);
      const names:Prisma.UserWhereInput[]=tokens.map(token=>({OR:['firstName','lastName','middleName'].map(key=>({[key]:{contains:token,mode:'insensitive'}}))}));
      const employees:Prisma.UserWhereInput={OR:[{employeeProfile:{isNot:null}},{departmentRoles:{some:{}}},{currentProfileType:ProfileType.EMPLOYEE},{role:{name:{in:['admin','administrator','employee','departmentmanager'],mode:'insensitive'}}}]};
      const rows=await prisma.user.findMany({where:{isActive:true,deletedAt:null,profileStatus:{not:'BLOCKED'},AND:[...names,broad?employees:{id:userId}]},select:{id:true,firstName:true,lastName:true,middleName:true},orderBy:[{lastName:'asc'},{firstName:'asc'},{id:'asc'}],take:limit+1});
      signal.throwIfAborted();
      readPerformed=true;
      const results=rows.slice(0,limit).map(row=>{
        const label=[row.lastName,row.firstName,row.middleName].filter(Boolean).join(' ').trim();
        exposed.add(row.id);return {...links.register({v:1,source:'app',kind:'user',id:String(row.id)},label||'Сотрудник'),id:row.id};
      });
      await validate();signal.throwIfAborted();
      return JSON.stringify({success:true,people:results,entityLinks:results.map(({id:_id,...link})=>link),truncated:rows.length>limit});
    },
  };
}
