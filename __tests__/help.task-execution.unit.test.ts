import {requestOpenAIAnswer,openAIConfiguration} from '../src/modules/help/help.openai';
const initial={...process.env};
beforeEach(()=>{
 process.env={...initial,NODE_ENV:'development',HELP_AI_ENABLED:'true',KNOWLEDGE_ENABLED:'true',HELP_AI_PROVIDER:'openai',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture-key',HELP_OPENAI_ALLOW_GENERAL:'true'};
 for(const key of ['OPENAI_API_KEY_FILE','HELP_OPENAI_PROXY_URL','HELP_OPENAI_MAX_TOOL_CALLS','HELP_OPENAI_TIMEOUT_MS'])delete process.env[key];
});
afterEach(()=>{process.env=initial;});
const tool=(name:string,id:string)=>Response.json({id,status:'completed',output:[{type:'function_call',name,call_id:id,arguments:'{}'}]});
const answer=(kind:string,status:string,message:string,decision='answer')=>Response.json({id:'final',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({task:{kind,status,goal:'Получить запрошенный результат',remaining:status==='complete'?'':'Нужны данные'},decision,message,source_ids:[],questions:[],files:[]})}]}]});
const onec=()=>({bases:[],definitions:[],proofs:[{baseKey:'fixture',revision:1,binding:'fixture'}],validate:jest.fn().mockResolvedValue(undefined),call:jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({success:true,data:[{name:'verified'}],rowCount:1,truncated:false})}))});
const input={messages:[{role:'user' as const,text:'Какие устройства есть в филиале?'}],sources:[],allowGeneral:true};

test('execution defaults permit a substantial investigation while bounding runaway work',()=>{
 expect(openAIConfiguration()).toMatchObject({maxToolCalls:48,timeoutMs:300000});
 process.env.HELP_OPENAI_MAX_TOOL_CALLS='100000';expect(openAIConfiguration().maxToolCalls).toBe(96);
});

test('more than eight tools and the final objective check run within one user task',async()=>{
 const t=onec(),fetcher=jest.fn();
 for(let i=0;i<11;i++)fetcher.mockResolvedValueOnce(tool(i===10?'onec_execute_query':'onec_get_metadata_structure','c'+i));
 fetcher.mockResolvedValueOnce(answer('records','complete','Найдена запись verified.')).mockResolvedValueOnce(answer('records','complete','Найдена запись verified.'));
 const result=await requestOpenAIAnswer({...input,onec:t},new AbortController().signal,fetcher);
 expect(result.text).toContain('verified');expect(t.call).toHaveBeenCalledTimes(11);
 expect(JSON.parse(fetcher.mock.calls[9][1].body).tool_choice).toBe('auto');
 expect(JSON.stringify(JSON.parse(fetcher.mock.calls[12][1].body).input)).toContain('внутренняя проверка завершения');
});

test('metadata and device types cannot masquerade as the requested devices during objective review',async()=>{
 const t=onec(),progress=jest.fn();
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_inspect_metadata','m'))
  .mockResolvedValueOnce(tool('onec_execute_query','types'))
  .mockResolvedValueOnce(answer('records','complete','Найден только тип устройства.'))
  .mockResolvedValueOnce(tool('onec_execute_query','devices'))
  .mockResolvedValueOnce(answer('records','complete','Получены все устройства.'))
  .mockResolvedValueOnce(answer('records','complete','Получены все устройства.'));
 const result=await requestOpenAIAnswer({...input,onec:t,progress},new AbortController().signal,fetcher);
 expect(result.text).toBe('Получены все устройства.');expect(t.call).toHaveBeenCalledTimes(3);
 expect(JSON.stringify(progress.mock.calls)).not.toContain('Найден только тип устройства.');
});

test('semantic continue keeps working without a second employee message',async()=>{
 const t=onec();const fetcher=jest.fn().mockResolvedValueOnce(answer('records','continue','Нужно ещё прочитать записи.'))
  .mockResolvedValueOnce(tool('onec_execute_query','q'))
  .mockResolvedValueOnce(answer('records','complete','Готово.'))
  .mockResolvedValueOnce(answer('records','complete','Готово.'));
 await requestOpenAIAnswer({...input,onec:t},new AbortController().signal,fetcher);
 expect(JSON.parse(fetcher.mock.calls[1][1].body).tool_choice).toBe('required');expect(t.call).toHaveBeenCalledTimes(1);
});

