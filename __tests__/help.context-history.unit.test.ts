jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpMessage:{findMany:jest.fn(),findFirst:jest.fn()},helpAttachment:{findFirst:jest.fn()}}}));
jest.mock('../src/modules/help/help.service',()=>({helpActor:jest.fn(),requireHelpTicket:jest.fn()}));
jest.mock('../src/modules/help/help.storage',()=>({helpBucket:'private-fixture',helpS3:{send:jest.fn()},helpStorageRequest:(work:()=>Promise<unknown>)=>work()}));
jest.mock('../src/modules/knowledge/knowledge.extract',()=>({extractKnowledgeText:jest.fn()}));
import {createHash} from 'node:crypto';
import prisma from '../src/prisma/client';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {helpS3} from '../src/modules/help/help.storage';
import {helpContextHistoryTools} from '../src/modules/help/help.context-history';
import {extractKnowledgeText} from '../src/modules/knowledge/knowledge.extract';
import {KnowledgeError,MAX_TEXT_CHARS} from '../src/modules/knowledge/knowledge.config';
const signal=()=>new AbortController().signal;
const message=(sequence:number,text='Сообщение '+sequence,extra={})=>({id:100+sequence,ticketId:5,sequence,authorId:7,authorRole:'USER',kind:'TEXT',text,attachments:[],...extra});
const ticket=()=>({id:5,ownerId:7,status:'OPEN',itRequested:false,members:[{role:'OWNER',userId:7}]});
function file(bytes:Buffer,extra={}){return {id:'file-1',ownerId:7,name:'notes.txt',kind:'FILE',mimeType:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),objectKey:'PRIVATE_OBJECT_KEY',messageId:101,message:message(1),...extra};}
function storage(bytes:Buffer){(helpS3.send as jest.Mock).mockImplementation(async()=>({ContentLength:bytes.length,Body:(async function*(){yield bytes;})()}));}
beforeEach(()=>{
 jest.clearAllMocks();
 (extractKnowledgeText as jest.Mock).mockReset().mockResolvedValue('Извлечённый текст документа');
 (helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:false});
 (requireHelpTicket as jest.Mock).mockImplementation(async()=>ticket());
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([]);
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(null);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(null);
});
afterEach(()=>jest.useRealTimers());

test('tools expose only bounded arguments and no model-controlled ticket/user scope',()=>{
 const definitions=helpContextHistoryTools(5,7,900).definitions as any[];
 expect(definitions.map(d=>d.name)).toEqual(['help_read_history','help_search_history','help_read_attachment']);
 for(const d of definitions){expect(d.parameters.additionalProperties).toBe(false);expect(d.parameters.properties.ticketId).toBeUndefined();expect(d.parameters.properties.ownerId).toBeUndefined();}
 expect(definitions[0].parameters.properties.limit.maximum).toBe(20);
 expect(definitions[2].parameters.properties.maxChars.maximum).toBe(8000);
});

test.each([
 ['help_read_history',{ticketId:8}],['help_read_history',{ownerId:99}],['help_read_history',{limit:21}],
 ['help_read_history',{offset:2}],['help_read_history',{maxChars:8001}],['help_search_history',{query:''}],
 ['help_search_history',{query:'x'.repeat(201)}],['help_search_history',{query:'x',limit:11}],
 ['help_read_attachment',{attachmentId:'x',objectKey:'private'}],
])('invalid or expanded scope is rejected before DB reads: %s',async(name,args)=>{
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call(name,args,signal()));
 expect(result).toEqual({available:false,error:'HELP_CONTEXT_ARGUMENTS'});expect(prisma.helpMessage.findMany).not.toHaveBeenCalled();expect(helpS3.send).not.toHaveBeenCalled();
});

