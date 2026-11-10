jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$queryRaw:jest.fn()}}));
jest.mock('../src/modules/help/help.service',()=>({HelpError:class extends Error{},helpActor:jest.fn(),requireHelpTicket:jest.fn(),helpTransaction:jest.fn(),publishHelpEvent:jest.fn()}));
jest.mock('../src/services/pushService',()=>({sendPushToUser:jest.fn()}));
import {helpNotificationSuppressed} from '../src/modules/help/help.delivery';
import {helpAssistantConfiguration,startHelpAssistantWorker} from '../src/modules/help/help.assistant';
const original={...process.env};
afterEach(()=>{process.env={...original};});
test('foreground without this event ACK never suppresses a push',()=>{
 expect(helpNotificationSuppressed('token-a',[],[{sessionId:'open',deviceId:'token-a'}])).toBe(false);
});
test('legacy or banner ACK suppresses only the mapped device, not other phones',()=>{
 const sessions=[{sessionId:'open',deviceId:'token-a'},{sessionId:'other',deviceId:'token-b'}];
 expect(helpNotificationSuppressed('token-a',[{sessionId:'open'}],sessions)).toBe(true);
 expect(helpNotificationSuppressed('token-b',[{sessionId:'open'}],sessions)).toBe(false);
 expect(helpNotificationSuppressed('token-a',[{sessionId:'missing'}],sessions)).toBe(false);
});
test('fresh chat ACK suppresses other phones even when the viewing web session has no push token',()=>{
 const now=1000,sessions=[{sessionId:'web',deviceId:'browser-installation',active:true,ticketId:7,expiresAt:new Date(now+45000)}];
 expect(helpNotificationSuppressed('phone',[{sessionId:'web',kind:'chat'}],sessions,7,now)).toBe(true);
 expect(helpNotificationSuppressed('tablet',[{sessionId:'web',kind:'chat'}],sessions,7,now)).toBe(true);
 expect(helpNotificationSuppressed('phone',[{sessionId:'web',kind:'banner'}],sessions,7,now)).toBe(false);
 expect(helpNotificationSuppressed('phone',[],sessions,7,now)).toBe(false);
});
test.each(['expired','inactive','other-ticket','missing-session','missing-ticket-context'])('a %s viewing session cannot suppress another device',reason=>{
 const now=1000,session={sessionId:'web',deviceId:'browser-installation',active:reason!=='inactive',ticketId:reason==='other-ticket'?8:7,expiresAt:new Date(reason==='expired'?now:now+45000)};
 expect(helpNotificationSuppressed('phone',[{sessionId:'web',kind:'chat'}],reason==='missing-session'?[]:[session],reason==='missing-ticket-context'?undefined:7,now)).toBe(false);
});
test('server simulator requires explicit opt-in and cannot activate in production',()=>{
 process.env.HELP_AI_PROVIDER='simulator';process.env.HELP_AI_ENABLED='false';
 expect(helpAssistantConfiguration().enabled).toBe(false);
 process.env.HELP_AI_ENABLED='true';process.env.NODE_ENV='test';process.env.HELP_AI_SIMULATOR_DURATION_MS='300000';
 expect(helpAssistantConfiguration()).toMatchObject({enabled:true,durationMs:300000});
 process.env.NODE_ENV='production';expect(helpAssistantConfiguration().enabled).toBe(false);
});

test('graceful worker stop drains the current claim and never starts another one',async()=>{
 process.env.HELP_AI_ENABLED='true';process.env.HELP_AI_PROVIDER='simulator';process.env.NODE_ENV='test';
 jest.useFakeTimers();
 const client=require('../src/prisma/client').default;
 let finish!:(rows:unknown[])=>void;
 client.$queryRaw.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 try{
  const stop=startHelpAssistantWorker();let drained=false;
  const stopping=stop().then(()=>{drained=true;});
  await Promise.resolve();expect(drained).toBe(false);
  finish([]);await stopping;expect(drained).toBe(true);
  jest.advanceTimersByTime(2000);expect(client.$queryRaw).toHaveBeenCalledTimes(1);
 }finally{jest.useRealTimers();}
});
