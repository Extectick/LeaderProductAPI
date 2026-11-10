import {requestOpenAIAnswer,type OpenAIContext} from '../src/modules/help/help.openai';
import {helpAnswerRepairInstruction} from '../src/modules/help/help.answer-repair';
const env={...process.env};
const input:OpenAIContext={messages:[{role:'user',text:'Проверь инструкцию'}],sources:[{documentId:'d',versionId:'v',revision:1,title:'Инструкция',path:'Company',sourceUrl:'/knowledge/d',excerpt:'Проверьте соединение.'}]};
const answer={decision:'answer',message:'Проверьте соединение.',source_ids:['S1'],suggestions:[]};
const output=(text:string)=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const envelope=(items:unknown[])=>Response.json({id:'fixture',status:'completed',output:items});
const reply=(value:unknown)=>envelope(output(JSON.stringify(value)));
beforeEach(()=>{process.env={...env,KNOWLEDGE_ENABLED:'true',HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture-only'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;});
afterEach(()=>{process.env=env;jest.restoreAllMocks();});
test.each(['citations','answer_json','answer_schema'])('one %s correction reuses evidence with tools explicitly disabled',async kind=>{
 const bad=kind==='answer_json'?envelope(output('{bad')):reply(kind==='citations'?{...answer,source_ids:['S9']}:{...answer,decision:'invalid'});
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(bad).mockResolvedValueOnce(reply(answer));
 const result=await requestOpenAIAnswer(input,new AbortController().signal,fetcher);
 expect(result.text).toBe(answer.message);expect(fetcher).toHaveBeenCalledTimes(2);
 const body=JSON.parse(String(fetcher.mock.calls[1][1]?.body));
 expect(body).toMatchObject({tools:[],tool_choice:'none',parallel_tool_calls:false,store:false});
 expect(body.input).toEqual(expect.arrayContaining(output(kind==='answer_json'?'{bad':JSON.stringify(kind==='citations'?{...answer,source_ids:['S9']}:{...answer,decision:'invalid'}))));
 expect(body.input[body.input.length-1]).toMatchObject({role:'developer',content:expect.stringContaining('единственная попытка')});
});
test('a failed correction is terminal and never requests a third response',async()=>{
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>reply({...answer,source_ids:['S9']}));
 await expect(requestOpenAIAnswer(input,new AbortController().signal,fetcher)).rejects.toMatchObject({code:'HELP_OPENAI_INVALID_CITATIONS',retryable:false});
 expect(fetcher).toHaveBeenCalledTimes(2);
});
test('a tool call in the correction is refused before execution',async()=>{
 const onec={bases:[],definitions:[],proofs:[],validate:jest.fn(),call:jest.fn()};
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(reply({...answer,source_ids:['S9']})).mockResolvedValueOnce(envelope([{type:'function_call',name:'onec_execute_query',call_id:'bad',arguments:'{}'}]));
 await expect(requestOpenAIAnswer({...input,onec},new AbortController().signal,fetcher)).rejects.toMatchObject({code:'HELP_OPENAI_INVALID_CITATIONS',retryable:false});
 expect(onec.call).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2);
});
test('fresh authorization prevents a second disclosure after revocation',async()=>{
 let enabled=true;
 const requesterContext={value:{},validate:jest.fn(async()=>{if(!enabled)throw Object.assign(Error('denied'),{code:'HELP_CONTEXT_FORBIDDEN',status:403});})} as any;
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementationOnce(async()=>{enabled=false;return reply({...answer,source_ids:['S9']});});
 await expect(requestOpenAIAnswer({...input,requesterContext},new AbortController().signal,fetcher)).rejects.toBeDefined();
 expect(fetcher).toHaveBeenCalledTimes(1);
});
test('successful correction preserves a mutation receipt and executes the write only once',async()=>{
 let mutated=false;
 const appTools={definitions:[{name:'app_api_call'}],validate:jest.fn(),hasEvidence:()=>mutated,hasMutations:()=>mutated,
  call:jest.fn(async()=>{mutated=true;return JSON.stringify({success:true,status:200,operationId:'POST /help/tickets/{id}/close'});})} as any;
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(envelope([{type:'function_call',name:'app_api_call',call_id:'c',arguments:JSON.stringify({operationId:'POST /help/tickets/{id}/close',path:{id:1}})}]))
  .mockResolvedValueOnce(reply({...answer,source_ids:['S9']})).mockResolvedValueOnce(reply(answer));
 await requestOpenAIAnswer({...input,appTools},new AbortController().signal,fetcher);
 expect(appTools.call).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(3);
 const body=JSON.parse(String(fetcher.mock.calls[2][1]?.body));
 expect(body.tool_choice).toBe('none');expect(body.input.some((i:any)=>i.type==='function_call_output'&&JSON.parse(i.output).success)).toBe(true);
});
test('a network failure after a mutation cannot replay the whole job',async()=>{
 let mutated=false;
 const appTools={definitions:[{name:'app_api_call'}],validate:jest.fn(),hasEvidence:()=>mutated,hasMutations:()=>mutated,call:jest.fn(async()=>{mutated=true;return '{"success":true,"status":200}';})} as any;
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(envelope([{type:'function_call',name:'app_api_call',call_id:'c',arguments:'{}'}])).mockRejectedValueOnce(Error('network'));
 await expect(requestOpenAIAnswer({...input,appTools},new AbortController().signal,fetcher)).rejects.toMatchObject({code:'HELP_OPENAI_ACTION_RESULT_UNAVAILABLE',retryable:false});
 expect(appTools.call).toHaveBeenCalledTimes(1);
});
test('repair instructions whitelist identifiers without interpolating arbitrary data',()=>{
 const text=helpAnswerRepairInstruction('citations',['S1','S99','PRIVATE_DATA'],[1,-1,Infinity]);
 expect(text).toContain('["S1"]');expect(text).toContain('[1]');expect(text).not.toContain('PRIVATE_DATA');expect(text).not.toContain('S99');
});