test.each([
 {ownerId:99},{status:'CLOSED'},{itRequested:true},{members:[{role:'IT',userId:7}]},
])('even an administrator cannot retrieve another owner/closed/IT ticket: %j',async(change)=>{
 (helpActor as jest.Mock).mockResolvedValue({userId:7,canManage:true});
 (requireHelpTicket as jest.Mock).mockResolvedValue({...ticket(),...change});
 const tool=helpContextHistoryTools(5,7,900);
 expect(JSON.parse(await tool.call('help_read_history',{},signal()))).toEqual({available:false,error:'HELP_CONTEXT_FORBIDDEN'});
 expect(prisma.helpMessage.findMany).not.toHaveBeenCalled();
 expect(requireHelpTicket).toHaveBeenCalledWith(prisma,5,{userId:7,canManage:true},false);
 await expect(tool.validate()).rejects.toMatchObject({code:'HELP_CONTEXT_FORBIDDEN'});
});

test('reads old messages with IDs, roles and snapshot scope, without attachment storage secrets',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([
  message(1,'Старое важное условие',{attachments:[{id:'a',ownerId:7,name:'proof.csv',kind:'FILE',mimeType:'text/csv',size:3,objectKey:'SECRET_KEY',url:'SECRET_URL'},{id:'foreign',ownerId:9,name:'secret.txt'}]}),
  message(2,'Старый ответ',{authorId:null,authorRole:'SYSTEM'}),
  message(3,'Чужое обращение',{ticketId:99}),message(901,'Будущее сообщение'),message(4,'Ответ IT',{authorId:99,authorRole:'IT'}),
 ]);
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_history',{},signal()));
 expect(result.messages.map((m:any)=>[m.id,m.sequence,m.role])).toEqual([[101,1,'user'],[102,2,'assistant'],[104,4,'user']]);
 expect(result.messages[0].text).toBe('Старое важное условие');expect(result.messages[0].attachments).toHaveLength(1);
 expect(JSON.stringify(result)).not.toMatch(/SECRET|objectKey|Чужое|Будущее/);
 expect((prisma.helpMessage.findMany as jest.Mock).mock.calls[0][0].where).toEqual({ticketId:5,kind:'TEXT',sequence:{gt:0,lte:900},OR:[{authorId:7},{authorId:null,authorRole:'SYSTEM'},{authorId:{not:null},authorRole:'IT'}]});
 expect(helpActor).toHaveBeenCalledTimes(3);
});

test('history keeps whole items under the total text budget and reports the next sequence',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([message(1,'a'.repeat(7000)),message(2,'b'.repeat(7000)),message(3,'c'.repeat(7000))]);
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_history',{},signal()));
 expect(result.messages).toHaveLength(2);expect(result.messages.reduce((n:number,m:any)=>n+m.text.length,0)).toBe(14000);
 expect(result).toMatchObject({hasMore:true,nextSequence:2,nextOffset:null});
});

