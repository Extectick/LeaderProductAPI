import { requestOpenAIAnswer,buildOpenAIInput,requestHelpContextCompaction } from '../src/modules/help/help.openai';
const original={...process.env};
beforeEach(()=>{process.env={...original,HELP_AI_ENABLED:'true',KNOWLEDGE_ENABLED:'true',HELP_AI_PROVIDER:'openai',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;});
afterEach(()=>{process.env=original});
const question={role:'user' as const,text:'Какой код проекта я указал в начале чата?'};
const coverage={totalMessages:300,quotedMessages:1,summaryThrough:200,omittedMessages:299,throughSequence:300,compaction:'not_needed' as const};
const conversation={messages:[{id:300,sequence:300,...question,attachments:[]}],coverage};
const final=(text='Вы указали код PROJECT-17.',history_ids:number[]=[])=>Response.json({id:'r',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:text,source_ids:[],history_ids})}]}]});
const call=(name:string,args:unknown)=>Response.json({id:'t',status:'completed',output:[{type:'function_call',name,call_id:'c',arguments:JSON.stringify(args)}]});
test('the model can retrieve an old message in its own conversation without a 1C tool',async()=>{
 const historyTools={definitions:[{type:'function',name:'help_search_history'}],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({results:[{id:1,sequence:1,role:'user',snippet:'Код проекта PROJECT-17'}]}))};
 const transport=jest.fn().mockResolvedValueOnce(call('help_search_history',{query:'код проекта'})).mockResolvedValueOnce(final(undefined,[1]));
 const result=await requestOpenAIAnswer({messages:[question],sources:[],conversation,historyTools},new AbortController().signal,transport);
 expect(result.text).toContain('PROJECT-17');expect(historyTools.call).toHaveBeenCalledTimes(1);expect(historyTools.validate).toHaveBeenCalledTimes(2);
 const body=JSON.parse(transport.mock.calls[1][1].body);expect(body.instructions).toContain('Не проси повторить сведения');expect(JSON.stringify(body.input)).toContain('PROJECT-17');
});
test('revoked conversation access aborts before sending another provider request',async()=>{
 const denied=Object.assign(Error('denied'),{code:'HELP_CONTEXT_FORBIDDEN',status:403});
 const historyTools={definitions:[],validate:jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied),call:jest.fn(async()=>'{"messages":[]}')};
 const transport=jest.fn().mockResolvedValueOnce(call('help_read_history',{}));
 await expect(requestOpenAIAnswer({messages:[question],sources:[],conversation,historyTools},new AbortController().signal,transport)).rejects.toBe(denied);
 expect(transport).toHaveBeenCalledTimes(1);
});
test('whole recent messages, source IDs and server image-availability notes survive context assembly',()=>{
 const text='Длинное '+ 'я'.repeat(4000)+' окончание';
 const row={id:1,sequence:1,role:'user' as const,text,attachments:[]};
 const input=buildOpenAIInput({messages:[row,{role:'user',text:'[Сведения сервера: часть изображений недоступна.]'}],sources:[],conversation:{messages:[row],coverage}});
 expect(input.messages[0]).toMatchObject({id:1,text});expect(input.messages[1].text).toContain('изображений недоступна');
 expect(input.conversationCoverage).toEqual(coverage);
});
test('historical image bytes go to the provider as vision content, never into public tool progress',async()=>{
 const imageQuestion={role:'user' as const,text:'Что показано на старом скриншоте в обращении?'};
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({available:true,supported:false,attachment:{id:'f',kind:'IMAGE'}})),readImages:jest.fn(async()=>[{image_url:'data:image/jpeg;base64,PRIVATE_IMAGE'}])};
 const transport=jest.fn().mockResolvedValueOnce(call('help_read_attachment',{attachmentId:'f'})).mockResolvedValueOnce(final('На изображении показана ошибка.'));
 const progress=jest.fn();
 await requestOpenAIAnswer({messages:[imageQuestion],sources:[],conversation:{...conversation,messages:[{id:300,sequence:300,...imageQuestion,attachments:[]}]},historyTools,progress},new AbortController().signal,transport);
 expect(JSON.stringify(JSON.parse(transport.mock.calls[1][1].body).input)).toContain('input_image');
 expect(JSON.stringify(progress.mock.calls)).not.toContain('PRIVATE_IMAGE');
});

