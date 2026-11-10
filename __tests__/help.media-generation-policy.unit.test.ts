import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
const env={...process.env};afterEach(()=>{process.env=env});
test('media generation is disabled while reading existing attachments stays available',async()=>{
 process.env={...env,HELP_AI_ENABLED:'true',HELP_AI_PROVIDER:'openai',KNOWLEDGE_ENABLED:'true',HELP_OPENAI_ENABLED:'true',HELP_OPENAI_MODEL:'fixture',OPENAI_API_KEY:'fixture',NODE_ENV:'development',HELP_OPENAI_ALLOW_GENERAL:'true'};delete process.env.OPENAI_API_KEY_FILE;delete process.env.HELP_OPENAI_PROXY_URL;
 const transport=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>().mockResolvedValue(Response.json({id:'r1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision:'answer',message:'Генерация изображений и видео отключена в приложении.',source_ids:[],suggestions:[],questions:[],files:[]})}]}]}));
 await requestOpenAIAnswer({messages:[{role:'user',text:'Создай фото и видео'}],sources:[],allowGeneral:true},new AbortController().signal,transport);
 const sent=JSON.parse(String(transport.mock.calls[0][1]?.body));
 expect(sent.instructions).toContain('генерация новых изображений, фотографий и видео');
 expect(sent.instructions).toContain('не запрет на чтение существующих');
 expect(sent.tools||[]).not.toEqual(expect.arrayContaining([expect.objectContaining({type:'image_generation'})]));
});
