import { onecEmployeeContext, hasOnecDataEvidence } from '../src/modules/help/help.onec-agent';
import { requestOpenAIAnswer } from '../src/modules/help/help.openai';
const original={...process.env};
beforeEach(()=>{
 process.env={...original,HELP_AI_ENABLED:'true',KNOWLEDGE_ENABLED:'true',HELP_AI_PROVIDER:'openai',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture-key'};
 delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;delete process.env.HELP_OPENAI_MAX_TOOL_CALLS;
});
afterEach(()=>{process.env=original;});
const data=(rows:unknown[])=>JSON.stringify({data:JSON.stringify({success:true,rowCount:rows.length,data:rows})});
const tool=(name:string,id:string,args:unknown={})=>Response.json({id,status:'completed',output:[{type:'function_call',name,call_id:id,arguments:JSON.stringify(args)}]});
const final=(text='Документ № VERIFIED-1.')=>Response.json({id:'final',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:text,source_ids:[],questions:[]})}]}]});
const tools=()=>({bases:[],definitions:[],proofs:[{baseKey:'fixture',revision:1,binding:'fixture'}],validate:jest.fn().mockResolvedValue(undefined),call:jest.fn()});
const messages=[{role:'user' as const,text:'Покажи последний приходный документ по складу Северный'}];

test('metadata/access proofs and malformed or unsuccessful queries do not prove business data',()=>{
 expect(hasOnecDataEvidence('onec_get_access_rights',data([{Чтение:true}]))).toBe(false);
 expect(hasOnecDataEvidence('onec_list_metadata_objects',data([{name:'Документ'}]))).toBe(false);
 expect(hasOnecDataEvidence('onec_execute_query',data([]))).toBe(true);
 expect(hasOnecDataEvidence('onec_execute_query',JSON.stringify({data:JSON.stringify({success:false,data:[],rowCount:0})}))).toBe(false);
 expect(hasOnecDataEvidence('onec_execute_query',JSON.stringify({data:JSON.stringify({success:true,data:[],rowCount:0,truncated:true})}))).toBe(false);
 expect(hasOnecDataEvidence('onec_find_latest_receipt',JSON.stringify({data:JSON.stringify({status:'warehouse_not_found'})}))).toBe(false);
});

test('confirmed user answers survive verbose later dialogue without promoting assistant guesses',()=>{
 const memory=onecEmployeeContext('Исходная задача',[
  {sequence:1,text:'На каком складе искать?\nОтвет: Склад Северный'},
  ...Array.from({length:35},(_,i)=>({sequence:i+2,text:'Уточнение '+i})),
 ]);
 expect(memory.initialRequest).toBe('Исходная задача');
 expect(memory.statements).toHaveLength(24);
 expect(memory.answers).toEqual([{question:'На каком складе искать?',answer:'Склад Северный'}]);
});

test('a wrong-type empty lookup returns to the agent for metadata and a correct data query',async()=>{
 const onec=tools();
 onec.call.mockResolvedValueOnce(JSON.stringify({data:JSON.stringify({kind:'receipt',period:{},status:'not_found',warehouse:'Склад Северный'})}))
  .mockResolvedValueOnce(JSON.stringify({data:'Структура приобретения'}))
  .mockResolvedValueOnce(data([{Номер:'VERIFIED-1'}]));
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_find_latest_receipt','c1'))
  .mockResolvedValueOnce(tool('onec_get_metadata_structure','c2'))
  .mockResolvedValueOnce(tool('onec_execute_query','c3'))
  .mockResolvedValueOnce(final());
 const answer=await requestOpenAIAnswer({messages,sources:[],onec},new AbortController().signal,fetcher);
 expect(answer.text).toContain('VERIFIED-1');expect(onec.call).toHaveBeenCalledTimes(3);
 expect(JSON.stringify(JSON.parse(fetcher.mock.calls[1][1].body).input)).toContain('not_found');
 expect(onec.validate).toHaveBeenCalledTimes(4);
});

