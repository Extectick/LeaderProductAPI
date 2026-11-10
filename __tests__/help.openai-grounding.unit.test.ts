jest.mock('../src/modules/help/help.onec-workspace',()=>({helpOnecWorkspace:jest.fn(async(_ticket,_owner,_through,tools)=>({tools,context:undefined}))}));
jest.mock('../src/modules/help/help.context-store',()=>({loadHelpConversation:jest.fn(async()=>({messages:[],totalMessages:0,omittedBefore:0,fingerprint:"a".repeat(64)})),helpContextFingerprint:jest.fn(async()=>({fingerprint:"a".repeat(64),totalMessages:0}))}));
jest.mock('../src/modules/help/help.context-history',()=>({helpContextHistoryTools:jest.fn(()=>({definitions:[],call:jest.fn(),validate:jest.fn(async()=>{})}))}));
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  helpMessage: { findMany: jest.fn(), findFirst: jest.fn() },helpEvent:{findMany:jest.fn().mockResolvedValue([]),findFirst:jest.fn().mockResolvedValue(null)}, user:{findUnique:jest.fn()},helpTicket:{findUnique:jest.fn()}, $transaction: jest.fn(),
} }));
jest.mock('../src/modules/help/help.knowledge', () => ({
  retrieveHelpKnowledge: jest.fn(), renderKnowledgeExcerpts: jest.fn(() => ({ sources: [] })),
  validateHelpKnowledgeSources: jest.fn(), knowledgeHandoff: jest.fn(),
}));
jest.mock('../src/modules/help/help.onec-tools', () => ({ helpOnecTools: jest.fn(), HelpOnecConnectionRequired: class extends Error {} }));
jest.mock('../src/modules/help/help.ai-images', () => ({ helpAIImages: jest.fn() }));
jest.mock('../src/modules/help/help.openai', () => ({
  openAIConfiguration: () => ({ allowGeneral: process.env.NODE_ENV === 'development' && process.env.HELP_OPENAI_ALLOW_GENERAL === 'true' }),
  requestOpenAIAnswer: jest.fn(), HelpOpenAIError: class extends Error {},
}));
import prisma from '../src/prisma/client';
import { retrieveHelpKnowledge, renderKnowledgeExcerpts, validateHelpKnowledgeSources } from '../src/modules/help/help.knowledge';
import { helpAIImages } from '../src/modules/help/help.ai-images';
import { helpOnecTools } from '../src/modules/help/help.onec-tools';
import { requestOpenAIAnswer } from '../src/modules/help/help.openai';
import { loadHelpConversation } from '../src/modules/help/help.context-store';
import * as audioModule from '../src/modules/help/help.ai-audio';
import { prepareHelpOpenAIAnswer } from '../src/modules/help/help.openai-answer';
const original = { ...process.env };
test('voice transcript reaches knowledge lookup, main conversation and 1C employee intent with the original message identity', async () => {
  const audioId='11111111-1111-4111-8111-111111111111';
  const message={id:87,sequence:7,role:'user' as const,text:'',attachments:[{id:audioId,kind:'AUDIO',name:'voice.webm',mimeType:'audio/webm',size:100}]};
  const spoken={...message,text:'[Голосовое сообщение; распознанная речь]: Покажи товары заказа 77'};
  const spy=jest.spyOn(audioModule,'helpAIAudio').mockReturnValue({enrich:jest.fn(async()=>({messages:[spoken],results:[{attachmentId:audioId,status:'transcribed' as const,text:'Покажи товары заказа 77'}]})),transcribe:jest.fn(),read:jest.fn()});
  try {
    (loadHelpConversation as jest.Mock).mockResolvedValueOnce({messages:[message],totalMessages:1,omittedBefore:0,fingerprint:'a'.repeat(64)});
    (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'no_knowledge'}});
    (helpOnecTools as jest.Mock).mockReturnValue({validate:jest.fn(),proofs:[],definitions:[]});
    (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue({text:''});
    (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{authorId:7,sequence:7,text:''}]);
    await prepareHelpOpenAIAnswer(3,7,[{id:87,sequence:7,text:''}],new AbortController().signal);
    expect(retrieveHelpKnowledge).toHaveBeenCalledWith(3,7,expect.arrayContaining([expect.objectContaining({id:87,text:spoken.text})]));
    const input=(requestOpenAIAnswer as jest.Mock).mock.calls[0][0];
    expect(input.messages).toEqual([expect.objectContaining({id:87,sequence:7,role:'user',text:spoken.text})]);
    expect(input.employeeContext.initialRequest).toContain('Покажи товары заказа 77');
    expect(input.employeeContext.statements[0].text).toContain('Покажи товары заказа 77');
  } finally {spy.mockRestore();}
});
beforeEach(() => {
 (prisma.helpTicket.findUnique as jest.Mock).mockResolvedValue({ownerId:7,status:'OPEN',itRequested:false,members:[{userId:7,role:'OWNER',user:{isActive:true,firstName:'Тест'}}]});
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({id:7,isActive:true,deletedAt:null,profileStatus:'APPROVED',firstName:'Тест',role:{name:'employee'},currentProfileType:'EMPLOYEE'});
  jest.clearAllMocks(); (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue({text:'Первоначальная задача'}); process.env = { ...original, NODE_ENV: 'development', HELP_OPENAI_ALLOW_GENERAL: 'true' };
  (helpOnecTools as jest.Mock).mockReturnValue(undefined);
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([
    { authorId: 7, text: 'Windows 11' }, { authorId: null, text: 'Какая версия Windows?' }, { authorId: 7, text: 'Не печатает принтер' },
  ]);
  (prisma.$transaction as jest.Mock).mockImplementation(fn => fn({}));
  (requestOpenAIAnswer as jest.Mock).mockResolvedValue({ decision: 'answer', text: 'Проверьте очередь печати.', sources: [], responseId: 'qa', model: 'fixture', usage: null });
});
afterAll(() => { process.env = original; });
test('source revocation during image preparation prevents disclosure to the model', async () => {
  const source = { documentId: 'd', versionId: 'v', revision: 1, title: 'Fixture', path: 'Company', sourceUrl: '/knowledge/d' };
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ hits: [{ documentId: 'd', excerpt: 'Fixture instruction' }], messages: [{ role: 'user', text: 'Help' }] });
  (renderKnowledgeExcerpts as jest.Mock).mockReturnValueOnce({ sources: [source] });
  (validateHelpKnowledgeSources as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('HELP_KNOWLEDGE_CHANGED'));
  (loadHelpConversation as jest.Mock).mockResolvedValueOnce({messages:[{id:1,sequence:1,role:'user',text:'Help',attachments:[{id:'image',kind:'IMAGE'}]}],totalMessages:1,omittedBefore:0,fingerprint:'a'.repeat(64)});
  (helpAIImages as jest.Mock).mockResolvedValueOnce({ images: [{ image_url: 'data:image/jpeg;base64,fixture' }], skipped: 0 });
  await expect(prepareHelpOpenAIAnswer(3, 7, [], new AbortController().signal, jest.fn())).rejects.toThrow('HELP_KNOWLEDGE_CHANGED');
  expect(validateHelpKnowledgeSources).toHaveBeenLastCalledWith(expect.anything(), [{ ...source, excerpt: 'Fixture instruction' }], 7);
  expect(requestOpenAIAnswer).not.toHaveBeenCalled();
});
test('general diagnostics retain ticket history and never invent sources', async () => {
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer: { handoffReason: 'no_knowledge' } });
  await expect(prepareHelpOpenAIAnswer(3, 7, [], new AbortController().signal)).resolves.toMatchObject({ mode: 'openai', sources: [] });
  expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({ allowGeneral: true, sources: [], messages: [
    { role: 'user', text: 'Не печатает принтер' }, { role: 'assistant', text: 'Какая версия Windows?' }, { role: 'user', text: 'Windows 11' },
  ] }), expect.any(AbortSignal));
});
test('finding company context does not disable otherwise permitted general reasoning', async () => {
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({hits:[],messages:[{role:'user',text:'Помоги проанализировать данные'}]});
  await prepareHelpOpenAIAnswer(3,7,[],new AbortController().signal);
  expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({allowGeneral:true}),expect.any(AbortSignal));
});
test('all normal Help runs receive requester identity without persisting another chat message',async()=>{
 (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'no_knowledge'}});
 const answer=await prepareHelpOpenAIAnswer(3,7,[],new AbortController().signal);
 expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({requesterContext:expect.objectContaining({value:expect.objectContaining({userId:7,displayName:'Тест',role:'employee',profile:expect.objectContaining({url:'leaderproduct://entity/v1/user/7'})})})}),expect.any(AbortSignal));
 expect(JSON.stringify(answer)).not.toContain('authenticated_application_user');
 const tx={user:{findUnique:jest.fn(async()=>({id:7,isActive:false}))}};
 await expect(answer.validateAppAccess!(tx as any)).rejects.toThrow('HELP_PEOPLE_UNAVAILABLE');
});