test('IT originals can be read and attributed, but not other participants, tickets, future rows or their private files',async()=>{
 const tools=helpContextHistoryTools(5,7,900);
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(message(4,'Отключаюсь от обращения',{authorId:99,authorRole:'IT',attachments:[{id:'f',ownerId:99,name:'private.txt'}]}));
 const result=JSON.parse(await tools.call('help_read_history',{messageId:104},signal()));
 expect(result.messages[0]).toMatchObject({id:104,role:'user',author:{kind:'it',userId:99},text:'Отключаюсь от обращения',attachments:[]});
 for(const change of [{ticketId:6},{sequence:901},{authorRole:'USER'},{authorId:null,authorRole:'IT'}]){
  (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(message(4,'Denied',{authorId:99,authorRole:'IT',...change}));
  expect(JSON.parse(await tools.call('help_read_history',{messageId:104},signal()))).toMatchObject({available:false,error:'HELP_CONTEXT_MESSAGE_NOT_FOUND'});
 }
 expect(helpS3.send).not.toHaveBeenCalled();
});

test('long messages have explicit offset continuation and never split an emoji',async()=>{
 const long='a'.repeat(7999)+'😀'+'z'.repeat(2000);(prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([message(1,long),message(2)]);
 const tools=helpContextHistoryTools(5,7,900),first=JSON.parse(await tools.call('help_read_history',{},signal()));
 expect(first.messages[0].text.length).toBe(7999);expect(first).toMatchObject({hasMore:true,nextOffset:7999,continueMessageId:101,nextSequence:0});
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(message(1,long));
 const second=JSON.parse(await tools.call('help_read_history',{messageId:101,offset:first.nextOffset},signal()));
 expect(second.messages[0].text.startsWith('😀')).toBe(true);expect(first.messages[0].text+second.messages[0].text).toBe(long);
 expect(second).toMatchObject({hasMore:false,nextOffset:null,nextSequence:1});
 expect(JSON.parse(await tools.call('help_read_history',{messageId:101,offset:8000},signal()))).toMatchObject({error:'HELP_CONTEXT_ARGUMENTS'});
});

test('search is literal and returns bounded snippets plus IDs for a complete reread',async()=>{
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([message(7,'a'.repeat(400)+'100%_склад'+'z'.repeat(1000)),message(8,'100xyzсклад')]);
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_search_history',{query:'100%_склад'},signal()));
 expect(result.results).toHaveLength(1);expect(result.results[0]).toMatchObject({id:107,sequence:7,snippetOffset:220});
 expect(result.results[0].snippet.length).toBeLessThanOrEqual(800);
 expect((prisma.helpMessage.findMany as jest.Mock).mock.calls[0][0].where.text).toEqual({contains:'100\\%\\_склад',mode:'insensitive'});
});

test('revocation while DB history is loading suppresses all late text',async()=>{
 (requireHelpTicket as jest.Mock).mockResolvedValueOnce(ticket()).mockRejectedValueOnce(Error('PRIVATE_ACCESS_ERROR'));
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([message(1,'PRIVATE_TEXT')]);
 const result=await helpContextHistoryTools(5,7,900).call('help_read_history',{},signal());
 expect(JSON.parse(result)).toEqual({available:false,error:'HELP_CONTEXT_FORBIDDEN'});expect(result).not.toContain('PRIVATE');
});

test('reads a verified UTF8 attachment in pages without object keys, URLs or caller-controlled scope',async()=>{
 const bytes=Buffer.from('a'.repeat(7999)+'😀'+'z'.repeat(1000)),row=file(bytes);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(row);storage(bytes);
 const tools=helpContextHistoryTools(5,7,900),result=JSON.parse(await tools.call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(result).toMatchObject({available:true,supported:true,offset:0,nextOffset:7999,hasMore:true});
 expect(result.text).toHaveLength(7999);expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OBJECT_KEY|objectKey|url|sha256/);
 const second=JSON.parse(await tools.call('help_read_attachment',{attachmentId:'file-1',offset:result.nextOffset},signal()));
 expect(result.text+second.text).toBe(bytes.toString('utf8'));expect(second.nextOffset).toBeNull();
 expect((prisma.helpAttachment.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({id:'file-1',ownerId:7,message:{ticketId:5,sequence:{lte:900}}});
});

test.each([{name:'image.png',kind:'IMAGE',mimeType:'image/png'},{name:'archive.zip',mimeType:'application/zip'},{name:'fake.txt',mimeType:'image/png'},{name:'fake.txt',mimeType:'application/pdf'}])('unsupported attachments are explicit and never fetched: %j',async(extra)=>{
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(Buffer.from('text'),extra));
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(result).toMatchObject({available:true,supported:false,error:'HELP_CONTEXT_ATTACHMENT_UNSUPPORTED'});expect(helpS3.send).not.toHaveBeenCalled();
});

test.each([{ownerId:8},{message:message(1,'other',{ticketId:99})},{message:message(901)},{message:null}])('unowned or out-of-snapshot attachment is not fetched: %j',async(extra)=>{
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(Buffer.from('text'),extra));
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({available:false,error:'HELP_CONTEXT_ATTACHMENT_NOT_FOUND'});
 expect(helpS3.send).not.toHaveBeenCalled();
});

test('oversized declared attachment is rejected before storage access',async()=>{
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(Buffer.from('text'),{size:256*1024+1}));
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({error:'HELP_CONTEXT_ATTACHMENT_TOO_LARGE'});
 expect(helpS3.send).not.toHaveBeenCalled();
});

test('a storage stream exceeding its declared size is bounded and disposed',async()=>{
 const body={destroy:jest.fn(),async *[Symbol.asyncIterator](){yield Buffer.alloc(256*1024);yield Buffer.from('x');}};
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(Buffer.from('text')));
 (helpS3.send as jest.Mock).mockResolvedValue({ContentLength:4,Body:body});
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({error:'HELP_CONTEXT_ATTACHMENT_TOO_LARGE'});
 expect(body.destroy).toHaveBeenCalled();
});

