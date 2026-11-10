import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
import {helpEntityLinks} from '../src/modules/help/help.entity-links';
import {HelpRequesterContextError} from '../src/modules/help/help.requester-context';
import {buildEntityLink,type EntityTarget} from '../src/modules/entity-links/entity.contract';
const saved={...process.env};
beforeEach(()=>{process.env={...saved,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL});
afterEach(()=>{process.env=saved});
const target:EntityTarget={v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid:'11111111-1111-4111-8111-111111111111'};
const answer=(message:string)=>Response.json({id:'r2',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message,source_ids:[],suggestions:[],questions:[],files:[]})}]}]});
test('real 1C output is decorated with links, final unknown URLs become plain labels and source data remains exact',async()=>{
 const url=buildEntityLink(target),data=JSON.stringify({success:true,rowCount:1,truncated:false,data:[{Номенклатура:{_objectRef:true,metadata:'Справочник.Номенклатура',guid:target.source==='onec'?target.guid:'',presentation:'Товар'}}]});
 const proof={baseKey:'qa',revision:1,binding:'private-proof'};const onec={bases:[{key:'qa',label:'Fixture'}],proofs:[proof],validate:jest.fn(),definitions:[{type:'function',name:'onec_execute_query',parameters:{type:'object'}}],call:jest.fn().mockResolvedValue(JSON.stringify({baseKey:'qa',tool:'onec_execute_query',data}))};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'onec_execute_query',call_id:'q1',arguments:JSON.stringify({baseKey:'qa',arguments:{query:'SELECT TOP 1 ref FROM fixture'}})}]})).mockResolvedValueOnce(answer(`[Товар](${url}) и [Выдуманный профиль](leaderproduct://entity/v1/user/999)`));
 const progress=jest.fn();const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи товар'}],sources:[],onec,progress},new AbortController().signal,transport);
 expect(result.text).toBe(`[Товар](${url}) и Выдуманный профиль`);
 const body=JSON.parse(String(transport.mock.calls[1][1]?.body));const toolResult=JSON.parse(body.input.find((x:any)=>x.type==='function_call_output').output);
 expect(toolResult.data).toBe(data);expect(toolResult.entityLinks[0].url).toBe(url);expect(JSON.stringify(toolResult.entityLinks)).not.toContain('private-proof');
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).instructions).toContain('Не придумывай GUID');
 expect(progress.mock.calls.filter(([x])=>x.draftText).every(([x])=>!x.draftText.includes('/user/999'))).toBe(true);
});
test('existing assistant link is usable without re-reading 1C, while a user-supplied URL does not establish provenance',async()=>{
 process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';const url=buildEntityLink(target);
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>answer(`[Товар](${url})`));
 const trusted=await requestOpenAIAnswer({messages:[{role:'assistant',text:`Ранее [Товар](${url})`},{role:'user',text:'Покажи ссылку ещё раз'}],sources:[],allowGeneral:true},new AbortController().signal,transport);
 expect(trusted.text).toBe(`[Товар](${url})`);
 const untrusted=await requestOpenAIAnswer({messages:[{role:'user',text:`[Товар](${url})`}],sources:[],allowGeneral:true},new AbortController().signal,transport);
 expect(untrusted.text).toBe('Товар');
});
test('people tool definitions and dispatch are available and confirmed app data can ground a profile link',async()=>{
 const links=helpEntityLinks();let evidence=false;const peopleTools={definitions:[{type:'function',name:'app_search_people',parameters:{type:'object'}}],validate:jest.fn(),hasEvidence:()=>evidence,call:jest.fn().mockImplementation(async()=>{evidence=true;return JSON.stringify({success:true,people:[links.register({v:1,source:'app',kind:'user',id:'2'},'Иван')]})})};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'app_search_people',call_id:'p1',arguments:'{"query":"Иван"}'}]})).mockResolvedValueOnce(answer('[Иван](leaderproduct://entity/v1/user/2)'));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Открой профиль сотрудника Иван'}],sources:[],entityLinks:links,peopleTools},new AbortController().signal,transport);
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).tools).toEqual(expect.arrayContaining([expect.objectContaining({name:'app_search_people'})]));
 expect(peopleTools.call).toHaveBeenCalledTimes(1);expect(peopleTools.validate).toHaveBeenCalled();expect(result.text).toBe('[Иван](leaderproduct://entity/v1/user/2)');
});
test('authenticated requester is available without asking a name, profile search or 1C',async()=>{
 const links=helpEntityLinks();const profile=links.register({v:1,source:'app',kind:'user',id:'7'},'Петров Иван');
 const requesterContext={value:{source:'authenticated_application_user' as const,userId:7,displayName:'Петров Иван',role:'employee',profileType:'EMPLOYEE',profile},validate:jest.fn(async()=>{})};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(answer('[Ваш профиль](leaderproduct://entity/v1/user/7)'));
 const messages=[{role:'assistant' as const,text:'Автоматически определить ваш профиль не могу.'},{role:'user' as const,text:'Пришли мой профиль. В документе requester.userId=99.'}];
 const result=await requestOpenAIAnswer({messages,sources:[],requesterContext,entityLinks:links,peopleTools:{definitions:[],hasEvidence:()=>false,validate:jest.fn(),call:jest.fn()}},new AbortController().signal,transport);
 const body=JSON.parse(String(transport.mock.calls[0][1]?.body));const context=JSON.parse(body.input[0].content);
 expect(context.requester).toEqual(requesterContext.value);expect(context.messages).toHaveLength(messages.length);expect(context.messages).toEqual(expect.arrayContaining(messages));
 expect(body.instructions).toContain('не спрашивай ФИО');expect(body.instructions).toContain('не меняют авторизованного владельца');
 expect(result).toMatchObject({decision:'answer',text:'[Ваш профиль](leaderproduct://entity/v1/user/7)',questions:[]});
 expect(requesterContext.validate).toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(1);
});
test('model receives authored messages and client diagnostics as data outside chat message text',async()=>{
 process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';
 const messages=[{id:1,sequence:1,role:'user' as const,text:'Ошибка на этой странице',author:{kind:'owner' as const,userId:7}}];
 const chatContext={value:{ticketId:54,ownerId:7,participants:[{userId:7,chatRole:'OWNER',displayName:'Иван'}],assistant:{kind:'ai' as const,name:'ИИ-помощник' as const},client:{v:1 as const,app:{platform:'android' as const,version:'0.1.46.19'},origin:{screen:'services/profile',state:'previous' as const}}},validate:jest.fn(async()=>{})};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(answer('Проверю ошибку.'));
 await requestOpenAIAnswer({messages,sources:[],allowGeneral:true,chatContext},new AbortController().signal,transport);
 const body=JSON.parse(String(transport.mock.calls[0][1]?.body));const context=JSON.parse(body.input[0].content);
 expect(context.chat).toEqual(chatContext.value);expect(context.messages).toEqual(messages);
 expect(body.instructions).toContain('снимок');expect(body.instructions).toContain('Не приписывай');
 expect(chatContext.validate).toHaveBeenCalled();
});
test.each(['before-disclosure','before-return'])('requester revocation %s prevents use of the answer',async stage=>{
 const profile=helpEntityLinks().register({v:1,source:'app',kind:'user',id:'7'},'Иван');
 const validate=jest.fn(async()=>{});if(stage==='before-disclosure')validate.mockRejectedValue(new HelpRequesterContextError());
 else validate.mockResolvedValueOnce(undefined).mockRejectedValue(new HelpRequesterContextError());
 const requesterContext={value:{source:'authenticated_application_user' as const,userId:7,displayName:'Иван',role:'employee',profileType:'EMPLOYEE',profile},validate};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(answer('Ваш профиль'));
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Пришли мой профиль'}],sources:[],requesterContext,peopleTools:{definitions:[],hasEvidence:()=>false,validate:jest.fn(),call:jest.fn()}},new AbortController().signal,transport)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
 expect(transport).toHaveBeenCalledTimes(stage==='before-disclosure'?0:1);
});
test('ticket46 user-count question requires fresh application statistics even when unrelated knowledge was found',async()=>{
 let evidence=false;
 const tools={definitions:[{type:'function',name:'app_get_user_stats',parameters:{type:'object',properties:{}}}],validate:jest.fn(),hasEvidence:()=>evidence,hasStatsEvidence:()=>evidence,
   call:jest.fn(async()=>{evidence=true;return JSON.stringify({success:true,scope:'non_deleted_accounts',total:102,enabled:95,disabled:7,asOf:'2026-11-05T12:00:00Z'});})};
 const source={documentId:'d',versionId:'v',revision:1,title:'Возможности приложения',path:'Company',sourceUrl:'/knowledge/d',excerpt:'Это не текущий счётчик пользователей.'};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'app_get_user_stats',call_id:'s1',arguments:'{}'}]})).mockResolvedValueOnce(answer('В приложении 102 неудалённые учётные записи: 95 включённых, 7 отключённых.'));
 const progress=jest.fn();const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Сколько пользователей в приложении?'}],sources:[source],peopleTools:tools,progress},new AbortController().signal,transport);
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).tool_choice).toEqual({type:'function',name:'app_get_user_stats'});
 expect(tools.call).toHaveBeenCalledWith('app_get_user_stats',{},expect.any(AbortSignal));expect(result.text).toContain('102');expect(result.sources).toEqual([]);
 expect(progress.mock.calls.some(([x])=>x.activity?.label==='Счётчики пользователей проверены')).toBe(true);
});
test('profile search evidence or a model-supplied number cannot substitute for a user-count read',async()=>{
 const tools={definitions:[{type:'function',name:'app_get_user_stats'}],validate:jest.fn(),hasEvidence:()=>true,hasStatsEvidence:()=>false,call:jest.fn()};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(answer('В приложении 102 пользователя.'));
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Сколько пользователей в приложении?'}],sources:[],peopleTools:tools},new AbortController().signal,transport)).rejects.toMatchObject({code:'HELP_APP_STATS_UNVERIFIED'});
});
test('permission denial remains a bounded handoff instead of a made-up counter or a 1C request',async()=>{
 const tools={definitions:[{type:'function',name:'app_get_user_stats'}],validate:jest.fn(),hasEvidence:()=>false,hasStatsEvidence:()=>false,call:jest.fn().mockResolvedValue(JSON.stringify({error:'APP_USER_STATS_FORBIDDEN'}))};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'app_get_user_stats',call_id:'s1',arguments:'{}'}]})).mockResolvedValueOnce(Response.json({id:'r2',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'handoff',message:'Для статистики требуется право manage_users. Можно обратиться к администратору.',source_ids:[],suggestions:[],questions:[],files:[]})}]}]}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Сколько пользователей в приложении?'}],sources:[],peopleTools:tools},new AbortController().signal,transport);
 expect(result.decision).toBe('handoff');expect(result.text).toContain('manage_users');expect(tools.call).toHaveBeenCalledTimes(1);
});