test('personal 1C context keeps original goal and an older employee selection beyond recent dialogue',async()=>{
 (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'no_knowledge'}});
 (helpOnecTools as jest.Mock).mockReturnValue({validate:jest.fn(),proofs:[]});
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue({text:'Покажи последний документ по выбранному складу'});
 (prisma.helpMessage.findMany as jest.Mock).mockImplementation(async query=>{
  if(query.where.authorId===7)return [
   ...Array.from({length:30},(_,i)=>({sequence:40-i,text:'Уточнение '+i})),
   {sequence:2,text:'На каком складе искать?\nОтвет: Склад Северный'},
  ];
  if(query.select.id)return [];
  return [{authorId:7,text:'Этот склад не ордерный'}];
 });
 await prepareHelpOpenAIAnswer(3,7,[],new AbortController().signal);
 expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({employeeContext:expect.objectContaining({
  initialRequest:'Покажи последний документ по выбранному складу',
  answers:[{question:'На каком складе искать?',answer:'Склад Северный'}],
 })}),expect.any(AbortSignal));
 expect(prisma.helpMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({where:{ticketId:3,authorId:7,kind:'TEXT',sequence:{lte:2147483647}},take:100}));
});
test.each(['user_requested'])('preserves %s even with 1C tools enabled', async handoffReason => {
  const answer = { handoffReason, text: 'Передаю в IT' };
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer });
  (helpOnecTools as jest.Mock).mockReturnValue({});
  await expect(prepareHelpOpenAIAnswer(3, 7, [], new AbortController().signal)).resolves.toBe(answer);
  expect(requestOpenAIAnswer).not.toHaveBeenCalled();
});
test('knowledge outage does not block the independent personal 1C read tools', async()=>{
 (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'source_unavailable'}});
 const validate=jest.fn(async()=>{});(helpOnecTools as jest.Mock).mockReturnValue({validate,proofs:[],definitions:[]});
 await expect(prepareHelpOpenAIAnswer(3,7,[],new AbortController().signal)).resolves.toMatchObject({mode:'openai',text:'Проверьте очередь печати.'});
 expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({sources:[],onec:expect.objectContaining({validate})}),expect.any(AbortSignal));
 expect(validate).toHaveBeenCalled();
});
test.each(['production', 'test'])('office tools do not enable general diagnostics in %s', async mode => {
  process.env.NODE_ENV = mode;
  const answer = { handoffReason: 'no_knowledge' };
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({ answer });
  await expect(prepareHelpOpenAIAnswer(3, 7, [], new AbortController().signal)).resolves.toMatchObject({mode:'openai'});
  expect(requestOpenAIAnswer).toHaveBeenCalledWith(expect.objectContaining({allowGeneral:false,officeTools:expect.objectContaining({definitions:expect.any(Array)})}),expect.any(AbortSignal));
});

