'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { sanitizeSnapshot, sanitizeAnalysisEvidence, containsSensitiveText } = require('./privacy.cjs');
function snapshot(text = 'Не печатает принтер') {
  return { ticketId: 1, sourceVersion: 'a'.repeat(64), status: 'CLOSED', closedAt: '2026-11-05T00:00:00Z', itRequested: false,
    updatedAt: '2026-11-05T00:00:00Z', lastEventId: 3, truncated: false,
    messages: [{ id: 1, sequence: 1, authorRole: 'OWNER', kind: 'TEXT', text, rating: null, createdAt: '2026-11-05T00:00:00Z' }], jobs: [] };
}
test('whitelist removes user identities, keys, files and context and is idempotent', () => {
  const input = snapshot(); input.owner = { name: 'PRIVATE NAME' }; input.context = 'PRIVATE CONTEXT';
  input.messages[0].authorId = 7; input.messages[0].attachments = [{ objectKey: 'PRIVATE KEY' }];
  const result = sanitizeSnapshot(input), json = JSON.stringify(result);
  for (const value of ['PRIVATE NAME', 'PRIVATE CONTEXT', 'PRIVATE KEY', 'authorId']) assert.equal(json.includes(value), false);
  assert.deepEqual(result.messages[0].attachments, []); assert.equal(result.messages[0].metadataIncluded, false);
  assert.deepEqual(sanitizeSnapshot(result), result); assert.equal(result.sourceVersion, input.sourceVersion);
});
test('credential-bearing messages are suppressed whole and cannot become complete evidence', () => {
  for (const text of ['password=fixture-private', 'Пароль: fixture-private', 'Authorization: Bearer fixture-private', 'postgres://user:fixture-private@fixture.invalid/db', 'sk-fixture-private-key-12345']) {
    const result = sanitizeSnapshot(snapshot('Prefix ' + text + ' suffix'));
    assert.equal(result.messages[0].text, '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]'); assert.equal(result.truncated, true);
    assert.equal(JSON.stringify(result).includes('fixture-private'), false);
    assert.equal(containsSensitiveText(text), true);
  }
});
test('redacts contact endpoints before model and screens them after model', () => {
  const result = sanitizeSnapshot(snapshot('Напишите qa@example.org или +7 (900) 123-45-67. Сервер 192.168.1.2, https://fixture.invalid/path.'));
  assert.equal(result.privacyFlags.includes('contact_redacted'), true);
  assert.equal(containsSensitiveText(result.messages[0].text), false);
  assert.equal(result.messages[0].text.includes('example.org'), false);
});
test('redacts common Russian full names and formatted domestic phone numbers', () => {
  const safe = sanitizeSnapshot(snapshot('Ответил Иван Иванов, телефон 8 (900) 123-45-67.'));
  assert.equal(safe.messages[0].text.includes('Иван Иванов'), false);
  assert.equal(safe.messages[0].text.includes('123-45-67'), false);
  assert.equal(containsSensitiveText(safe.messages[0].text), false);
});
test('bounded text/messages and duplicate IDs cannot silently look complete', () => {
  const input = snapshot('x'.repeat(5000)); assert.equal(sanitizeSnapshot(input).messages[0].text.length, 4000);
  assert.equal(sanitizeSnapshot(input).truncated, true);
  input.messages.push({ ...input.messages[0] }); assert.throws(() => sanitizeSnapshot(input), { code: 'HELP_LEARNING_INVALID_SNAPSHOT' });
  const many = snapshot(); many.messages = Array.from({ length: 81 }, (_, i) => ({ ...many.messages[0], id: i + 1, sequence: i + 1 }));
  assert.equal(sanitizeSnapshot(many).messages.length, 80); assert.equal(sanitizeSnapshot(many).truncated, true);
});
test('normalization catches invisible-character credential labels and rejects malformed versions', () => {
  assert.equal(sanitizeSnapshot(snapshot('pass\u200Bword=fixture-private')).truncated, true);
  assert.throws(() => sanitizeSnapshot({ ...snapshot(), sourceVersion: '../unsafe' }), { code: 'HELP_LEARNING_INVALID_SNAPSHOT' });
});
test('account-labelled credentials and SSH bare passwords suppress the whole message', () => {
  for (const text of ['Для теста можно использовать учетку: fixture_user FictionPass_73',
    'Учётная запись: fixture_user FictionPass_73', 'Учётные данные: fixture_user FictionPass_73',
    'SSH fixture_user@192.0.2.10 FictionPass_73']) {
    const result = sanitizeSnapshot(snapshot(text));
    assert.equal(result.truncated, true); assert.equal(JSON.stringify(result).includes('FictionPass_73'), false);
    assert.equal(containsSensitiveText(text), true);
  }
  const safe = sanitizeSnapshot(snapshot('Подключите учётную запись через профиль.'));
  assert.equal(safe.truncated, false); assert.equal(containsSensitiveText(safe.messages[0].text), false);
});
test('a bare credential reply following a request is suppressed before model input', () => {
  const input = snapshot('Укажите логин и пароль для тестирования.');
  input.messages.push({ ...input.messages[0], id: 2, sequence: 2, text: 'fixture_user FictionPass_73' });
  const safe = sanitizeSnapshot(input);
  assert.equal(safe.messages[1].text, '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]');
  assert.equal(safe.truncated, true); assert.equal(JSON.stringify(safe).includes('FictionPass_73'), false);
});
test('bounded attachment metadata proves only server publication and strips names, keys, URLs, hashes and content', () => {
  const input=snapshot();Object.assign(input.messages[0],{metadataIncluded:true,attachments:[{
    kind:'FILE',extension:'.txt',size:59,mimeType:'text/plain',name:'PRIVATE_NAME.txt',objectKey:'PRIVATE_OBJECT_KEY',
    url:'https://private.invalid/download',sha256:'PRIVATE_HASH',ownerId:99,content:'password=PRIVATE_CREDENTIAL',downloaded:true,read:true,
  }]});
  const safe=sanitizeSnapshot(input),item=safe.messages[0];
  assert.equal(item.metadataIncluded,true);assert.equal(item.attachmentsTruncated,false);
  assert.deepEqual(item.attachments,[{kind:'FILE',extension:'.txt',size:59,mimeType:'text/plain'}]);
  const json=JSON.stringify(safe);
  for(const marker of ['PRIVATE_','ownerId','objectKey','sha256','downloaded','"read"','https://'])assert.equal(json.includes(marker),false);
  assert.deepEqual(sanitizeSnapshot(safe),safe);
});
test('old snapshots keep attachment and activity evidence unknown rather than asserting absence',()=>{
  const safe=sanitizeSnapshot(snapshot()).messages[0];
  assert.equal(safe.metadataIncluded,false);assert.deepEqual(safe.attachments,[]);
  assert.equal(safe.activityMetadataIncluded,false);assert.deepEqual(safe.activities,[]);assert.equal(safe.imagesPrepared,null);
  const input=snapshot();input.messages[0].imagesPrepared=true;
  assert.equal(sanitizeSnapshot(input).messages[0].imagesPrepared,null);
});
test('metadata arrays and enums are bounded and cannot smuggle private strings',()=>{
  const input=snapshot();Object.assign(input.messages[0],{metadataIncluded:true,attachments:Array.from({length:6},()=>({kind:'password=PRIVATE_SECRET',extension:'.PRIVATE_SECRET',size:'PRIVATE_SECRET',mimeType:'https://PRIVATE_SECRET'})),
    activityMetadataIncluded:true,activities:Array.from({length:10},()=>({toolName:'PRIVATE_SECRET',status:'PRIVATE_SECRET',errorCode:'PRIVATE_SECRET',label:'PRIVATE_SECRET',args:{password:'PRIVATE_SECRET'}})),imagesPrepared:true});
  const safe=sanitizeSnapshot(input),item=safe.messages[0];
  assert.equal(item.attachments.length,4);assert.equal(item.activities.length,8);assert.equal(item.attachmentsTruncated,true);assert.equal(item.activitiesTruncated,true);
  assert.equal(safe.truncated,true);assert.equal(JSON.stringify(safe).includes('PRIVATE_SECRET'),false);
  assert.deepEqual(item.attachments[0],{kind:'OTHER',extension:null,size:null,mimeType:null});
  assert.deepEqual(item.activities[0],{toolName:null,status:'unknown',errorCode:null});
});
test('tool and image evidence excludes assistant text, args, labels, results and raw state',()=>{
  const input=snapshot();Object.assign(input.messages[0],{activityMetadataIncluded:true,activities:[{
    toolName:'onec_execute_query',status:'failed',errorCode:'ONEC_TOOL_ARGUMENTS',id:'PRIVATE_ID',label:'PRIVATE_LABEL',text:'PRIVATE_TEXT',args:{password:'PRIVATE_PASSWORD'},result:'PRIVATE_RESULT',
  }],imagesPrepared:true,assistantState:{draftText:'PRIVATE_DRAFT',activities:[{image_url:'https://PRIVATE_IMAGE'}]}});
  const safe=sanitizeSnapshot(input),item=safe.messages[0];
  assert.deepEqual(item.activities,[{toolName:'onec_execute_query',status:'failed',errorCode:'ONEC_TOOL_ARGUMENTS'}]);assert.equal(item.imagesPrepared,true);
  assert.equal(JSON.stringify(safe).includes('PRIVATE_'),false);
});