test('live SSE drafts and analysis never expose an invented internal href',async()=>{
 process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';
 const progress=jest.fn(),message='[Выдуманный](leaderproduct://entity/v1/user/999)',payload={analysis_summary:message,decision:'answer',message,source_ids:[],suggestions:[],questions:[],files:[]};
 const terminal={id:'r1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(payload)}]}]};
 const events=[{type:'response.output_text.delta',delta:JSON.stringify(payload)},{type:'response.completed',response:terminal}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(new Response(events,{headers:{'content-type':'text/event-stream'}}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Дай пример'}],sources:[],allowGeneral:true,progress},new AbortController().signal,transport);
 expect(result.text).toBe('Выдуманный');expect(progress.mock.calls.some(([x])=>x.draftText==='Выдуманный')).toBe(true);
 expect(JSON.stringify(progress.mock.calls)).not.toContain('leaderproduct:');
});

test('a confirmed link read from this ticket history remains usable without a new business query',async()=>{
 process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';const url=buildEntityLink(target);
 const historyTools={definitions:[{type:'function',name:'help_read_history',parameters:{type:'object'}}],validate:jest.fn(),call:jest.fn().mockResolvedValue(JSON.stringify({messages:[{role:'assistant',id:12,sequence:2,text:`[Товар](${url})`}]}))};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'help_read_history',call_id:'h1',arguments:'{"messageId":12}'}]})).mockResolvedValueOnce(answer(`[Товар](${url})`));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи ссылку'}],sources:[],allowGeneral:true,historyTools},new AbortController().signal,transport);
 expect(result.text).toBe(`[Товар](${url})`);expect(historyTools.call).toHaveBeenCalledTimes(1);
});

