const mockClient={transport:'help-only'};
const mockExpo=jest.fn((..._args:unknown[])=>mockClient),mockProxy=jest.fn((..._args:unknown[])=>({dispatcher:'restricted'})),mockSend=jest.fn(async(..._args:unknown[])=>({ok:true}));
jest.mock('expo-server-sdk',()=>({Expo:function(...args:unknown[]){return mockExpo(...args);}}));
jest.mock('undici',()=>({ProxyAgent:function(...args:unknown[]){return mockProxy(...args);}}));
jest.mock('../src/services/pushService',()=>({sendPushToUser:(...args:unknown[])=>mockSend(...args)}));
const original=process.env.HELP_EXPO_PROXY_URL;
beforeEach(()=>{jest.resetModules();jest.clearAllMocks();delete process.env.HELP_EXPO_PROXY_URL;});
afterAll(()=>{if(original===undefined)delete process.env.HELP_EXPO_PROXY_URL;else process.env.HELP_EXPO_PROXY_URL=original;});
test('without a scoped route Help preserves the existing transport and token restriction',async()=>{
 const {sendHelpPushToUser}=require('../src/modules/help/help.push');
 await sendHelpPushToUser(7,{title:'Synthetic'},{includeTokens:['Expo-token-test']});
 expect(mockSend).toHaveBeenCalledWith(7,{title:'Synthetic'},{includeTokens:['Expo-token-test']});
 expect(mockExpo).not.toHaveBeenCalled();expect(mockProxy).not.toHaveBeenCalled();
});
test('the restricted dispatcher is created once and supplied only through Help calls',async()=>{
 process.env.HELP_EXPO_PROXY_URL='http://help-expo-vpn-proxy:10810';
 const {sendHelpPushToUser}=require('../src/modules/help/help.push');
 await sendHelpPushToUser(7,{title:'Synthetic'},{includeTokens:['Expo-token-test']});
 await sendHelpPushToUser(8,{title:'Synthetic'},{includeTokens:['Expo-token-other']});
 expect(mockExpo).toHaveBeenCalledTimes(1);expect(mockProxy).toHaveBeenCalledTimes(1);
 expect(mockExpo).toHaveBeenCalledWith(expect.objectContaining({httpAgent:{dispatcher:'restricted'}}));
 expect(mockSend).toHaveBeenCalledWith(8,{title:'Synthetic'},{includeTokens:['Expo-token-other'],client:mockClient});
});
test.each(['https://proxy.test','http://user:password@proxy.test','http://proxy.test/anything','http://proxy.test/?key=value'])('invalid scoped route fails closed (%s)',async value=>{
 process.env.HELP_EXPO_PROXY_URL=value;
 const {sendHelpPushToUser}=require('../src/modules/help/help.push');
 expect(()=>sendHelpPushToUser(7,{},{includeTokens:[]})).toThrow('Invalid Help Expo proxy configuration');
 expect(mockSend).not.toHaveBeenCalled();expect(mockProxy).not.toHaveBeenCalled();
});