test('serialized escaped text and dense metadata fit the model envelope and remain explicitly truncated',()=>{
 const input=snapshot();input.messages=Array.from({length:80},(_,i)=>({...input.messages[0],id:i+1,sequence:i+1,text:'"'.repeat(4000),metadataIncluded:true,activityMetadataIncluded:true,
  attachments:Array.from({length:4},()=>({kind:'FILE',extension:'.json',size:123,mimeType:'application/json'})),activities:Array.from({length:8},()=>({toolName:'onec_get_metadata_structure',status:'completed',errorCode:null}))}));
 const safe=sanitizeSnapshot(input);assert.ok(JSON.stringify(safe).length<=180000);assert.equal(safe.truncated,true);assert.ok(safe.privacyFlags.includes('text_truncated'));assert.equal(safe.messages.length,80);assert.deepEqual(sanitizeSnapshot(safe),safe);
});

test('office metadata and question shape are whitelisted without text, labels or arguments',()=>{
 const input=snapshot();input.messages[0]={...input.messages[0],authorRole:'ASSISTANT',textComplete:true,assistantStatus:'completed',metadataIncluded:true,
  attachments:[{kind:'FILE',extension:'.xlsx',size:2048,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',name:'PRIVATE_NAME'}],questionsMetadataIncluded:true,
  questions:[{multiSelect:true,optionCount:3,question:'PRIVATE_QUESTION',options:[{label:'PRIVATE_LABEL'}]}]};
 const safe=sanitizeSnapshot(input);assert.equal(safe.messages[0].attachments[0].extension,'.xlsx');assert.deepEqual(safe.messages[0].questions,[{multiSelect:true,optionCount:3}]);
 assert.equal(safe.messages[0].textComplete,true);assert.ok(!JSON.stringify(safe).includes('PRIVATE_'));assert.deepEqual(sanitizeSnapshot(safe),safe);
 const legacy=sanitizeSnapshot(snapshot());assert.equal(legacy.messages[0].textComplete,null);assert.equal(legacy.messages[0].questionsMetadataIncluded,false);
});
const attachmentId='11111111-2222-4333-8444-555555555555';
function evidenceFile(patch={}){return {messageId:1,attachmentId,sha256:'b'.repeat(64),extension:'.xlsx',format:'xlsx',status:'parsed',complete:true,
 sheets:[{name:'Данные',rowCount:3,dataRowCount:2,columnCount:3,headerRow:1,headerStatus:'first_nonempty_row',headers:['Товар','Количество','Цена'],headersComplete:true,
  rows:[['Позиция А',0,15.5],['Позиция Б',-2,20]],sampleRowNumbers:[2,3],rowsComplete:true,layout:'rows_and_columns'}],...patch};}
function toolEvidence(patch={}){return {messageId:1,index:0,toolName:'onec_execute_query',args:{query:'ВЫБРАТЬ Количество ИЗ Остатки'},result:{columns:['Количество'],rows:[[0],[-2]]},status:'completed',contentComplete:true,redacted:false,sourceTruncated:false,...patch};}
test('analysis evidence keeps genuine cell types, zero-result structure and recorded tool bodies with stable source identities',()=>{
 const input=snapshot();input.projectionVersion=4;input.analysisEvidence={version:1,files:[evidenceFile()],toolCalls:[toolEvidence()],filesTruncated:false,toolsTruncated:false,rawState:'PRIVATE_RAW'};
 const safe=sanitizeSnapshot(input),e=safe.analysisEvidence;assert.equal(safe.projectionVersion,4);assert.equal(e.files[0].attachmentId,attachmentId);assert.equal(e.files[0].sha256,'b'.repeat(64));
 assert.deepEqual(e.files[0].sheets[0].rows,[['Позиция А',0,15.5],['Позиция Б',-2,20]]);assert.equal(e.files[0].complete,true);assert.deepEqual(e.toolCalls[0].result.rows,[[0],[-2]]);assert.equal(e.toolCalls[0].contentComplete,true);
 assert.ok(!JSON.stringify(safe).includes('PRIVATE_RAW'));assert.deepEqual(sanitizeSnapshot(safe),safe);
 const zero=sanitizeAnalysisEvidence({version:1,files:[evidenceFile({sheets:[{headers:['Товар'],rows:[],rowCount:1,columnCount:1,dataRowCount:0,rowsComplete:true,headersComplete:true}]})],toolCalls:[]},{messageIds:[1]});
 assert.equal(zero.files[0].sheets[0].dataRowCount,0);assert.equal(zero.files[0].sheets[0].rowsComplete,true);assert.equal(zero.files[0].complete,true);
});
test('evidence fields, nested serialized JSON, key-value records and sensitive columns are minimized before inference',()=>{
 const file=evidenceFile({filename:'PRIVATE_FILENAME',objectKey:'PRIVATE_OBJECT',url:'PRIVATE_URL',sheets:[{name:'Данные',headers:['Товар','Логин','Цена'],rows:[['Позиция','PRIVATE_LOGIN',10]],rowCount:2,columnCount:3,rowsComplete:true,headersComplete:true}]});
 const tool=toolEvidence({scope:'latest_attempt',args:{binding:{login:'PRIVATE_BINDING'},query:'ВЫБРАТЬ Количество'},result:JSON.stringify({headers:['Поле','Значение'],rows:[['Password','PRIVATE_PASSWORD']],nested:{authorization:'PRIVATE_AUTH',objectKey:'PRIVATE_KEY',userName:'PRIVATE_NAME','pass\u0000word':'PRIVATE_DISGUISED',email:'qa@example.org'},text:'Иван Иванов https://internal.invalid/path'})});
 const result=sanitizeAnalysisEvidence({version:1,files:[file],toolCalls:[tool]},{messageIds:[1]}),json=JSON.stringify(result);
 for(const marker of ['PRIVATE_','example.org','internal.invalid','Иван Иванов'])assert.ok(!json.includes(marker),marker);
 assert.equal(result.files[0].sheets[0].rows[0][1],'[СКРЫТО]');assert.equal(result.files[0].redacted,true);assert.equal(result.files[0].complete,false);assert.equal(result.files[0].sheets[0].rowsComplete,false);
 assert.equal(result.toolCalls[0].result.rows[0][1],'[СКРЫТО]');assert.equal(result.toolCalls[0].contentComplete,false);assert.equal(result.toolCalls[0].redacted,true);
 assert.equal(result.toolCalls[0].scope,'latest_attempt');
 assert.deepEqual(sanitizeAnalysisEvidence(result,{messageIds:[1]}),result);
});
test('evidence missing historical bodies, unsupported content and truncation remain explicitly unknown or partial',()=>{
 const result=sanitizeAnalysisEvidence({version:1,files:[evidenceFile({format:'pdf',extension:'.pdf',status:'unsupported',complete:false,reason:'OCR_REQUIRED',sheets:undefined})],toolCalls:[toolEvidence({result:null,sourceTruncated:null,contentComplete:false}),toolEvidence({index:1,sourceTruncated:true,contentComplete:true})],filesTruncated:true,toolsTruncated:false},{messageIds:[1]});
 assert.equal(result.files[0].reason,'OCR_REQUIRED');assert.equal(result.files[0].complete,false);assert.equal(result.toolCalls[0].sourceTruncated,null);assert.equal(result.toolCalls[0].contentComplete,false);assert.equal(result.toolCalls[1].contentComplete,false);assert.equal(result.filesTruncated,true);
 assert.equal(sanitizeAnalysisEvidence(undefined,{messageIds:[1]}),null);assert.equal(sanitizeSnapshot(snapshot()).analysisEvidence,undefined);
});
test('evidence may reference only present retained messages; malformed identities and duplicate records do not become proof',()=>{
 const result=sanitizeAnalysisEvidence({version:1,files:[evidenceFile({messageId:9}),evidenceFile(),evidenceFile(),evidenceFile({attachmentId:'../bad'})],toolCalls:[toolEvidence({messageId:9}),toolEvidence(),toolEvidence(),toolEvidence({toolName:'password=PRIVATE'})]},{messageIds:[1]});
 assert.equal(result.files.length,1);assert.equal(result.toolCalls.length,1);assert.equal(result.filesTruncated,true);assert.equal(result.toolsTruncated,true);
 const input=snapshot();input.messages=Array.from({length:81},(_,i)=>({...input.messages[0],id:i+1,sequence:i+1}));input.analysisEvidence={version:1,files:[evidenceFile()],toolCalls:[toolEvidence()]};
 const safe=sanitizeSnapshot(input);assert.equal(safe.analysisEvidence.files.length,0);assert.equal(safe.analysisEvidence.toolCalls.length,0);
});
test('bounded evidence retains shape with explicit incomplete samples and the Unicode snapshot fits its byte envelope',()=>{
 const huge=evidenceFile({sheets:[{name:'Данные',headers:['Товар','Описание','Остаток'],rowCount:81,dataRowCount:80,columnCount:3,rows:Array.from({length:80},()=>['Позиция','Ж'.repeat(1900),0]),rowsComplete:true,headersComplete:true}]});
 const e=sanitizeAnalysisEvidence({version:1,files:[huge],toolCalls:[toolEvidence()]},{messageIds:[1]});assert.ok(Buffer.byteLength(JSON.stringify(e))<=64000);assert.equal(e.files[0].complete,false);assert.equal(e.files[0].sheets[0].rowsComplete,false);assert.ok(e.files[0].sheets[0].rows.length<80);assert.equal(e.files[0].sheets[0].dataRowCount,80);
 const input=snapshot();input.messages=Array.from({length:80},(_,i)=>({...input.messages[0],id:i+1,sequence:i+1,text:'Ж'.repeat(4000)}));input.analysisEvidence=e;
 const safe=sanitizeSnapshot(input);assert.ok(Buffer.byteLength(JSON.stringify(safe))<=180000);assert.ok(safe.privacyFlags.includes('analysis_evidence_truncated'));assert.deepEqual(sanitizeSnapshot(safe),safe);
});
test('recursive evidence limits fail closed on excessive depth, array count and non-JSON objects',()=>{
 const nested={};let value=nested;for(let i=0;i<20;i++)value=value.next={};
 const result=sanitizeAnalysisEvidence({version:1,files:[],toolCalls:[toolEvidence({result:{nested,items:Array(300).fill(1),buffer:Buffer.from('PRIVATE_BINARY')}})]},{messageIds:new Set([1])});
 assert.equal(result.toolCalls[0].sourceTruncated,true);assert.equal(result.toolCalls[0].contentComplete,false);assert.equal(result.toolCalls[0].result.items.length,80);assert.equal(result.toolCalls[0].result.buffer,null);assert.ok(!JSON.stringify(result).includes('PRIVATE_BINARY'));
});
test('spreadsheet cell objects whitelist formulas/cache/errors rather than arbitrary parser metadata',()=>{
 const file=evidenceFile({sheets:[{name:'Данные',headers:['Формула','Ошибка','Значение'],rows:[[{formula:'A1+1',external:false,cachedValue:0,privateState:'PRIVATE_METADATA'},{error:'#N/A'},{privateState:'PRIVATE_UNKNOWN'}]],rowCount:2,columnCount:3,rowsComplete:true,headersComplete:true}]});
 const safe=sanitizeAnalysisEvidence({version:1,files:[file],toolCalls:[]},{messageIds:[1]});assert.ok(!JSON.stringify(safe).includes('PRIVATE_'));assert.deepEqual(safe.files[0].sheets[0].rows[0],[{formula:'A1+1',external:false,cachedValue:0},{error:'#N/A'},null]);assert.equal(safe.files[0].complete,false);assert.equal(safe.files[0].sourceTruncated,true);assert.deepEqual(sanitizeAnalysisEvidence(safe,{messageIds:[1]}),safe);
});
test('persisted tool result wrappers retain returned/failed status, latest-attempt scope and nullable row counts',()=>{
 const raw={version:1,files:[],toolCalls:[toolEvidence({status:'returned',rowCount:0,scope:'latest_attempt'}),toolEvidence({index:1,status:'failed',rowCount:null,result:null,errorCode:'ONEC_TIMEOUT',sourceTruncated:null,scope:'latest_attempt'})]};
 const e=sanitizeAnalysisEvidence(raw,{messageIds:[1]});assert.equal(e.toolCalls[0].status,'returned');assert.equal(e.toolCalls[0].rowCount,0);assert.equal(e.toolCalls[0].scope,'latest_attempt');assert.equal(e.toolCalls[1].status,'failed');assert.equal(e.toolCalls[1].rowCount,null);assert.equal(e.toolCalls[1].errorCode,'ONEC_TIMEOUT');assert.equal(e.toolCalls[1].contentComplete,false);assert.deepEqual(sanitizeAnalysisEvidence(e,{messageIds:[1]}),e);
});
test('large tool bodies retain the wrapper, totals and a clearly incomplete sample within the evidence budget',()=>{
 const raw={version:1,files:[],toolCalls:[toolEvidence({status:'returned',rowCount:1000,result:{columns:['Описание','Количество'],rows:Array.from({length:80},()=>['Ж'.repeat(1900),0])}})]};
 const e=sanitizeAnalysisEvidence(raw,{messageIds:[1]});assert.ok(Buffer.byteLength(JSON.stringify(e))<=64000);assert.equal(e.toolCalls.length,1);assert.equal(e.toolCalls[0].status,'returned');assert.equal(e.toolCalls[0].rowCount,1000);assert.ok(e.toolCalls[0].result.rows.length<80);assert.equal(e.toolCalls[0].result.rows[0][1],0);assert.equal(e.toolCalls[0].sourceTruncated,true);assert.equal(e.toolCalls[0].contentComplete,false);assert.equal(e.toolsTruncated,true);assert.deepEqual(sanitizeAnalysisEvidence(e,{messageIds:[1]}),e);
});
test('historical encoded tool bodies suppress credentials using case-insensitive column descriptors and key-value labels',()=>{
 for(const table of [
  {columns:[{name:'Товар'},{field:'Password'},{name:'Количество'}],rows:[['Хлеб','BARE_CREDENTIAL',0]]},
  {fields:[{Name:'Товар'},{Caption:'Имя пользователя'},{Name:'Количество'}],values:[['Хлеб','BARE_CREDENTIAL',0]]},
  {headers:[{Key:'Товар'},{Title:'pass\u200bword'},{Name:'Количество'}],records:[['Хлеб','BARE_CREDENTIAL',0]]},
  {headers:['Параметр','Значение'],rows:[['Логин','BARE_CREDENTIAL'],['Остаток',0]]},
 ]){
  const input={version:1,files:[],toolCalls:[toolEvidence({result:JSON.stringify({data:JSON.stringify({...table,rowCount:1,truncated:false})})})]};
  const e=sanitizeAnalysisEvidence(input,{messageIds:[1]});assert.ok(!JSON.stringify(e).includes('BARE_CREDENTIAL'));assert.ok(JSON.stringify(e).includes('0]'));assert.equal(e.toolCalls[0].redacted,true);assert.equal(e.toolCalls[0].contentComplete,false);assert.deepEqual(sanitizeAnalysisEvidence(e,{messageIds:[1]}),e);
 }
});
