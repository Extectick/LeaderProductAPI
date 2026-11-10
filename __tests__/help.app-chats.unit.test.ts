jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpTicket:{findUnique:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>{
 class HelpError extends Error{constructor(public status:number,public code:string,message:string){super(message)}}
 return {HelpError,helpActor:jest.fn(),requireHelpTicket:jest.fn(),listHelpTickets:jest.fn()};
});
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket,listHelpTickets,HelpError} from '../src/modules/help/help.service';
import {helpChatTools} from '../src/modules/help/help.app-chats';
import {helpAppLinks,helpChatLink,parseHelpChatLink} from '../src/modules/help/help.app-links';
const actor={userId:1,canManage:true},ticket={id:52,title:'Пример',status:'OPEN'};
const signal=()=>new AbortController().signal;
beforeEach(()=>{jest.clearAllMocks();(helpActor as jest.Mock).mockResolvedValue(actor);(requireHelpTicket as jest.Mock).mockResolvedValue(ticket);(listHelpTickets as jest.Mock).mockResolvedValue({tickets:[ticket],nextCursor:null})});
test('numbered chat lookup returns a real canonical link with only minimal fields and current actor ACL',async()=>{
 const tools=helpChatTools(1);const value=JSON.parse(await tools.call('app_get_help_chat',{ticketId:52},signal()));
 expect(value).toEqual({success:true,chat:{id:52,number:52,title:'Пример',status:'OPEN',url:'leaderproduct://services/help?ticketId=52'}});
 expect(helpActor).toHaveBeenCalledWith(1);expect(requireHelpTicket).toHaveBeenCalledWith(prisma,52,actor);
 expect(tools.links.allows(value.chat.url)).toBe(true);expect(tools.hasEvidence()).toBe(true);
 expect(JSON.stringify(value)).not.toMatch(/messages|members|ownerId|password|email/);
});
test('invalid, identity-overriding and preaborted requests never read the database',async()=>{
 const tools=helpChatTools(1);
 for(const args of [{ticketId:0},{ticketId:'52'},{ticketId:52,userId:2},{ticketId:52,url:'https://remote'}])expect(JSON.parse(await tools.call('app_get_help_chat',args,signal())).error).toBe('APP_HELP_CHAT_ARGUMENTS');
 await expect(tools.call('app_get_help_chat',{ticketId:52},AbortSignal.abort())).rejects.toThrow();
 expect(helpActor).not.toHaveBeenCalled();expect(requireHelpTicket).not.toHaveBeenCalled();
});
test('missing and inaccessible chat never register a link or disclose existence',async()=>{
 (requireHelpTicket as jest.Mock).mockRejectedValue(new HelpError(404,'HELP_NOT_FOUND','Secret ticket name'));
 const tools=helpChatTools(1),value=JSON.parse(await tools.call('app_get_help_chat',{ticketId:52},signal()));
 expect(value.error).toBe('APP_HELP_CHAT_NOT_FOUND');expect(JSON.stringify(value)).not.toContain('Secret');expect(tools.links.allows(helpChatLink(52))).toBe(false);expect(tools.hasEvidence()).toBe(false);
});
test('ordinary actor cannot request manager queue; default search stays mine and never exposes dialogue',async()=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:1,canManage:false});
 const tools=helpChatTools(1);
 expect(JSON.parse(await tools.call('app_search_help_chats',{scope:'queue'},signal())).error).toBe('APP_HELP_CHAT_FORBIDDEN');expect(listHelpTickets).not.toHaveBeenCalled();
 (listHelpTickets as jest.Mock).mockResolvedValue({tickets:[{...ticket,lastMessage:{text:'Private dialogue'},members:[{userId:7}]}],nextCursor:null});
 const value=JSON.parse(await tools.call('app_search_help_chats',{query:'#52'},signal()));
 expect(listHelpTickets).toHaveBeenCalledWith({userId:1,canManage:false},'OPEN',false,undefined,'#52');expect(value.chats).toHaveLength(1);expect(JSON.stringify(value)).not.toContain('Private dialogue');
});
test('bounded pages expose a usable cursor instead of silently dropping middle results',async()=>{
 (listHelpTickets as jest.Mock).mockResolvedValue({tickets:[{...ticket,id:52},{...ticket,id:48},{...ticket,id:40}],nextCursor:null});
 const tools=helpChatTools(1),value=JSON.parse(await tools.call('app_search_help_chats',{scope:'queue',status:'CLOSED',limit:2,cursor:60},signal()));
 expect(value).toMatchObject({truncated:true,nextCursor:48});expect(value.chats.map((row:any)=>row.id)).toEqual([52,48]);
 expect(listHelpTickets).toHaveBeenCalledWith(actor,'CLOSED',true,60,undefined);
 expect(tools.links.allows(helpChatLink(40))).toBe(false);
});
test('empty visible search is evidence and still checks current actor',async()=>{
 (listHelpTickets as jest.Mock).mockResolvedValue({tickets:[],nextCursor:null});const tools=helpChatTools(1);
 expect(JSON.parse(await tools.call('app_search_help_chats',{query:'Нет'},signal()))).toEqual({success:true,chats:[],nextCursor:null,truncated:false});expect(tools.hasEvidence()).toBe(true);expect(helpActor).toHaveBeenCalledTimes(2);
});
test('final publication uses its supplied transaction for exact ticket membership/deletion check',async()=>{
 const tools=helpChatTools(1);await tools.call('app_get_help_chat',{ticketId:52},signal());
 const db={helpTicket:{findUnique:jest.fn()}};await tools.validate(db as any);expect(requireHelpTicket).toHaveBeenLastCalledWith(db,52,actor);
 (helpActor as jest.Mock).mockResolvedValue({userId:1,canManage:false});(requireHelpTicket as jest.Mock).mockRejectedValue(new HelpError(404,'HELP_NOT_FOUND','revoked'));
 await expect(tools.validate(db as any)).rejects.toThrow('revoked');expect(requireHelpTicket).toHaveBeenLastCalledWith(db,52,{userId:1,canManage:false});
});
test('revocation between read and publication prevents returning and registering a prepared link',async()=>{
 (helpActor as jest.Mock).mockResolvedValueOnce(actor).mockRejectedValueOnce(new HelpError(403,'HELP_FORBIDDEN','revoked'));
 const tools=helpChatTools(1),value=JSON.parse(await tools.call('app_get_help_chat',{ticketId:52},signal()));
 expect(value.error).toBe('APP_HELP_CHAT_FORBIDDEN');expect(tools.links.allows(helpChatLink(52))).toBe(false);
});
test('chat links are exact canonical private navigation, without fragments, credentials or other query params',()=>{
 const links=helpAppLinks();expect(parseHelpChatLink(helpChatLink(52))).toBe(52);expect(links.allows(helpChatLink(52))).toBe(false);links.register(52,'Example');expect(links.allows(helpChatLink(52))).toBe(true);
 for(const url of ['https://example.com/52','leaderproduct://services/help?ticketId=052','leaderproduct://services/help?ticketId=52&userId=1','leaderproduct://services/help?ticketId=52#x','leaderproduct://services/help?ticketId=2147483648','leaderproduct://services/help?ticketId=%35%32']){expect(parseHelpChatLink(url)).toBeNull();expect(links.allows(url)).toBe(false)}
});

test('revoking queue access also blocks an empty privileged search',async()=>{
 (listHelpTickets as jest.Mock).mockResolvedValue({tickets:[],nextCursor:null});
 const tools=helpChatTools(1);await tools.call('app_search_help_chats',{scope:'queue'},signal());
 (helpActor as jest.Mock).mockResolvedValue({userId:1,canManage:false});
 await expect(tools.validate()).rejects.toThrow('Нет доступа к очереди');
});