test('a recovered historical 1C answer cannot substitute for a requested fresh business read',async()=>{
 const liveQuestion={role:'user' as const,text:'Покажи последнее приобретение по складу Северный'};
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({messages:[{id:1,sequence:1,role:'assistant',text:'Старый документ OLD-1'}]}))};
 const onec={definitions:[],bases:[],proofs:[{baseKey:'base',revision:1,binding:'fixture'}],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({data:JSON.stringify({success:true,rowCount:1,data:[{Номер:'NEW-2'}]})}))};
 const records=(text:string)=>Response.json({id:'r',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({task:{kind:'records',status:'complete',goal:'Показать актуальный документ',remaining:''},decision:'answer',message:text,source_ids:[],history_ids:[]})}]}]});
 const transport=jest.fn().mockResolvedValueOnce(call('help_read_history',{messageId:1})).mockResolvedValueOnce(records('Актуальный документ OLD-1'))
  .mockResolvedValueOnce(call('onec_execute_query',{baseKey:'base',arguments:{query:'ВЫБРАТЬ ПЕРВЫЕ 1 Номер ИЗ Документ.Приобретение'}})).mockResolvedValueOnce(records('Проверен новый документ NEW-2')).mockResolvedValueOnce(records('Проверен новый документ NEW-2'));
 const result=await requestOpenAIAnswer({messages:[liveQuestion],sources:[],conversation:{...conversation,messages:[{id:300,sequence:300,...liveQuestion,attachments:[]}]},historyTools,onec},new AbortController().signal,transport);
 expect(result.text).toContain('NEW-2');expect(onec.call).toHaveBeenCalledTimes(1);
 expect(JSON.parse(transport.mock.calls[2][1].body).tool_choice).toBe('required');
});

test('conversation presence alone does not authorize uncited company rules',async()=>{
 const current={role:'user' as const,text:'Какие правила закрытия обращений действуют в компании?'};
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn()};
 await expect(requestOpenAIAnswer({messages:[current],sources:[],conversation:{...conversation,messages:[{id:300,sequence:300,...current,attachments:[]}]},historyTools},new AbortController().signal,jest.fn().mockResolvedValueOnce(final('Обращения закрываются автоматически через 24 часа.')))).rejects.toMatchObject({code:'HELP_OPENAI_INVALID_CITATIONS'});
});

test('a covering user decision summary permits attributed recall with its real source IDs',async()=>{
 const current={role:'user' as const,text:'Напомни код проекта, который мы выбрали.'};
 const summary={version:1 as const,model:'fixture',coveredThrough:200,fingerprint:'a'.repeat(64),items:[{kind:'decision' as const,text:'Код проекта PROJECT-17',messageIds:[7]}]};
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn()};
 const result=await requestOpenAIAnswer({messages:[current],sources:[],conversation:{...conversation,summary,messages:[{id:300,sequence:300,...current,attachments:[]}]},historyTools},new AbortController().signal,jest.fn().mockResolvedValueOnce(final(undefined,[7])));
 expect(result.text).toContain('PROJECT-17');expect(historyTools.call).not.toHaveBeenCalled();
 expect('history_ids' in result).toBe(false);
});

test('assistant-only memory cannot become uncited evidence of an employee decision',async()=>{
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn()};
 const summary={version:1 as const,model:'fixture',coveredThrough:200,fingerprint:'a'.repeat(64),items:[{kind:'reported_result' as const,text:'Код проекта PROJECT-17',messageIds:[7]}]};
 await expect(requestOpenAIAnswer({messages:[question],sources:[],conversation:{...conversation,summary,coverage:{...coverage,omittedMessages:0}},historyTools},new AbortController().signal,jest.fn().mockResolvedValueOnce(final(undefined,[7])))).rejects.toMatchObject({code:'HELP_OPENAI_INVALID_CITATIONS'});
});

test('a response may not cite a message absent from authorized history evidence',async()=>{
 const historyTools={definitions:[],validate:jest.fn(async()=>{}),call:jest.fn()};
 await expect(requestOpenAIAnswer({messages:[question],sources:[],conversation:{...conversation,coverage:{...coverage,omittedMessages:0}},historyTools},new AbortController().signal,jest.fn().mockResolvedValueOnce(final(undefined,[999])))).rejects.toMatchObject({code:'HELP_OPENAI_INVALID_CITATIONS'});
});

