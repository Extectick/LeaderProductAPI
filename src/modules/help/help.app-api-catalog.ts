import {helpAppApiCatalogue} from './help.app-api-catalog.generated';

export type AppApiMethod='GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS';
export type AppApiOperation={id:string;method:AppApiMethod;path:string;summary:string;tags:readonly string[];
  parameters:readonly {name:string;in:string;required?:boolean;schema?:unknown;[key:string]:unknown}[];
  requestBody?:unknown;schemaSource:'openapi'|'route-validator-hints'|'none';transport:'json'|'binary'|'multipart'|'stream'|'credential'|'integration'|'internal';effect:'read'|'write';deprecated?:boolean};
const operations:readonly AppApiOperation[]=helpAppApiCatalogue.operations as unknown as readonly AppApiOperation[];
const byId=new Map(operations.map(operation=>[operation.id,operation]));
export const appApiCatalogueMetadata=helpAppApiCatalogue.meta;
export function getAppApiOperation(id:string):AppApiOperation|undefined{return byId.get(id);}
const synonyms:Record<string,string[]>={
  'чат':['help','tickets'],'чаты':['help','tickets'],'чатов':['help','tickets'],'обращение':['help','tickets'],'обращения':['help','tickets'],
  'профиль':['users','profile'],'профиля':['users','profile'],'пользователь':['users'],'пользователи':['users'],'сотрудник':['users'],
  'отдел':['departments'],'отделы':['departments'],'роль':['roles'],'роли':['roles'],
  'товар':['products','catalog'],'товары':['products','catalog'],'остатки':['stock','balances'],'заказ':['orders'],'заказы':['orders'],
};
export function searchAppApiOperations(input:{query?:string;method?:AppApiMethod;offset?:number;limit?:number}={}){
  const query=(input.query||'').trim().slice(0,200).toLowerCase(),offset=input.offset??0,limit=input.limit??10;
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>20)throw new TypeError('APP_API_CATALOGUE_ARGUMENTS');
  const tokens=query.split(/\s+/u).filter(Boolean);
  const ranked=operations.filter(operation=>!input.method||operation.method===input.method).map(operation=>{
    const text=[operation.path,operation.summary,...operation.tags].join(' ').toLowerCase();
    const score=tokens.reduce((sum,token)=>sum+(text.includes(token)?5:0)+(synonyms[token]||[]).reduce((n,word)=>n+(text.includes(word)?1:0),0),0);
    return {operation,score};
  }).filter(row=>!tokens.length||row.score>0).sort((a,b)=>b.score-a.score||a.operation.id.localeCompare(b.operation.id));
  return {operations:ranked.slice(offset,offset+limit).map(row=>row.operation),total:ranked.length,offset,hasMore:offset+limit<ranked.length};
}
