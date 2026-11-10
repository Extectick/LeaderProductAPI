import {personalMailTools,personalMailInstructions} from '../personal-mail/help-tools';
import type {Prisma} from '@prisma/client';
import type {HelpEntityLinks} from './help.entity-links';
import {helpGatewayTools,helpGatewayInstructions} from './help.gateway-tools';
import {helpChatTools,helpChatInstructions} from './help.app-chats';
import {helpAppApiTools,helpAppApiInstructions} from './help.app-api';
export const helpApplicationInstructions=helpChatInstructions+'\n'+helpAppApiInstructions+'\n'+helpGatewayInstructions+'\n'+personalMailInstructions;
export type HelpApplicationTools={definitions:Array<{type:string;name:string;[key:string]:unknown}>;hasEvidence:()=>boolean;hasMutations?:()=>boolean;validate:(db?:Prisma.TransactionClient)=>Promise<void>;call:(name:string,args:unknown,signal:AbortSignal)=>Promise<string>};
export function helpApplicationTools(userId:number,requestKey:string,links:HelpEntityLinks):HelpApplicationTools{
 const mail=personalMailTools(userId,Number(requestKey.split(':')[0]),requestKey);
 const gateways=helpGatewayTools(userId),chats=helpChatTools(userId),api=helpAppApiTools(userId,requestKey,{chats,entities:links});
 links.bindAppLinks({allows:url=>chats.links.allows(url)||mail.links.allows(url)});
 const names=new Set(chats.definitions.map(tool=>tool.name)),gatewayNames=new Set(gateways.definitions.map(tool=>tool.name));
  return {definitions:[...chats.definitions,...api.definitions,...gateways.definitions,...mail.definitions],hasEvidence:()=>chats.hasEvidence()||api.hasEvidence()||gateways.hasEvidence()||mail.hasEvidence(),hasMutations:api.hasMutations,
  async validate(db?:Prisma.TransactionClient){await api.validate(db);await chats.validate(db);await gateways.validate(db);},
  call:(name:string,args:unknown,signal:AbortSignal)=>name.startsWith('mail_')?mail.call(name,args,signal):gatewayNames.has(name)?gateways.call(name,args,signal):names.has(name)?chats.call(name,args,signal):api.call(name,args,signal),
 };
}