test('invalid UTF8 and binary content are not returned as text',async()=>{
 for(const bytes of [Buffer.from([0xff,0xfe]),Buffer.from('hello\0binary')]){
  (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes));storage(bytes);
  const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()));
  expect(result).toMatchObject({available:true,supported:false,error:'HELP_CONTEXT_ATTACHMENT_BINARY'});expect(result.text).toBeUndefined();
 }
});

test('an attachment detached or revoked while reading is never returned',async()=>{
 const bytes=Buffer.from('PRIVATE_FILE_TEXT');storage(bytes);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValueOnce(file(bytes)).mockResolvedValueOnce(null);
 const result=await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal());
 expect(JSON.parse(result)).toMatchObject({available:false,error:'HELP_CONTEXT_ATTACHMENT_CHANGED'});expect(result).not.toContain('PRIVATE');
});

test('abort stops an uncooperative history query without late text or raw reason',async()=>{
 let finish!:(value:unknown)=>void;(prisma.helpMessage.findMany as jest.Mock).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const controller=new AbortController(),result=helpContextHistoryTools(5,7,900).call('help_read_history',{},controller.signal);
 await new Promise(resolve=>setImmediate(resolve));controller.abort(Error('PRIVATE_ABORT_REASON'));
 await expect(result).rejects.toMatchObject({code:'HELP_CONTEXT_CANCELLED',message:'HELP_CONTEXT_CANCELLED'});
 finish([message(1,'LATE_TEXT')]);await Promise.resolve();
});

test('abort disposes an attachment stream and late storage bodies',async()=>{
 const bytes=Buffer.from('text');(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes));
 const body={destroy:jest.fn(),[Symbol.asyncIterator](){return this;},next:jest.fn(()=>new Promise(()=>{})),return:jest.fn(async()=>({done:true,value:undefined}))};
 (helpS3.send as jest.Mock).mockResolvedValue({ContentLength:4,Body:body});
 const controller=new AbortController(),result=helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},controller.signal);
 await new Promise(resolve=>setImmediate(resolve));expect(body.next).toHaveBeenCalled();controller.abort();
 await expect(result).rejects.toMatchObject({code:'HELP_CONTEXT_CANCELLED'});expect(body.destroy).toHaveBeenCalled();
});

test('a timed-out storage body returns only a safe unavailable code',async()=>{
 jest.useFakeTimers();const bytes=Buffer.from('text');(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes));
 const body={destroy:jest.fn(),[Symbol.asyncIterator](){return this;},next:jest.fn(()=>new Promise(()=>{})),return:jest.fn(async()=>({done:true,value:undefined}))};
 (helpS3.send as jest.Mock).mockResolvedValue({ContentLength:4,Body:body});
 const result=helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal());
 await jest.advanceTimersByTimeAsync(10000);
 expect(JSON.parse(await result)).toMatchObject({available:false,error:'HELP_CONTEXT_ATTACHMENT_TIMEOUT'});expect(body.destroy).toHaveBeenCalled();
 expect(jest.getTimerCount()).toBe(0);
});

test('JSON escaping and attachment metadata cannot exceed the history output budget',async()=>{
 const row=message(1,'"'.repeat(12000),{attachments:Array.from({length:10},(_,i)=>({id:'a'+i,ownerId:7,name:'f'.repeat(200),kind:'FILE',mimeType:'text/plain',size:10}))});
 (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([row]);
 (prisma.helpMessage.findFirst as jest.Mock).mockResolvedValue(row);
 const tools=helpContextHistoryTools(5,7,900);
 for(const args of [{},{messageId:101}]){
  const raw=await tools.call('help_read_history',args,signal()),result=JSON.parse(raw);
  expect(raw.length).toBeLessThanOrEqual(16000);expect(result.hasMore).toBe(true);expect(result.nextOffset).toBeGreaterThan(0);
 }
});

test('a storage response arriving after cancellation releases its unread body',async()=>{
 const bytes=Buffer.from('text');(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes));
 let finish!:(value:unknown)=>void;(helpS3.send as jest.Mock).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const controller=new AbortController(),result=helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},controller.signal);
 await new Promise(resolve=>setImmediate(resolve));controller.abort();
 await expect(result).rejects.toMatchObject({code:'HELP_CONTEXT_CANCELLED'});
 const body={destroy:jest.fn()};finish({ContentLength:4,Body:body});await Promise.resolve();await Promise.resolve();
 expect(body.destroy).toHaveBeenCalled();
});

