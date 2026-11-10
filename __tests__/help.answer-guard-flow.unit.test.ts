jest.mock('../src/modules/help/help.onec-workspace',()=>({helpOnecWorkspace:jest.fn(async(_ticket,_owner,_through,tools)=>({tools,context:undefined}))}));
jest.mock('../src/modules/help/help.context-store',()=>({loadHelpConversation:jest.fn(async()=>({messages:[],totalMessages:0,omittedBefore:0,fingerprint:"a".repeat(64)})),HelpContextError:class extends Error{constructor(code:string){super(code);Object.assign(this,{code,status:409})}},helpContextFingerprint:jest.fn(async()=>({fingerprint:"a".repeat(64),totalMessages:0}))}));
jest.mock('../src/modules/help/help.context-history',()=>({helpContextHistoryTools:jest.fn(()=>({definitions:[],call:jest.fn(),validate:jest.fn(async()=>{})}))}));
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpMessage:{findMany:jest.fn(),findFirst:jest.fn().mockResolvedValue(null)},helpEvent:{findMany:jest.fn().mockResolvedValue([]),findFirst:jest.fn().mockResolvedValue(null)},user:{findUnique:jest.fn()},helpTicket:{findUnique:jest.fn()},$transaction:jest.fn() } }));
jest.mock('../src/modules/help/help.knowledge', () => ({ retrieveHelpKnowledge:jest.fn(),renderKnowledgeExcerpts:jest.fn(()=>({sources:[]})),validateHelpKnowledgeSources:jest.fn(),knowledgeHandoff:jest.fn(()=>({text:'По найденным материалам недостаточно данных.',sources:[],mode:'knowledge-excerpts',handoffReason:'model_handoff',action:{type:'request_it'}})) }));
jest.mock('../src/modules/help/help.onec-tools', () => ({helpOnecTools:jest.fn(),HelpOnecConnectionRequired:class extends Error{}}));
jest.mock('../src/modules/help/help.ai-images', () => ({helpAIImages:jest.fn()}));
jest.mock('../src/modules/help/help.openai',()=>({requestOpenAIAnswer:jest.fn(),openAIConfiguration:()=>({allowGeneral:true}),HelpOpenAIError:class extends Error{}}));
import {loadHelpConversation,helpContextFingerprint} from '../src/modules/help/help.context-store';
import {helpContextHistoryTools} from '../src/modules/help/help.context-history';
import prisma from '../src/prisma/client';
import {retrieveHelpKnowledge} from '../src/modules/help/help.knowledge';
import {helpOnecTools} from '../src/modules/help/help.onec-tools';
import {helpAIImages} from '../src/modules/help/help.ai-images';
import {requestOpenAIAnswer} from '../src/modules/help/help.openai';
import {prepareHelpOpenAIAnswer} from '../src/modules/help/help.openai-answer';
const unsafe='Отключите антивирус и запустите 1С от имени администратора.';
const response=(extra={})=>({decision:'answer',text:'Проверьте состояние очереди печати.',sources:[],files:[],questions:[],suggestions:[],model:'fixture',responseId:'fixture-response',usage:null,...extra});
beforeEach(()=>{
 (prisma.helpTicket.findUnique as jest.Mock).mockResolvedValue({ownerId:7,status:'OPEN',itRequested:false,members:[{userId:7,role:'OWNER',user:{isActive:true,firstName:'Тест'}}]});
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({id:7,isActive:true,deletedAt:null,profileStatus:'APPROVED',firstName:'Тест',role:{name:'employee'},currentProfileType:'EMPLOYEE'});jest.clearAllMocks();(helpOnecTools as jest.Mock).mockReturnValue(undefined);(retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'no_knowledge'}});(prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{authorId:7,text:'Не запускается приложение'}]);(prisma.$transaction as jest.Mock).mockImplementation(fn=>fn({}));(helpAIImages as jest.Mock).mockResolvedValue({images:[],skipped:0});(requestOpenAIAnswer as jest.Mock).mockResolvedValue(response());});
const prepare=(progress?:any)=>prepareHelpOpenAIAnswer(3,7,[],new AbortController().signal,progress);
test('unsafe provider advice becomes an explicit IT offer, never an instruction or automatic transfer',async()=>{
 (requestOpenAIAnswer as jest.Mock).mockResolvedValue(response({text:unsafe,files:[{name:'plan.txt',content:unsafe}]}));
 const answer=await prepare();expect(answer.text).not.toContain('Отключите антивирус');expect(answer.action).toEqual({type:'request_it'});expect(answer.files||[]).toEqual([]);expect(answer.generation?.decision).toBe('handoff');
});
test('dangerous answer drafts and public explanations are not passed to the durable progress writer',async()=>{
 const published:any[]=[];
 (requestOpenAIAnswer as jest.Mock).mockImplementation(async input=>{await input.progress({draftText:unsafe,phase:'answer'});await input.progress({activity:{id:'explanation',kind:'analysis',status:'running',label:'План',text:unsafe}});return response({text:unsafe});});
 await prepare(async(update:any)=>{published.push(update);});expect(JSON.stringify(published)).not.toContain('Отключите антивирус');expect(published.some(x=>x.draftText==='')).toBe(true);
});
test('unsafe content hidden in a file or question option is screened before attachment publication',async()=>{
 for(const extra of [{files:[{name:'steps.txt',content:unsafe}]},{questions:[{id:'q',header:'Шаг',question:'Выберите действие',options:[{label:unsafe,description:''}],multiSelect:false}]}]){
  (requestOpenAIAnswer as jest.Mock).mockResolvedValue(response(extra));const answer=await prepare();expect(answer.action).toEqual({type:'request_it'});expect(answer.files||[]).toEqual([]);expect(answer.questions||[]).toEqual([]);
 }
});
test('a real diagnostic explanation survives the model handoff instead of an unrelated no-knowledge template',async()=>{
 (requestOpenAIAnswer as jest.Mock).mockResolvedValue(response({decision:'handoff',text:'Запрос к метаданным отклонён из-за неподдерживаемого метода. Данные склада не получены.'}));
 const answer=await prepare();expect(answer.text).toContain('неподдерживаемого метода');expect(answer.text).not.toContain('По найденным материалам');expect(answer.action).toEqual({type:'request_it'});expect(answer.text).toMatch(/подтверд/iu);
});
test('an IT offer never claims completed transfer or an already connected specialist',async()=>{
 (requestOpenAIAnswer as jest.Mock).mockResolvedValue(response({decision:'handoff',text:'Проверка метаданных не завершена. Обращение уже передано в IT, специалист подключился.'}));
 const answer=await prepare();expect(answer.text).toContain('Проверка метаданных не завершена');expect(answer.text).not.toContain('уже передано');expect(answer.text).not.toContain('специалист подключился');expect(answer.text).toMatch(/подтверд/iu);
});
test('safe warnings, normal replies and completed read-only tool results retain existing behavior',async()=>{
 const text='Не отключайте защиту. Перезапустите приложение и сообщите точный текст ошибки.';(requestOpenAIAnswer as jest.Mock).mockResolvedValue(response({text}));
 const answer=await prepare();expect(answer.text).toBe(text);expect(answer.action).toBeUndefined();expect(answer.generation?.decision).toBe('answer');
});
test('network advice on an isolated greeting becomes a useful question without IT escalation',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{authorId:7,text:'Привет'}]);(requestOpenAIAnswer as jest.Mock).mockResolvedValue(response({text:'Проверьте подключение к сети и перезапустите роутер.'}));
 const answer=await prepare();expect(answer.generation?.decision).toBe('clarify');expect(answer.action).toBeUndefined();expect(answer.text).not.toContain('роутер');expect(answer.questions?.length).toBe(1);
});