function streamedGuess() {
 const answer={decision:'answer',message:'Вы указали неверный код GUESS-17.',source_ids:[],history_ids:[1]};
 const response={id:'guess',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(answer)}]}]};
 return new Response([{type:'response.output_text.delta',delta:JSON.stringify(answer)},{type:'response.completed',response}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
test.each([false,true])('omitted history forces original recovery before a guessed answer or repeat request (general=%s)',async general=>{
 if(general){process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';}
 const first={id:1,sequence:1,role:'user' as const,text:'Изначальный код GUESS-17',attachments:[]};
 const historyTools={definitions:[{type:'function',name:'help_search_history'}],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({results:[{id:8,sequence:8,role:'user',snippet:'Поправка: код проекта PROJECT-28'}],hasMore:false,nextSequence:8}))};
 const progress=jest.fn();
 const transport=jest.fn().mockResolvedValueOnce(streamedGuess())
  .mockResolvedValueOnce(call('help_search_history',{query:'код проекта'})).mockResolvedValueOnce(final('После уточнения вы выбрали PROJECT-28.',[8]));
 const result=await requestOpenAIAnswer({messages:[question],sources:[],allowGeneral:general,conversation:{...conversation,messages:[first,...conversation.messages]},historyTools,progress},new AbortController().signal,transport);
 expect(result.text).toContain('PROJECT-28');expect(historyTools.call).toHaveBeenCalledTimes(1);
 expect(JSON.parse(transport.mock.calls[1][1].body).tool_choice).toBe('required');
 expect(JSON.stringify(progress.mock.calls)).not.toContain('GUESS-17');
});

test.each(['clarify','handoff'])('a premature %s must recover omitted conversational history first',async decision=>{
 const historyTools={definitions:[{type:'function',name:'help_search_history'}],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({results:[{id:1,sequence:1,role:'user',snippet:'Код проекта PROJECT-17'}]}))};
 const stopped=Response.json({id:'stop',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision,message:'Повторите код или вызовите IT.',source_ids:[]})}]}]});
 const transport=jest.fn().mockResolvedValueOnce(stopped).mockResolvedValueOnce(call('help_search_history',{query:'код проекта'})).mockResolvedValueOnce(final(undefined,[1]));
 const result=await requestOpenAIAnswer({messages:[question],sources:[],conversation,historyTools},new AbortController().signal,transport);
 expect(result.text).toContain('PROJECT-17');expect(historyTools.call).toHaveBeenCalledTimes(1);
});

const compactMessages=[{id:1,sequence:1,role:'user' as const,text:'Код проекта PROJECT-17',attachments:[]}];
const compactResponse=()=>Response.json({id:'summary',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({items:[{kind:'constraint',text:'Код проекта PROJECT-17',messageIds:[1]}]})}]}]});
test('compaction validator fences both sides of the provider request',async()=>{
 const validate=jest.fn(async()=>{}),transport=jest.fn().mockResolvedValueOnce(compactResponse());
 const result=await requestHelpContextCompaction(undefined,compactMessages,new AbortController().signal,transport,validate);
 expect(result[0].messageIds).toEqual([1]);expect(validate).toHaveBeenCalledTimes(2);
 expect(validate.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]);
 expect(validate.mock.invocationCallOrder[1]).toBeGreaterThan(transport.mock.invocationCallOrder[0]);
});
test.each(['before','after'])('compaction access revocation %s HTTP remains a scope failure, not a cache fallback',async phase=>{
 const denied=Object.assign(Error('revoked'),{code:'HELP_CONTEXT_FORBIDDEN',status:403});
 const validate=phase==='before'?jest.fn().mockRejectedValueOnce(denied):jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
 const transport=jest.fn().mockResolvedValueOnce(compactResponse());
 await expect(requestHelpContextCompaction(undefined,compactMessages,new AbortController().signal,transport,validate)).rejects.toBe(denied);
 expect(transport).toHaveBeenCalledTimes(phase==='before'?0:1);
});
