import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
import {helpAnalysisEvidenceCollector,HelpAnalysisEvidenceError} from '../src/modules/help/help.analysis-evidence';
const savedEnv={...process.env};
beforeEach(()=>{
 process.env={...savedEnv,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};
 delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;
});
afterEach(()=>{process.env=savedEnv});
const args={baseKey:'qa',arguments:{query:'SELECT ref FROM fixture',parametersJson:'{"name":"Хлеб"}'}};
const data={rowCount:1,truncated:false,data:[{Наименование:'PRIVATE_BUSINESS_VALUE',Цена:10}]};
const raw=JSON.stringify({baseKey:'qa',tool:'execute_query',data:JSON.stringify(data)});
const first=()=>Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'onec_execute_query',call_id:'q1',arguments:JSON.stringify(args)}]});
const onec=()=>({bases:[{key:'qa',label:'QA'}],proofs:[],validate:jest.fn(),definitions:[{type:'function',name:'onec_execute_query',parameters:{type:'object'}}],call:jest.fn().mockResolvedValue(raw)});
test('private result is captured before enrichment and remains available after the following model request fails',async()=>{
 const collector=helpAnalysisEvidenceCollector(),snapshots:any[]=[];
 const onToolEvidence=jest.fn(async(name,values,output,errorCode)=>{collector.record(name,values,output,errorCode);snapshots.push(collector.snapshot())});
 const officeTools:any={definitions:[],files:[],rememberData:jest.fn(output=>JSON.stringify({...JSON.parse(output),officeArtifact:'NOT_SOURCE_DATA'}))};
 const progress=jest.fn(),transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(first()).mockRejectedValueOnce(Error('provider disconnected'));
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Покажи товар'}],sources:[],onec:onec(),officeTools,progress,onToolEvidence},new AbortController().signal,transport)).rejects.toThrow('HELP_OPENAI_NETWORK');
 expect(onToolEvidence).toHaveBeenCalledWith('onec_execute_query',args,raw);expect(snapshots).toHaveLength(1);
 expect(snapshots[0].calls[0]).toMatchObject({result:{data},contentComplete:true,status:'returned'});
 expect(onToolEvidence.mock.invocationCallOrder[0]).toBeLessThan(officeTools.rememberData.mock.invocationCallOrder[0]);
 expect(JSON.stringify(snapshots)).not.toContain('NOT_SOURCE_DATA');expect(JSON.stringify(progress.mock.calls)).not.toContain('PRIVATE_BUSINESS_VALUE');
 expect(JSON.stringify(transport.mock.calls[0][1]?.body)).not.toContain('onToolEvidence');
});
test('thrown tool failures preserve only the safe code before public failure progress',async()=>{
 const collector=helpAnalysisEvidenceCollector();const onToolEvidence=jest.fn(async(name,values,output,errorCode)=>{collector.record(name,values,output,errorCode)});
 const tools=onec();tools.call.mockRejectedValueOnce(Object.assign(Error('password=PRIVATE_CREDENTIAL'),{code:'ONEC_NETWORK_ERROR'}));
 const progress=jest.fn(),transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(first());
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Покажи товар'}],sources:[],onec:tools,progress,onToolEvidence},new AbortController().signal,transport)).rejects.toThrow();
 expect(onToolEvidence).toHaveBeenCalledWith('onec_execute_query',args,undefined,'ONEC_NETWORK_ERROR');
 expect(collector.snapshot().calls[0]).toMatchObject({status:'failed',result:null,errorCode:'ONEC_NETWORK_ERROR'});
 expect(JSON.stringify(collector.snapshot())).not.toContain('PRIVATE_CREDENTIAL');
 const failed=progress.mock.calls.findIndex(([item])=>item.activity?.status==='failed');expect(failed).toBeGreaterThanOrEqual(0);
 expect(onToolEvidence.mock.invocationCallOrder[0]).toBeLessThan(progress.mock.invocationCallOrder[failed]);
});
test('a rejected private persistence fence aborts generation without being converted to a network retry',async()=>{
 const onToolEvidence=jest.fn(async()=>{throw new HelpAnalysisEvidenceError()});
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(first());
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Покажи товар'}],sources:[],onec:onec(),onToolEvidence},new AbortController().signal,transport)).rejects.toBeInstanceOf(HelpAnalysisEvidenceError);
 expect(transport).toHaveBeenCalledTimes(1);
});