test('a compacted incident remains diagnostic context after a short reply',async()=>{
 (loadHelpConversation as jest.Mock).mockResolvedValueOnce({messages:[{id:140,sequence:140,role:'user',text:'Тест',attachments:[]}],totalMessages:140,summaryCoveredMessages:139,omittedBefore:0,
  fingerprint:'a'.repeat(64),summary:{version:1,model:'fixture',coveredThrough:139,fingerprint:'b'.repeat(64),items:[{kind:'goal',text:'Не удаётся подключиться к серверу, ошибка сети в приложении.',messageIds:[1]}]}});
 const text='Проверьте подключение к сети.';(requestOpenAIAnswer as jest.Mock).mockResolvedValueOnce(response({text}));
 const answer=await prepare();expect(answer.generation?.decision).toBe('answer');expect(answer.text).toBe(text);
 const sent=(requestOpenAIAnswer as jest.Mock).mock.calls[0][0];expect(sent.messages).toEqual([expect.objectContaining({role:'user',text:'Тест',id:140,sequence:140})]);
 expect(sent.conversation.summary.items[0].messageIds).toEqual([1]);
});
test('an image retrieved later updates both draft and final diagnostic guards',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValueOnce([{authorId:7,text:'Тест'}]);
 (helpAIImages as jest.Mock).mockResolvedValueOnce({images:[{image_url:'data:image/jpeg;base64,fixture'}],skipped:0});
 const text='Проверьте подключение к сети.';const published:any[]=[];
 (requestOpenAIAnswer as jest.Mock).mockImplementationOnce(async input=>{
  await input.historyTools.readImages('historical-image',new AbortController().signal);
  await input.progress({draftText:text,phase:'answer'});return response({text});
 });
 const answer=await prepare(async (x:any)=>{published.push(x)});expect(answer.text).toBe(text);expect(answer.generation?.decision).toBe('answer');
 expect(published.some(x=>x.draftText===text)).toBe(true);
});
test('edited snapshot stops preparation before any external model call',async()=>{
 (helpContextFingerprint as jest.Mock).mockResolvedValueOnce({fingerprint:'b'.repeat(64)});
 await expect(prepare()).rejects.toThrow('HELP_CONTEXT_CHANGED');expect(requestOpenAIAnswer).not.toHaveBeenCalled();
});
test('a revoked owner stops preparation before any external model call',async()=>{
 const denied=Object.assign(Error('denied'),{code:'HELP_CONTEXT_FORBIDDEN',status:403});
 (helpContextHistoryTools as jest.Mock).mockReturnValueOnce({definitions:[],call:jest.fn(),validate:jest.fn(async()=>{throw denied})});
 await expect(prepare()).rejects.toBe(denied);expect(requestOpenAIAnswer).not.toHaveBeenCalled();
});

test('one request retains the safe prefix across independent progress updates',async()=>{
 const published:any[]=[];
 (requestOpenAIAnswer as jest.Mock).mockImplementation(async input=>{
  await input.progress({draftText:'Проверка завершена. ',phase:'answer'});
  await input.progress({draftText:'Проверка завершена. Откройте',phase:'answer'});
  await input.progress({draftText:'Проверка завершена. Откройте приложение.',phase:'answer'});
  return response();
 });
 await prepare(async(update:any)=>{published.push(update);});
 const answerUpdates=published.filter(update=>update.phase==='answer');
 expect(answerUpdates).toHaveLength(3);
 expect(answerUpdates[0].draftText).toBe('Проверка завершена. ');
 expect(answerUpdates[1]).not.toHaveProperty('draftText');
 expect(answerUpdates[1].flush).toBe(true);
 expect(answerUpdates[1].validateAppAccess).toEqual(expect.any(Function));
 expect(answerUpdates[2].draftText).toBe('Проверка завершена. Откройте приложение.');
});