const documents=[
 {name:'notes.pdf',mimeType:'application/pdf',extension:'pdf',bytes:Buffer.from('%PDF-1.7\nfixture')},
 {name:'notes.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',extension:'docx',bytes:Buffer.from([80,75,3,4,10,20,30])},
 {name:'notes.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:'xlsx',bytes:Buffer.from([80,75,3,4,10,20,30])},
 {name:'uploaded.xlsx',mimeType:'application/zip',extension:'xlsx',bytes:Buffer.from([80,75,3,4,10,20,30])},
 {name:'uploaded.docx',mimeType:'application/zip',extension:'docx',bytes:Buffer.from([80,75,3,4,10,20,30])},
];
test.each(documents)('delegates valid $extension attachments to the isolated extractor and pages extracted text',async(doc)=>{
 const text='Извлечённый текст '.repeat(600),row=file(doc.bytes,{name:doc.name,mimeType:doc.mimeType});
 (extractKnowledgeText as jest.Mock).mockResolvedValue(text);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(row);storage(doc.bytes);
 const tools=helpContextHistoryTools(5,7,900);
 const first=JSON.parse(await tools.call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(first).toMatchObject({available:true,supported:true,hasMore:true,nextOffset:8000});
 expect(first.text).toBe(text.slice(0,8000));
 expect(extractKnowledgeText).toHaveBeenCalledWith(doc.bytes,doc.extension,expect.any(AbortSignal));
 const second=JSON.parse(await tools.call('help_read_attachment',{attachmentId:'file-1',offset:first.nextOffset},signal()));
 expect(first.text+second.text).toBe(text);expect(second.nextOffset).toBeNull();
 expect(JSON.stringify(first)).not.toMatch(/PRIVATE_OBJECT_KEY|objectKey|url|sha256/);
});

test.each([
 {name:'notes.pdf',mimeType:'text/plain'},
 {name:'notes.pdf',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
 {name:'notes.docx',mimeType:'application/pdf'},
 {name:'notes.xlsx',mimeType:'text/plain'},
 {name:'notes.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
])('a MIME/extension mismatch is not downloaded or parsed: %j',async(meta)=>{
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(Buffer.from('fixture'),meta));
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(result).toMatchObject({supported:false,error:'HELP_CONTEXT_ATTACHMENT_UNSUPPORTED'});
 expect(helpS3.send).not.toHaveBeenCalled();expect(extractKnowledgeText).not.toHaveBeenCalled();
});

test.each(documents)('a wrong $extension magic is rejected before extraction',async(doc)=>{
 const bytes=Buffer.from('not the expected document');
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes,{name:doc.name,mimeType:doc.mimeType}));storage(bytes);
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(result).toMatchObject({available:true,supported:false,error:'HELP_CONTEXT_ATTACHMENT_INVALID_DOCUMENT'});
 expect(extractKnowledgeText).not.toHaveBeenCalled();
});

test.each([
 ['NO_TEXT_OCR_REQUIRED','HELP_CONTEXT_ATTACHMENT_OCR_REQUIRED'],
 ['INVALID_DOCUMENT','HELP_CONTEXT_ATTACHMENT_INVALID_DOCUMENT'],
 ['EXTRACTION_FAILED','HELP_CONTEXT_ATTACHMENT_INVALID_DOCUMENT'],
])('extraction %s produces an explicit safe unavailable-text result',async(code,error)=>{
 const doc=documents[0];(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType}));storage(doc.bytes);
 (extractKnowledgeText as jest.Mock).mockRejectedValue(new KnowledgeError(422,code,'PRIVATE_PARSER_DIAGNOSTIC'));
 const raw=await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal());
 expect(JSON.parse(raw)).toMatchObject({available:true,supported:false,error});expect(raw).not.toContain('PRIVATE');
});