test('a premature handoff is reviewed against other available sources',async()=>{
 const t=onec();const fetcher=jest.fn().mockResolvedValueOnce(answer('records','blocked','Нужно IT: нет метода API.','handoff'))
  .mockResolvedValueOnce(tool('onec_execute_query','q'))
  .mockResolvedValueOnce(answer('records','complete','Записи найдены в 1С.'))
  .mockResolvedValueOnce(answer('records','complete','Записи найдены в 1С.'));
 const result=await requestOpenAIAnswer({...input,onec:t},new AbortController().signal,fetcher);
 expect(result.decision).toBe('answer');expect(result.text).toContain('1С');
});

test('a successful empty result completes, and a real access refusal remains a block',async()=>{
 for(const blocked of [false,true]){
  const t=onec();t.call.mockResolvedValue(blocked?JSON.stringify({error:'ONEC_ACCESS_DENIED'}):JSON.stringify({data:JSON.stringify({success:true,data:[],rowCount:0,truncated:false})}));
  const state=blocked?'blocked':'complete',decision=blocked?'handoff':'answer',text=blocked?'Личная учётная запись не имеет доступа.':'По указанным условиям записей нет.';
  const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_execute_query','q')).mockResolvedValueOnce(answer('records',state,text,decision)).mockResolvedValueOnce(answer('records',state,text,decision));
  const result=await requestOpenAIAnswer({...input,onec:t},new AbortController().signal,fetcher);
  expect(result.decision).toBe(decision);expect(t.call).toHaveBeenCalledTimes(1);
 }
});

test('greetings need no tool or extra investigation and metadata remains untrusted data',async()=>{
 const t=onec();const fetcher=jest.fn().mockResolvedValueOnce(answer('conversation','complete','Здравствуйте!'));
 const result=await requestOpenAIAnswer({...input,messages:[{role:'user',text:'Привет'}],onec:t,onecWorkingContext:{objects:[{structure:'Справочник.Устройства'}]}},new AbortController().signal,fetcher);
 expect(result.text).toBe('Здравствуйте!');expect(fetcher).toHaveBeenCalledTimes(1);expect(t.call).not.toHaveBeenCalled();
 const req=JSON.parse(fetcher.mock.calls[0][1].body);expect(req.tool_choice).toBe('auto');expect(req.text.format.schema.required).toContain('task');
 expect(JSON.parse(req.input[0].content).onecWorkingContext).toEqual({objects:[{structure:'Справочник.Устройства'}]});
});

test('live catalog discovery can lead to a newly supported read with no knowledge document',async()=>{
 const t=onec();
 t.call.mockImplementation(async(name:string)=> name==='onec_list_tools'
  ?JSON.stringify({data:JSON.stringify({tools:[{name:'get_object_history',callable:true}],complete:true})})
  :JSON.stringify({data:JSON.stringify({success:true,data:[{version:1,fields:{deletionMark:false},snapshot:'stored'}],rowCount:1,truncated:false})}));
 const fetcher=jest.fn().mockResolvedValueOnce(tool('onec_list_tools','catalog'))
  .mockResolvedValueOnce(tool('onec_get_object_history','history'))
  .mockResolvedValueOnce(answer('records','complete','В сохранённой версии пометка удаления отсутствует.'))
  .mockResolvedValueOnce(answer('records','complete','В сохранённой версии пометка удаления отсутствует.'));
 const result=await requestOpenAIAnswer({...input,onec:t},new AbortController().signal,fetcher);
 expect(result.text).toContain('отсутствует');
 expect(t.call.mock.calls.map(c=>c[0])).toEqual(['onec_list_tools','onec_get_object_history']);
 const request=JSON.parse(fetcher.mock.calls[0][1].body);
 expect(request.instructions).not.toContain('Инструментов у тебя нет');
 expect(request.instructions).not.toContain('опиши только доступные сейчас возможности из серверной сводки');
 expect(request.instructions).toContain('База знаний — контекст компании');
 expect(request.instructions).toContain('onec_list_tools');
});
