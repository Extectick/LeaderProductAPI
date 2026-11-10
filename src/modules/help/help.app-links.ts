/** Private navigation targets are checked again by their normal destination API. */
export type HelpAppChatLink={kind:'help-chat';ticketId:number;label:string;url:string};
const idPattern=/^[1-9]\d{0,9}$/;
export function helpChatLink(ticketId:number):string {
  if(!Number.isSafeInteger(ticketId)||ticketId<1||ticketId>2147483647)throw Error('APP_HELP_CHAT_ARGUMENTS');
  return 'leaderproduct://services/help?ticketId='+ticketId;
}
export function parseHelpChatLink(value:unknown):number|null {
  if(typeof value!=='string'||value.length>100)return null;
  const match=/^leaderproduct:\/\/services\/help\?ticketId=([^&#]+)$/.exec(value);
  if(!match||!idPattern.test(match[1]))return null;
  const id=Number(match[1]);return Number.isSafeInteger(id)&&id<=2147483647? id:null;
}
/** Never promoted from old dialogue or guessed model text: only successful reads register. */
export function helpAppLinks(){
  const chats=new Map<string,HelpAppChatLink>();
  function register(ticketId:number,label:string):HelpAppChatLink {
    const url=helpChatLink(ticketId),link:HelpAppChatLink={kind:'help-chat',ticketId,label:label.slice(0,500),url};
    chats.set(url,link);return link;
  }
  function allows(url:string):boolean{return parseHelpChatLink(url)!==null&&chats.has(url);}
  return {register,allows};
}
export type HelpAppLinks=ReturnType<typeof helpAppLinks>;