test('document bytes may exceed the text limit but cannot exceed 10 MiB',async()=>{
 const doc=documents[0],bytes=Buffer.concat([doc.bytes,Buffer.alloc(300000)]);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes,{name:doc.name,mimeType:doc.mimeType}));storage(bytes);
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({available:true,supported:true});
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType,size:10*1024*1024+1}));
 const calls=(helpS3.send as jest.Mock).mock.calls.length;
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({error:'HELP_CONTEXT_ATTACHMENT_TOO_LARGE'});
 expect(helpS3.send).toHaveBeenCalledTimes(calls);
});

test('oversized extracted text is rejected even if the extractor violates its contract',async()=>{
 const doc=documents[0];(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType}));storage(doc.bytes);
 (extractKnowledgeText as jest.Mock).mockResolvedValue('x'.repeat(MAX_TEXT_CHARS+1));
 expect(JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()))).toMatchObject({error:'HELP_CONTEXT_ATTACHMENT_TOO_LARGE'});
});

test('access revoked during extraction suppresses the extracted text',async()=>{
 const doc=documents[0];(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType}));storage(doc.bytes);
 (extractKnowledgeText as jest.Mock).mockImplementation(async()=>{
  (requireHelpTicket as jest.Mock).mockRejectedValue(Error('PRIVATE_ACCESS_DIAGNOSTIC'));return 'PRIVATE_EXTRACTED_TEXT';
 });
 const raw=await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal());
 expect(JSON.parse(raw)).toEqual({available:false,error:'HELP_CONTEXT_FORBIDDEN'});expect(raw).not.toContain('PRIVATE');
});

test('caller abort reaches the extractor signal and no late extracted text is returned',async()=>{
 const doc=documents[0];(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType}));storage(doc.bytes);
 let extractorSignal!:AbortSignal,finish!:(value:string)=>void;
 (extractKnowledgeText as jest.Mock).mockImplementation((_b,_e,s)=>{extractorSignal=s;return new Promise(resolve=>{finish=resolve;});});
 const controller=new AbortController(),result=helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},controller.signal);
 await new Promise(resolve=>setImmediate(resolve));expect(extractorSignal.aborted).toBe(false);controller.abort();
 await expect(result).rejects.toMatchObject({code:'HELP_CONTEXT_CANCELLED'});expect(extractorSignal.aborted).toBe(true);
 finish('LATE_PRIVATE_TEXT');await Promise.resolve();
});

test('a document extraction deadline aborts the child-facing signal',async()=>{
 jest.useFakeTimers();const doc=documents[0];(prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(doc.bytes,{name:doc.name,mimeType:doc.mimeType}));storage(doc.bytes);
 let extractorSignal!:AbortSignal;(extractKnowledgeText as jest.Mock).mockImplementation((_b,_e,s)=>{extractorSignal=s;return new Promise(()=>{});});
 const result=helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal());
 await jest.advanceTimersByTimeAsync(25000);
 expect(JSON.parse(await result)).toMatchObject({available:false,error:'HELP_CONTEXT_ATTACHMENT_TIMEOUT'});expect(extractorSignal.aborted).toBe(true);
 expect(jest.getTimerCount()).toBe(0);
});

test('a foreign XLSX never reaches storage or the Office parser',async()=>{
 const bytes=Buffer.from([80,75,3,4,10,20,30]);
 (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file(bytes,{name:'foreign.xlsx',mimeType:'application/zip',ownerId:8}));
 const result=JSON.parse(await helpContextHistoryTools(5,7,900).call('help_read_attachment',{attachmentId:'file-1'},signal()));
 expect(result).toMatchObject({available:false,error:'HELP_CONTEXT_ATTACHMENT_NOT_FOUND'});
 expect(helpS3.send).not.toHaveBeenCalled();expect(extractKnowledgeText).not.toHaveBeenCalled();
});