test('automatic images and retained employee statements obey the captured turn ceiling',async()=>{
 (retrieveHelpKnowledge as jest.Mock).mockResolvedValueOnce({answer:{handoffReason:'no_knowledge'}});
 (helpOnecTools as jest.Mock).mockReturnValueOnce({validate:jest.fn(),proofs:[]});
 (loadHelpConversation as jest.Mock).mockResolvedValueOnce({messages:[{id:21,sequence:21,role:'user',text:'Не печатает принтер',attachments:[{id:'captured-image',kind:'IMAGE'}]}],totalMessages:1,omittedBefore:0,fingerprint:'a'.repeat(64)});
 (helpAIImages as jest.Mock).mockResolvedValueOnce({images:[],skipped:0});
 await prepareHelpOpenAIAnswer(3,7,[{sequence:22,text:'Продолжи проверку'}],new AbortController().signal,jest.fn());
 expect(helpAIImages).toHaveBeenCalledWith(3,7,expect.any(AbortSignal),{attachmentIds:['captured-image'],throughSequence:22});
 expect(prisma.helpMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{ticketId:3,authorId:7,kind:'TEXT',sequence:{lte:22}}}));
 expect(prisma.helpMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({where:{ticketId:3,authorId:7,kind:'TEXT',sequence:{lte:22}}}));
});