test('even a typed empty lookup is scoped evidence for the agent, not an early final answer',async()=>{
 const onec=tools();onec.definitions=[{type:'function',name:'onec_find_latest_purchase'}] as never[];
 onec.call.mockResolvedValue(JSON.stringify({data:JSON.stringify({kind:'purchase',period:{},status:'not_found',warehouse:'Склад Северный'})}));
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_find_latest_purchase','p')).mockResolvedValueOnce(final('По проверенным условиям приобретений не найдено.'));
 const answer=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи последнее приобретение по складу Северный'}],sources:[],onec},new AbortController().signal,fetcher);
 expect(fetcher).toHaveBeenCalledTimes(2);expect(answer.text).toContain('По проверенным условиям');
});

test('a warehouse miss lets the agent refine the fragment before asking a real choice',async()=>{
 const onec=tools();
 onec.call.mockResolvedValueOnce(JSON.stringify({data:JSON.stringify({kind:'receipt',period:{},status:'warehouse_not_found'})}))
  .mockResolvedValueOnce(JSON.stringify({data:JSON.stringify({kind:'receipt',period:{},status:'choose_warehouse',warehouses:['Склад Северный','Ответхранение Северный'],moreMatches:false})}));
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_find_latest_receipt','c1',{baseKey:'fixture',arguments:{warehouseText:'Северный'}}))
  .mockResolvedValueOnce(tool('onec_find_latest_receipt','c2',{baseKey:'fixture',arguments:{warehouseText:'Север'}}));
 const answer=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи последний приходный документ по складу Севрный основной'}],sources:[],onec},new AbortController().signal,fetcher);
 expect(answer.decision).toBe('clarify');expect(answer.questions[0].options).toHaveLength(2);
 expect(onec.call.mock.calls[0][1].arguments.warehouseText).toBe('Севрный основной');
 expect(onec.call.mock.calls[1][1].arguments.warehouseText).toBe('Север');
});

test('a metadata-only invented business answer stays internal until an actual data read',async()=>{
 const onec=tools();onec.call.mockResolvedValueOnce(JSON.stringify({data:'Документ.Приобретение'})).mockResolvedValueOnce(data([{Номер:'VERIFIED-1'}]));
 const progress=jest.fn();
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_list_metadata_objects','m'))
  .mockResolvedValueOnce(final('Выдуманный № INVENTED'))
  .mockResolvedValueOnce(tool('onec_execute_query','q')).mockResolvedValueOnce(final());
 const answer=await requestOpenAIAnswer({messages,sources:[],onec,progress},new AbortController().signal,fetcher);
 expect(answer.text).toContain('VERIFIED-1');expect(JSON.stringify(progress.mock.calls)).not.toContain('INVENTED');
 expect(JSON.parse(fetcher.mock.calls[2][1].body).tool_choice).toBe('required');
});

test('exhausting the budget after metadata cannot publish unverified business data',async()=>{
 process.env.HELP_OPENAI_MAX_TOOL_CALLS='1';const onec=tools();onec.call.mockResolvedValue(JSON.stringify({data:'Документ.Приобретение'}));
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_list_metadata_objects','m')).mockResolvedValueOnce(final('Выдуманный № INVENTED'));
 await expect(requestOpenAIAnswer({messages,sources:[],onec},new AbortController().signal,fetcher)).rejects.toMatchObject({code:'HELP_OPENAI_UNGROUNDED_DATA'});
});

test('successful metadata followed by premature IT handoff continues a possible data check',async()=>{
 const onec=tools();onec.call.mockResolvedValueOnce(JSON.stringify({data:'Документ.Приобретение'})).mockResolvedValueOnce(data([{Номер:'VERIFIED-1'}]));
 const handoff=Response.json({id:'h',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'handoff',message:'Нужен IT',source_ids:[]})}]}]});
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_inspect_metadata','m')).mockResolvedValueOnce(handoff)
  .mockResolvedValueOnce(tool('onec_execute_query','q')).mockResolvedValueOnce(final());
 const progress=jest.fn();
 const answer=await requestOpenAIAnswer({messages,sources:[],onec,progress},new AbortController().signal,fetcher);
 expect(answer.decision).toBe('answer');expect(answer.text).toContain('VERIFIED-1');
 expect(JSON.stringify(progress.mock.calls)).not.toContain('Нужен IT');
});
