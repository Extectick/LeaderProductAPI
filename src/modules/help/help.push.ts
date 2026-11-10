import {Expo} from 'expo-server-sdk';
import {ProxyAgent} from 'undici';
import {sendPushToUser} from '../../services/pushService';

let proxyUrl:string|undefined,client:Expo|undefined;
/** Only Help uses this restricted Expo route; other push transports keep theirs. */
export function helpPushClient():Expo|undefined {
  const value=process.env.HELP_EXPO_PROXY_URL?.trim();
  if(!value)return undefined;
  if(client&&proxyUrl===value)return client;
  const url=new URL(value);
  if(url.protocol!=='http:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Invalid Help Expo proxy configuration');
  proxyUrl=value;
  client=new Expo({httpAgent:new ProxyAgent(value),accessToken:process.env.EXPO_ACCESS_TOKEN||undefined});
  return client;
}
export function sendHelpPushToUser(userId:number,payload:Parameters<typeof sendPushToUser>[1],options:{includeTokens:string[]}) {
  const client=helpPushClient();
  return sendPushToUser(userId,payload,{...options,...(client?{client}:{})});
}
