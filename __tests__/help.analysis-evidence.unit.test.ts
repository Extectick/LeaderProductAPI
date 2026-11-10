jest.mock('../src/modules/help/help.service',()=>({helpTransaction:jest.fn(),helpActor:jest.fn()}));
jest.mock('../src/modules/help/help.knowledge',()=>({validateHelpKnowledgeSources:jest.fn()}));
jest.mock('../src/modules/onec-personal/service',()=>({validateOnecProofs:jest.fn()}));
jest.mock('../src/modules/help/help.context-store',()=>({helpContextFingerprint:jest.fn()}));
import {helpAnalysisEvidenceCollector,createHelpAnalysisEvidenceSink,HelpAnalysisEvidenceError} from '../src/modules/help/help.analysis-evidence';
import {helpTransaction,helpActor} from '../src/modules/help/help.service';
import {validateHelpKnowledgeSources} from '../src/modules/help/help.knowledge';
import {validateOnecProofs} from '../src/modules/onec-personal/service';
import {helpContextFingerprint} from '../src/modules/help/help.context-store';
const savedEnv={...process.env};
const query={baseKey:'qa',arguments:{query:'ВЫБРАТЬ Наименование ИЗ Справочник.Номенклатура',parametersJson:'{"Склад":"Северный"}'}};
test('retains actual query, parameter values and full nested result independently of business row count',()=>{
 const collector=helpAnalysisEvidenceCollector();
 const data={rowCount:2,truncated:false,data:[{Наименование:'Товар',Цена:123},{Наименование:'Товар 2',Цена:456}]};
 expect(collector.record('onec_execute_query',query,JSON.stringify({baseKey:'qa',tool:'execute_query',data:JSON.stringify(data)}))).toBe(true);
 expect(collector.snapshot()).toMatchObject({version:1,truncated:false,calls:[{index:1,toolName:'onec_execute_query',args:{arguments:{parametersJson:{Склад:'Северный'}}},result:{data},status:'returned',rowCount:2,sourceTruncated:false,contentComplete:true,redacted:false}]});
 const copy=collector.snapshot();copy.calls[0].result=null;expect(collector.snapshot().calls[0].result).not.toBeNull();
});
test('suppresses credential keys and explicit credential strings, URLs and encoded credentials before persistence',()=>{
 const collector=helpAnalysisEvidenceCollector();
 const secret='PRIVATE_CREDENTIAL';
 collector.record('onec_get_object',{password:secret,auth:{value:secret},headers:{v:secret},keyring:secret,apiKey:secret,binding:secret,login:secret,arguments:{parametersJson:JSON.stringify({Password:secret})}},JSON.stringify({data:{rows:[{Товар:'Хлеб',Password:secret,Логин:secret,log:'"password":"'+secret+'"',text:'Bearer abcdefghijklmnop',url:'https://private/'+secret,link:'leaderproduct://private/'+secret}],connectionString:secret}}));
 const result=collector.snapshot();expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
 expect(JSON.stringify(result)).toContain('Хлеб');expect(result.calls[0]).toMatchObject({redacted:true,contentComplete:false});
});
test('suppresses positional credential columns before persistence while retaining business numbers and table shape',()=>{
 const collector=helpAnalysisEvidenceCollector();
 collector.record('onec_execute_query',query,JSON.stringify({data:{rowCount:2,truncated:false,columns:['Товар','Пароль','Количество','Цена'],rows:[['Хлеб','BARE_CREDENTIAL_A',0,12.5],['Молоко','BARE_CREDENTIAL_B',-2,0]]}}));
 const snapshot=collector.snapshot(),call=snapshot.calls[0];
 expect(JSON.stringify(snapshot)).not.toContain('BARE_CREDENTIAL');
 expect(call.result).toMatchObject({data:{rowCount:2,columns:['Товар','Пароль','Количество','Цена'],rows:[['Хлеб','[REDACTED]',0,12.5],['Молоко','[REDACTED]',-2,0]]}});
 expect(call).toMatchObject({rowCount:2,sourceTruncated:false,status:'returned',redacted:true,contentComplete:false});
});
test('suppresses login/password key-value cells even when generic headers do not identify sensitive columns',()=>{
 const collector=helpAnalysisEvidenceCollector();
 collector.record('onec_get_object',{},JSON.stringify({data:{rowCount:4,truncated:false,headers:['Параметр','Значение'],rows:[['Логин','BARE_ACCOUNT'],['Пароль','BARE_CREDENTIAL'],['Остаток',0],['Сумма',-15.5]]}}));
 const snapshot=collector.snapshot();expect(JSON.stringify(snapshot)).not.toContain('BARE_');
 expect(snapshot.calls[0].result).toMatchObject({data:{headers:['Параметр','Значение'],rows:[['Логин','[REDACTED]'],['Пароль','[REDACTED]'],['Остаток',0],['Сумма',-15.5]]}});
 expect(snapshot.calls[0]).toMatchObject({redacted:true,contentComplete:false,rowCount:4});
});
test.each([
 {columns:[{name:'Товар'},{name:'Password'},{name:'Количество'}],rows:[['Хлеб','BARE_CREDENTIAL',0]]},
 {fields:[{Name:'Товар'},{Caption:'Имя пользователя'},{Name:'Количество'}],values:[['Хлеб','BARE_CREDENTIAL',0]]},
 {headers:[{field:'Товар'},{title:'pass\u200bword'},{field:'Количество'}],records:[['Хлеб','BARE_CREDENTIAL',0]]},
 {columns:['Товар','access_token','Количество'],data:[['Хлеб','BARE_CREDENTIAL',0]]},
])('credential column descriptors and supported row wrappers are suppressed: %j',table=>{
 const collector=helpAnalysisEvidenceCollector();collector.record('onec_execute_query',{},JSON.stringify({data:{rowCount:1,truncated:false,...table}}));
 const result=collector.snapshot();expect(JSON.stringify(result)).not.toContain('BARE_CREDENTIAL');expect(JSON.stringify(result)).toContain('Хлеб');expect(JSON.stringify(result)).toContain(',0]');expect(result.calls[0]).toMatchObject({rowCount:1,redacted:true,contentComplete:false});
});
test('recursively decoded result strings and normalized credential keys cannot hide bare secrets',()=>{
 const collector=helpAnalysisEvidenceCollector();
 collector.record('onec_get_object',{'pass\u0000word':'BARE_ARGUMENT'},JSON.stringify({data:{rowCount:1,truncated:false,payload:JSON.stringify({headers:['Параметр','Значение'],rows:[['API key','BARE_CREDENTIAL'],['Остаток',0]]})}}));
 const result=collector.snapshot();expect(JSON.stringify(result)).not.toContain('BARE_');expect(result.calls[0].result).toMatchObject({data:{payload:{headers:['Параметр','Значение'],rows:[['API key','[REDACTED]'],['Остаток',0]]}}});
});
test('business column descriptors and zero/negative values are retained without a false credential redaction',()=>{
 const collector=helpAnalysisEvidenceCollector();const data={rowCount:2,truncated:false,headers:[{name:'Товар'},{name:'Количество'},{name:'Цена'}],rows:[['Хлеб',0,12.5],['Молоко',-2,0]]};
 collector.record('onec_execute_query',query,JSON.stringify({data}));expect(collector.snapshot().calls[0]).toMatchObject({result:{data},rowCount:2,redacted:false,contentComplete:true});
});
test('upstream incomplete data stays distinct from local truncation and missing results stay unknown',()=>{
 const collector=helpAnalysisEvidenceCollector();
 collector.record('onec_execute_query',query,JSON.stringify({data:JSON.stringify({rowCount:1000,truncated:true,data:[1]})}));
 collector.record('onec_get_object',{},undefined,'ONEC_UNAVAILABLE');
 expect(collector.snapshot()).toMatchObject({truncated:false,calls:[{sourceTruncated:true,contentComplete:false,rowCount:1000},{index:2,status:'failed',result:null,errorCode:'ONEC_UNAVAILABLE',rowCount:null,sourceTruncated:null}]});
 expect(collector.record('app_api_call',{password:'x'},'business')).toBe(false);
 expect(helpAnalysisEvidenceCollector().snapshot().calls).toEqual([]);
});
test('bounds bytes, depth, strings and calls and records loss explicitly',()=>{
 const collector=helpAnalysisEvidenceCollector();
 for(let index=0;index<14;index++)collector.record('onec_execute_query',query,JSON.stringify({rows:Array.from({length:20},()=>({name:'Ж'.repeat(160000)}))}));
 const value=collector.snapshot();expect(value.calls).toHaveLength(14);expect(value.truncated).toBe(true);
 expect(value.calls.every(call=>!call.contentComplete)).toBe(true);expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(512*1024);
});
let db:any,job:any,ticket:any,controller:AbortController;
const guards={validationSources:[],onecProofs:[{baseKey:'qa',revision:1,binding:'PRIVATE_PROOF'}],validateAppAccess:jest.fn(),contextRevision:{throughSequence:4,fingerprint:'hash'}};
const evidence=()=>{const collector=helpAnalysisEvidenceCollector();collector.record('onec_execute_query',query,'{"data":{"rowCount":1,"data":[{"Товар":"Хлеб"}]}}');return collector.snapshot()};
beforeEach(()=>{
 jest.clearAllMocks();process.env={...savedEnv,HELP_AI_PROVIDER:'openai'};controller=new AbortController();
 job={id:'job',ticketId:3,messageId:12,ownerId:7,provider:'openai',status:'RUNNING',leaseToken:'lease',leaseUntil:new Date(Date.now()+90000),context:{inputs:[{sequence:4,text:'question'}],helpContextSummary:{private:'memory'},clientContext:{version:1}}};
 ticket={id:3,ownerId:7,status:'OPEN',itRequested:false,members:[]};
 db={helpAssistantJob:{findUnique:jest.fn(async()=>job),updateMany:jest.fn(async()=>({count:1}))},helpTicket:{findUnique:jest.fn(async()=>ticket)},$executeRaw:jest.fn()};
 (helpTransaction as jest.Mock).mockImplementation((_id,fn)=>fn(db));(helpContextFingerprint as jest.Mock).mockResolvedValue({fingerprint:'hash'});
 (helpActor as jest.Mock).mockResolvedValue({userId:7});(validateHelpKnowledgeSources as jest.Mock).mockResolvedValue(undefined);(validateOnecProofs as jest.Mock).mockResolvedValue(undefined);guards.validateAppAccess.mockResolvedValue(undefined);
});
afterEach(()=>{process.env=savedEnv});
const sink=()=>createHelpAnalysisEvidenceSink({id:'job',ticketId:3,messageId:12,leaseToken:'lease'},controller.signal);
test('writes only the private context, retaining latest inputs/summary/clientContext with a live-lease CAS',async()=>{
 await sink()(evidence(),guards);
 expect(validateHelpKnowledgeSources).toHaveBeenCalledWith(db,[],7);expect(validateOnecProofs).toHaveBeenCalledWith(7,guards.onecProofs,db);expect(guards.validateAppAccess).toHaveBeenCalledWith(db);
 expect(db.helpAssistantJob.updateMany).toHaveBeenCalledWith({where:{id:'job',ticketId:3,messageId:12,ownerId:7,provider:'openai',status:'RUNNING',leaseToken:'lease',leaseUntil:{gt:expect.any(Date)}},data:{context:{...job.context,helpAnalysisEvidence:evidence()}}});
 expect(db.helpMessage).toBeUndefined();
});
test('legacy array inputs are preserved when adding evidence',async()=>{
 job.context=[{text:'original'}];await sink()(evidence(),guards);
 expect(db.helpAssistantJob.updateMany.mock.calls[0][0].data.context.inputs).toEqual(job.context);
});
test.each(['lease','expired','provider','job-provider','message','owner','closed','IT','IT-member','aborted','sources','app','personal','history'])('a %s revocation blocks private persistence',async(reason)=>{
 if(reason==='lease')job.leaseToken='other';if(reason==='expired')job.leaseUntil=new Date(0);if(reason==='provider')process.env.HELP_AI_PROVIDER='other';if(reason==='job-provider')job.provider='t3';if(reason==='message')job.messageId=99;
 if(reason==='owner')ticket.ownerId=99;if(reason==='closed')ticket.status='CLOSED';if(reason==='IT')ticket.itRequested=true;if(reason==='IT-member')ticket.members=[{role:'IT'}];if(reason==='aborted')controller.abort();
 if(reason==='sources')(validateHelpKnowledgeSources as jest.Mock).mockRejectedValueOnce(Error('REVOKED'));if(reason==='app')guards.validateAppAccess.mockRejectedValueOnce(Error('REVOKED'));if(reason==='personal')(validateOnecProofs as jest.Mock).mockRejectedValueOnce(Error('REVOKED'));if(reason==='history')(helpContextFingerprint as jest.Mock).mockResolvedValueOnce({fingerprint:'changed'});
 await expect(sink()(evidence(),guards)).rejects.toThrow();expect(db.helpAssistantJob.updateMany).not.toHaveBeenCalled();
});
test('a lost final lease CAS rejects the write',async()=>{
 db.helpAssistantJob.updateMany.mockResolvedValueOnce({count:0});await expect(sink()(evidence(),guards)).rejects.toBeInstanceOf(HelpAnalysisEvidenceError);
});

test('long investigation keeps evidence after the old twelve-call boundary',()=>{const c=helpAnalysisEvidenceCollector();for(let i=0;i<98;i++)c.record('onec_execute_query',{},JSON.stringify({data:{success:true,rowCount:0,truncated:false,data:[]}}));expect(c.snapshot().calls).toHaveLength(96);expect(c.snapshot().truncated).toBe(true);});
