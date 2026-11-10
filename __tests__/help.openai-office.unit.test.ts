import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
import {helpAnalyticsInstructions} from '../src/modules/help/help.analytics-instructions';
const env={...process.env};afterEach(()=>{process.env=env});
test.each(['help_create_spreadsheet','help_create_document'])('office tool %s returns a real private artifact without exposing bytes in model context',async name=>{
 process.env={...env,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;
 const files:any[]=[],progress=jest.fn(),call=jest.fn().mockImplementation(async()=>{files.push({name:name.endsWith('document')?'report.docx':'report.xlsx',mimeType:'fixture',kind:'FILE',bytes:Buffer.from('server-only-office-bytes')});return JSON.stringify({created:true,name:files[0].name});});
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValueOnce(Response.json({id:'r1',status:'completed',output:[{type:'function_call',name,call_id:'o1',arguments:JSON.stringify({name:'report.xlsx'})}]})).mockResolvedValueOnce(Response.json({id:'r2',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'Документ готов.',source_ids:[],suggestions:[],questions:[],files:[]})}]}]}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Создай отчёт Excel или Word'}],sources:[],officeTools:{definitions:[{type:'function',name,parameters:{type:'object'}}],files,call,rememberData:o=>o},progress},new AbortController().signal,transport);
 expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).tools).toEqual(expect.arrayContaining([expect.objectContaining({name})]));
 expect(result.officeFiles).toEqual(files);expect(call).toHaveBeenCalledTimes(1);expect(result.files).toEqual([]);
 expect(JSON.stringify(transport.mock.calls)).not.toContain('server-only-office-bytes');
 expect(progress.mock.calls.some(([update])=>update.draftText)).toBe(false);
});
test('the analytical method also reaches knowledge-backed requests without replacing input or forcing a tool',async()=>{
 process.env={...env,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;
 const source={documentId:'doc',versionId:'v',revision:1,title:'Проверенный справочный материал',path:'Company',sourceUrl:'/knowledge/doc',excerpt:'Справочные данные по задаче.'};
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(Response.json({id:'r1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'По указанным условиям совпадений нет.',source_ids:['S1'],suggestions:[],questions:[],files:[]})}]}]}));
 const result=await requestOpenAIAnswer({messages:[{role:'user',text:'Проверь данные без создания файла'}],sources:[source]},new AbortController().signal,transport);
 const body=JSON.parse(String(transport.mock.calls[0][1]?.body));
 expect(body.instructions).toContain(helpAnalyticsInstructions);expect(JSON.parse(body.input[0].content).messages).toEqual([{role:'user',text:'Проверь данные без создания файла'}]);
 expect(body.tools).toBeUndefined();expect(result.officeFiles).toEqual([]);expect(result.sources).toEqual([source]);
});
