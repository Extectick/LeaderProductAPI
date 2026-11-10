import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
import {helpHtmlTools} from '../src/modules/help/help.html';
const env={...process.env};afterEach(()=>{process.env=env;});
function config(){process.env={...env,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;}
test('advertises and dispatches HTML tool; persists only actual files and exact tool link',async()=>{
 config();const tools=helpHtmlTools(),progress=jest.fn();let link='';
 const args={title:'Example',description:'Fictional layout',compact:{html:'<p>Условные данные</p>',css:'p{color:#7350da}'},full:{html:'<p>Подробности</p>',css:''}};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>()
 .mockImplementationOnce(async()=>Response.json({id:'r1',status:'completed',output:[{type:'function_call',name:'help_create_html',call_id:'h1',arguments:JSON.stringify(args)}]}))
 .mockImplementationOnce(async(_url,init)=>{
  const body=JSON.parse(String(init?.body)),result=JSON.parse(body.input.find((x:any)=>x.type==='function_call_output').output);link=result.url;
  expect(result).not.toHaveProperty('bytes');
  return Response.json({id:'r2',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:`Пример. [Подробности](${link})`,source_ids:[],suggestions:[],questions:[],files:[]})}]}]});
 });
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи пример HTML/CSS'}],sources:[],htmlTools:tools,progress},new AbortController().signal,transport);
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).tools).toEqual(expect.arrayContaining([expect.objectContaining({name:'help_create_html'})]));
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).max_output_tokens).toBeGreaterThanOrEqual(12000);
 expect(result.text).toContain(link);expect(result.htmlFiles).toHaveLength(1);expect(result.officeFiles).toEqual([]);expect(result.files).toEqual([]);
 expect(progress.mock.calls.some(([value])=>value.draftText)).toBe(false);
});
test('a platform abort with numeric DOMException code cannot mask cancellation with a TypeError',async()=>{
 config();const controller=new AbortController();
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>{controller.abort();throw new DOMException('Aborted','AbortError');});
 await expect(requestOpenAIAnswer({messages:[{role:'user',text:'Пример'}],sources:[],htmlTools:helpHtmlTools()},controller.signal,transport)).rejects.toMatchObject({code:'HELP_OPENAI_CANCELLED'});
});
test('people tool provenance reaches HTML cards before publication',async()=>{
 config();const {helpEntityLinks}=await import('../src/modules/help/help.entity-links');const links=helpEntityLinks(),tools=helpHtmlTools();
 const url='leaderproduct://entity/v1/user/121';
 const people={definitions:[{type:'function',name:'app_search_people'}],hasEvidence:()=>true,validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({success:true,entityLinks:[links.register({v:1,source:'app',kind:'user',id:'121'},'Сотрудник')]}))};
 const calls=[{name:'app_search_people',arguments:JSON.stringify({query:'Сотрудник'})},{name:'help_create_html',arguments:JSON.stringify({title:'Сотрудник',description:'Профиль сотрудника',entity:{url},compact:{html:'<div><img src="help-entity-image" alt="Фото"><h2>Сотрудник</h2></div>',css:'img{width:80px;height:80px}'}})}];
 let step=0;const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>{
  const call=calls[step++];return Response.json({id:'r'+step,status:'completed',output:call?[{type:'function_call',call_id:'call'+step,...call}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'Нажмите на карточку, чтобы открыть профиль.',source_ids:[],suggestions:[],questions:[],files:[]})}]}]});
 });
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Покажи HTML-карточку профиля сотрудника'}],sources:[],htmlTools:tools,entityLinks:links,peopleTools:people},new AbortController().signal,transport);
 expect(result.htmlFiles).toHaveLength(1);const artifact=JSON.parse(result.htmlFiles![0].bytes.toString());expect(artifact.entity).toEqual({url});expect(artifact.compact.html).toContain('help-entity-image');expect(people.validate).toHaveBeenCalled();
});
test('plain self-profile answer still publishes a real card from authenticated requester',async()=>{
 config();const {helpEntityLinks}=await import('../src/modules/help/help.entity-links');const links=helpEntityLinks(),tools=helpHtmlTools();
 const profile=links.register({v:1,source:'app',kind:'user',id:'7'},'Петров Иван');
 const requesterContext={value:{source:'authenticated_application_user' as const,userId:7,displayName:'Петров Иван',role:'employee',profileType:'EMPLOYEE',profile},validate:jest.fn(async()=>{})};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(Response.json({id:'r1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'Ваш профиль: [Петров Иван]('+profile.url+').',source_ids:[],suggestions:[],questions:[],files:[]})}]}]}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Пришли мой профиль'}],sources:[],htmlTools:tools,entityLinks:links,requesterContext},new AbortController().signal,transport);
 expect(transport).toHaveBeenCalledTimes(1);expect(result.htmlFiles).toHaveLength(1);expect(JSON.parse(result.htmlFiles![0].bytes.toString())).toMatchObject({entity:{url:profile.url},compact:{html:expect.stringContaining('Петров Иван')}});expect(requesterContext.validate.mock.calls.length).toBeGreaterThanOrEqual(2);
});
test('application tools dispatch verified chat links and preserve them through answer sanitizing',async()=>{
 config();const {helpEntityLinks}=await import('../src/modules/help/help.entity-links');const {helpAppLinks}=await import('../src/modules/help/help.app-links');
 const links=helpEntityLinks(),apps=helpAppLinks();links.bindAppLinks(apps);
 const appTools={definitions:[{type:'function',name:'app_get_help_chat'}],hasEvidence:()=>true,validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({success:true,chat:apps.register(52,'Чат52')}))};
 let step=0;const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>Response.json({id:'r'+(++step),status:'completed',output:step===1?[{type:'function_call',call_id:'c1',name:'app_get_help_chat',arguments:'{"ticketId":52}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'[Чат №52](leaderproduct://services/help?ticketId=52)',source_ids:[],suggestions:[],questions:[],files:[]})}]}]}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Пришли ссылку на чат #52'}],sources:[],appTools,entityLinks:links},new AbortController().signal,transport);
 expect(appTools.call).toHaveBeenCalledWith('app_get_help_chat',{ticketId:52},expect.any(AbortSignal));expect(result.text).toContain('](leaderproduct://services/help?ticketId=52)');
 expect(links.sanitize('[Другой](leaderproduct://services/help?ticketId=53)')).toBe('Другой');expect(appTools.validate).toHaveBeenCalled();
});
test('one batch tool call creates the complete eight-card list without consuming a call per item',async()=>{
 config();const {helpEntityLinks}=await import('../src/modules/help/help.entity-links');const links=helpEntityLinks(),tools=helpHtmlTools();
 const cards=Array.from({length:8},(_,index)=>({title:'Синтетический профиль '+(index+1),description:'Тестовая карточка сотрудника',entity:{url:'leaderproduct://entity/v1/user/'+(index+1)},compact:{html:'<section style="height:112px"><img src="help-entity-image" alt="Фото"><p>Профиль '+(index+1)+'</p></section>',css:''}}));
 const people={definitions:[{type:'function',name:'app_search_people'}],hasEvidence:()=>true,validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({success:true,entityLinks:cards.map((card,index)=>links.register({v:1,source:'app',kind:'user',id:String(index+1)},card.title))}))};
 const calls=[{name:'app_search_people',arguments:'{"query":"Синтетические профили"}'},{name:'help_create_html',arguments:JSON.stringify({items:cards})}];
 let step=0;const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockImplementation(async()=>{
  const call=calls[step++];return Response.json({id:'batch-r'+step,status:'completed',output:call?[{type:'function_call',call_id:'batch-c'+step,...call}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'Подготовлены все восемь карточек сотрудников.',source_ids:[],suggestions:[],questions:[],files:[]})}]}]});
 });
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Пришли список из восьми карточек сотрудников'}],sources:[],htmlTools:tools,entityLinks:links,peopleTools:people},new AbortController().signal,transport);
 expect(result.htmlFiles).toHaveLength(8);expect(transport).toHaveBeenCalledTimes(3);expect(people.validate).toHaveBeenCalled();
 expect(result.htmlFiles!.map(file=>JSON.parse(file.bytes.toString()).entity.url)).toEqual(cards.map(card=>card.entity.url));
});