test('private tool evidence sink receives immutable guards without exposing results through progress or the answer',async()=>{
 (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'no_knowledge'}});
 const proof={baseKey:'qa',revision:1,binding:'PRIVATE_PROOF'};
 const validate=jest.fn(async()=>{});(helpOnecTools as jest.Mock).mockReturnValue({validate,proofs:[proof]});
 const generated={decision:'answer',text:'Проверено',sources:[],responseId:'qa',model:'fixture',usage:null};
 (requestOpenAIAnswer as jest.Mock).mockImplementationOnce(async(input)=>{
  await input.onToolEvidence('onec_execute_query',{arguments:{query:'SELECT fixture'}},JSON.stringify({data:{rowCount:1,truncated:false,data:[{item:'PRIVATE_BUSINESS_VALUE'}]}}));
  return generated;
 });
 const sink=jest.fn(async()=>{}),progress=jest.fn();
 const answer=await prepareHelpOpenAIAnswer(3,7,[{sequence:4}],new AbortController().signal,progress,sink);
 expect(sink).toHaveBeenCalledWith(expect.objectContaining({version:1,calls:[expect.objectContaining({contentComplete:true,result:{data:{rowCount:1,truncated:false,data:[{item:'PRIVATE_BUSINESS_VALUE'}]}}})]}),expect.objectContaining({validationSources:[],onecProofs:[proof],validateAppAccess:expect.any(Function),contextRevision:{throughSequence:4,fingerprint:'a'.repeat(64)}}));
 expect(validate.mock.invocationCallOrder[0]).toBeLessThan(sink.mock.invocationCallOrder[0]);
 expect(JSON.stringify(progress.mock.calls)).not.toContain('PRIVATE_BUSINESS_VALUE');expect(JSON.stringify(answer)).not.toContain('PRIVATE_BUSINESS_VALUE');
});

test('saved historical speech cannot mask failure of the current voice in progress',async()=>{
 const oldId='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222';
 const messages=[{id:80,sequence:2,role:'user' as const,text:'',attachments:[{id:oldId,kind:'AUDIO',name:'old.webm',mimeType:'audio/webm',size:100}]},{id:87,sequence:7,role:'user' as const,text:'',attachments:[{id:newId,kind:'AUDIO',name:'new.webm',mimeType:'audio/webm',size:100}]}];
 const spy=jest.spyOn(audioModule,'helpAIAudio').mockReturnValue({enrich:jest.fn(async()=>({messages,results:[{attachmentId:oldId,status:'transcribed' as const,text:'old'},{attachmentId:newId,status:'unavailable' as const}]})),transcribe:jest.fn(),read:jest.fn()});
 try{
  (loadHelpConversation as jest.Mock).mockResolvedValueOnce({messages,totalMessages:2,omittedBefore:0,fingerprint:'a'.repeat(64)});
  (retrieveHelpKnowledge as jest.Mock).mockResolvedValue({answer:{handoffReason:'user_requested'}});
  const progress=jest.fn();await prepareHelpOpenAIAnswer(3,7,[{id:87,sequence:7,text:''}],new AbortController().signal,progress);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({activity:expect.objectContaining({id:'audio',status:'failed',label:'Не удалось распознать голосовые сообщения'})}));
  expect(progress.mock.calls.some(([value])=>value.activity?.id==='audio'&&value.activity?.status==='completed')).toBe(false);
 }finally{spy.mockRestore();}
});