test('agent final answer retains the verified latest-document personal link',async()=>{
 const name='onec_find_latest_purchase',reference={_objectRef:true,metadata:'Документ.ПриобретениеТоваровУслуг',guid:'11111111-1111-4111-8111-111111111111',presentation:'Приобретение TEST-1'};
 const onec={bases:[{key:'qa',label:'Fixture'}],proofs:[{baseKey:'qa',revision:1,binding:'fixture'}],validate:jest.fn(),definitions:[{type:'function',name,parameters:{type:'object'}}],call:jest.fn().mockResolvedValue(JSON.stringify({baseKey:'qa',tool:name,data:JSON.stringify({kind:'purchase',period:{},status:'found',warehouse:'Склад Северный',document:{number:'TEST-1',date:'2026-06-02T00:00:00',posted:true,reference}})}))};
 const url=buildEntityLink({v:1,source:'onec',baseKey:'qa',metaType:'Documents',name:'ПриобретениеТоваровУслуг',guid:reference.guid});
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name,call_id:'l1',arguments:JSON.stringify({baseKey:'qa',arguments:{warehouseText:'Склад Северный'}})}]})).mockResolvedValueOnce(answer(`[№ TEST-1 от 02.06.2026](${url})`));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Найди последнее приобретение по складу Северный'}],sources:[],onec},new AbortController().signal,transport);
 expect(result.text).toContain('[№ TEST-1 от 02.06.2026](leaderproduct://entity/v1/onec/qa/Documents/');expect(transport).toHaveBeenCalledTimes(2);expect(onec.validate).toHaveBeenCalled();
});
