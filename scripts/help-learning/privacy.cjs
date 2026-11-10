'use strict';

// Heuristic minimization, not a promise of complete anonymization. Names and
// business identifiers in prose need a human privacy review before wider use.
const SECRET = /(?:(?:уч[её]тк[ауеи]|уч[её]тн(?:ая|ую|ой|ые|ых)\s+(?:запис[ьи]|данные|данных)|credentials)\s*[:=]\s*\S+|\b[A-Za-z0-9_.-]+@(?:\d{1,3}\.){3}\d{1,3}\s+\S{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=-]{6,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:парол[ьяеи]|password|passwd|pwd|логин|login|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|authorization|cookie|client[ _-]?secret|код\s+подтверждения)\s*[:=]\s*\S+|(?:мой\s+пароль|my\s+password)\s+\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@)/iu;
const CONTACT = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:\+\d[\d ()-]{8,}\d)|\b\d{11,19}\b|\b(?:https?|wss?|ftp|s3|file):\/\/[^\s<>"']+|\\\\[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|ru|org|net|io|local|internal)\b)/iu;
const CREDENTIAL_REQUEST = /(?:(?:пришлите|укажите|введите|напишите|отправьте|сообщите|назовите|нужен|нужны|send|enter|provide|need).{0,100}(?:парол|логин|уч[её]т|credentials|password|login)|(?:логин|login).{0,40}(?:парол|password)|(?:пароль|password|логин|login)\s*\?)/iu;
const CREDENTIAL_PAIR = /^[A-Za-z0-9_.@\\/-]{1,128}\s+\S{4,128}$/u;
const PERSONAL = /(?:\b[78](?:[ ()-]*\d){10}\b|[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?:\s+[А-ЯЁ][а-яё]{2,})?)/u;
const FLAGS = new Set(['credentials_suppressed', 'contact_redacted', 'text_truncated', 'messages_truncated', 'jobs_truncated', 'attachments_truncated', 'activities_truncated', 'questions_truncated','analysis_evidence_truncated','analysis_evidence_redacted']);
const EXTENSIONS = new Set(['.txt','.md','.csv','.json','.xlsx','.docx','.png','.jpg','.jpeg','.gif','.webp','.avif','.heic','.heif','.bmp','.tif','.tiff']);
const MIME_TYPES = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','text/csv','application/json','application/pdf','application/zip','application/octet-stream',
  'image/png','image/jpeg','image/gif','image/webp','image/avif','image/heic','image/heif','image/bmp','image/tiff','audio/mp4','audio/mpeg','audio/wav','audio/ogg','audio/webm']);
const TOOL_NAMES = new Set(['onec_list_metadata_objects','onec_get_metadata_structure','onec_get_access_rights','onec_get_object','onec_execute_query',
  'onec_inspect_metadata','onec_find_latest_purchase','onec_find_latest_receipt','onec_find_latest_order','help_create_spreadsheet','help_create_document','help_search_history','help_read_history','help_read_attachment']);
const ACTIVITY_ERRORS = new Set(['ONEC_TOOL_ARGUMENTS','ONEC_QUERY_FORBIDDEN','ONEC_TOOL_FAILED','ONEC_RPC_ERROR','ONEC_REPEATED_REJECTED_REQUEST',
  'ONEC_UNAVAILABLE','ONEC_TIMEOUT','ONEC_RESPONSE_TOO_LARGE','ONEC_FORBIDDEN','ONEC_VAULT_UNAVAILABLE','ONEC_NOT_CONFIGURED','ONEC_UNKNOWN']);
const clean = text => text.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
const isPlainObject = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function failure() { const error = new Error('HELP_LEARNING_INVALID_SNAPSHOT'); error.code = error.message; throw error; }
function positive(value) { if (!Number.isSafeInteger(value) || value <= 0) failure(); return value; }
function timestamp(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) failure();
  return new Date(value).toISOString();
}
function containsSensitiveText(text) {
  return typeof text !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) || SECRET.test(clean(text)) || CONTACT.test(clean(text)) || PERSONAL.test(clean(text));
}
const EVIDENCE_BYTES=64000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EVIDENCE_REASONS=new Set(['INVALID_INPUT','TOO_LARGE','INVALID_DOCUMENT','INVALID_ENCODING','UNSUPPORTED_FORMAT','OCR_REQUIRED','EXTRACTION_FAILED','TIMEOUT','OUTPUT_LIMIT','ACTIVE_CONTENT',
  'UNAVAILABLE','TOOL_RESULT_UNAVAILABLE','HISTORICAL_BODY_UNAVAILABLE','BODY_NOT_RECORDED','NO_RESULT','INVALID_RESULT','REDACTED','SOURCE_TRUNCATED','ATTACHMENT_UNAVAILABLE','NOT_FOUND','FORBIDDEN',
  'FILE_SIZE_LIMIT','BATCH_FILE_LIMIT','FILE_READ_OR_INTEGRITY_FAILED',...ACTIVITY_ERRORS]);
function sensitiveKey(key){return /password|passwd|pwd|login|token|authorization|cookie|secret|binding|objectkey|url|uri|apikey|credential|парол|логин|учетныеданные|учётныеданные|телефон|phone|email|почта|фио|fullname|firstname|lastname|surname|patronymic|username|userid|authorid|employeeid|имяпользователя|фамилия|отчество|паспорт|passport|снилс|birthdate|адрес|address/i.test(clean(String(key)).replace(/[^a-zа-яё0-9]/giu,''));}
function credentialColumn(column){
  if(typeof column==='string')return sensitiveKey(column);
  if(!isPlainObject(column))return false;
  return Object.entries(column).some(([key,label])=>['name','field','key','caption','label','title','datafield','имя','имяполя','наименование','имяколонки'].includes(clean(key).replace(/[^a-zа-яё0-9]/giu,'').toLowerCase())&&typeof label==='string'&&sensitiveKey(label));
}
function evidenceText(value,state,max=2000){
  let result=clean(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  if(SECRET.test(result)){state.redacted=true;return '[УЧЁТНЫЕ ДАННЫЕ СКРЫТЫ]';}
  const safe=result.replace(new RegExp(CONTACT.source,'giu'),'[КОНТАКТ ИЛИ АДРЕС СКРЫТ]')
    .replace(new RegExp(PERSONAL.source,'gu'),'[ПЕРСОНАЛЬНЫЕ ДАННЫЕ СКРЫТЫ]');
  if(safe!==result)state.redacted=true;result=safe;
  if(result.length>max){state.truncated=true;result=result.slice(0,max);}
  return result;
}
function scrubEvidence(value,state,depth=0){
  if(++state.nodes>4000||depth>8){state.truncated=true;return '[УСЕЧЕНО]';}
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='string'){
    // Some historical adapters stored a JSON result as a string. Recursively
    // minimize its fields too; quoting must not hide a password-column value.
    if(/^[\s]*[\[{]/.test(value)&&value.length<=1024*1024){try{const parsed=JSON.parse(value);if(isPlainObject(parsed)||Array.isArray(parsed))return scrubEvidence(parsed,state,depth+1);}catch{}}
    return evidenceText(value,state);
  }
  if(Array.isArray(value)){
    if(value.length>80)state.truncated=true;
    return value.slice(0,80).map(item=>scrubEvidence(item,state,depth+1));
  }
  if(!isPlainObject(value)){state.truncated=true;return null;}
  const out={},keys=Object.keys(value);if(keys.length>64)state.truncated=true;
  const columns=Array.isArray(value.headers)?value.headers:Array.isArray(value.columns)?value.columns:Array.isArray(value.fields)?value.fields:null;
  const sensitiveColumns=columns?.map(credentialColumn);
  for(const key of keys.slice(0,64)){
    if(['__proto__','constructor','prototype'].includes(key)){state.truncated=true;continue;}
    const name=evidenceText(key,state,128);
    if(sensitiveKey(key)){state.redacted=true;out[name]='[СКРЫТО]';}
    else if(['rows','data','values','records'].includes(key)&&Array.isArray(value[key])&&sensitiveColumns){
      if(value[key].length>80)state.truncated=true;
      out[name]=value[key].slice(0,80).map(row=>{if(!Array.isArray(row))return scrubEvidence(row,state,depth+1);if(row.length>256)state.truncated=true;return row.slice(0,256).map((cell,index)=>{
        // A two-column key/value record can name a sensitive field in column1.
        if(sensitiveColumns[index]||index>0&&sensitiveKey(row[0])){state.redacted=true;return '[СКРЫТО]';}
        return scrubEvidence(cell,state,depth+2);
      });});
    }else out[name]=scrubEvidence(value[key],state,depth+1);
  }
  return out;
}
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647?value:null;
function artifactCell(value,state){
  if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return value;
  if(!isPlainObject(value)){state.truncated=true;return null;}
  if(typeof value.formula==='string'){
    if(Object.keys(value).some(key=>!['formula','external','cachedValue'].includes(key)))state.truncated=true;
    const cell={formula:value.formula,external:value.external===true};
    if('cachedValue'in value)cell.cachedValue=artifactCell(value.cachedValue,state);
    return cell;
  }
  if(typeof value.error==='string')return {error:value.error};
  state.truncated=true;return null;
}
function artifactSheet(raw,state){
  if(!isPlainObject(raw)){state.truncated=true;return null;}
  const headers=Array.isArray(raw.headers)?raw.headers.slice(0,256).map(value=>typeof value==='string'?evidenceText(value,state,300):''):[];
  if(!Array.isArray(raw.headers)||raw.headers.length>256)state.truncated=true;
  if(!Array.isArray(raw.rows)||raw.rows.length>80)state.truncated=true;
  const rows=(Array.isArray(raw.rows)?raw.rows:[]).slice(0,80).map(row=>{
    if(!Array.isArray(row)){state.truncated=true;return [];}
    if(row.length>256)state.truncated=true;
    return row.slice(0,256).map(cell=>artifactCell(cell,state));
  });
  const shaped=scrubEvidence({headers,rows},state);
  const result={name:typeof raw.name==='string'?evidenceText(raw.name,state,200):'',rowCount:count(raw.rowCount),columnCount:count(raw.columnCount),
    headers,rows:shaped.rows,rowsComplete:raw.rowsComplete===true&&!state.redacted&&!state.truncated};
  for(const key of ['declaredRowCount','dataRowCount','headerRow','formulaCount','externalFormulaCount'])if(key in raw)result[key]=count(raw[key]);
  if(['visible','hidden'].includes(raw.state))result.state=raw.state;
  if(['first_nonempty_row','first_record'].includes(raw.headerStatus))result.headerStatus=raw.headerStatus;
  if(typeof raw.headersComplete==='boolean')result.headersComplete=raw.headersComplete&&!state.redacted&&!state.truncated;
  if(['two_column_records','rows_and_columns'].includes(raw.layout))result.layout=raw.layout;
  if([',',';','\t'].includes(raw.separator))result.separator=raw.separator;
  if(Array.isArray(raw.sampleRowNumbers))result.sampleRowNumbers=raw.sampleRowNumbers.slice(0,80).map(count);
  if(isPlainObject(raw.valueTypeCounts))result.valueTypeCounts=Object.fromEntries(['string','number','boolean','formula','date','other'].map(key=>[key,count(raw.valueTypeCounts[key])]));
  return result;
}
function shrinkPayload(container,key,depth=0){
  if(depth>10)return false;const value=container[key];
  if(Array.isArray(value)){
    if(value.length>1){value.length=Math.ceil(value.length/2);return true;}
    return value.length?shrinkPayload(value,0,depth+1):false;
  }
  if(typeof value==='string'&&value.length>256){container[key]=value.slice(0,Math.ceil(value.length/2));return true;}
  if(isPlainObject(value)){
    const priority=['rows','data','records','values'];
    for(const name of [...priority,...Object.keys(value).filter(name=>!priority.includes(name))])if(name in value&&shrinkPayload(value,name,depth+1))return true;
  }
  return false;
}
/** Trusted collector must provide the set of message IDs retained in its snapshot.
 * This only minimizes evidence; it does not confer source/attachment permissions. */
function sanitizeAnalysisEvidence(raw,options={}){
  if(!isPlainObject(raw)||raw.version!==1)return null;
  const supplied=options instanceof Set||Array.isArray(options)?options:options.messageIds;
  const ids=new Set(supplied instanceof Set||Array.isArray(supplied)?[...supplied].filter(value=>Number.isSafeInteger(value)&&value>0):[]);
  const result={version:1,files:[],toolCalls:[],filesTruncated:raw.filesTruncated===true,toolsTruncated:raw.toolsTruncated===true};
  const files=Array.isArray(raw.files)?raw.files:[],tools=Array.isArray(raw.toolCalls)?raw.toolCalls:[];
  if(!Array.isArray(raw.files)||files.length>16)result.filesTruncated=true;
  if(!Array.isArray(raw.toolCalls)||tools.length>16)result.toolsTruncated=true;
  const fileIds=new Set(),toolIds=new Set();
  for(const item of files.slice(0,16)){
    if(!isPlainObject(item)||!ids.has(item.messageId)||!UUID.test(item.attachmentId||'')||!/^[a-f0-9]{64}$/i.test(item.sha256||'')) {result.filesTruncated=true;continue;}
    const identity=item.messageId+':'+item.attachmentId.toLowerCase();if(fileIds.has(identity)){result.filesTruncated=true;continue;}fileIds.add(identity);
    const state={redacted:item.redacted===true,truncated:false,nodes:0};
    const extension=typeof item.extension==='string'?item.extension.toLowerCase().replace(/^\./,''):'';
    const format=['xlsx','docx','pdf','txt','md','csv','json'].includes(item.format)?item.format:'unknown';
    const entry={messageId:item.messageId,attachmentId:item.attachmentId.toLowerCase(),sha256:item.sha256.toLowerCase(),extension:EXTENSIONS.has('.'+extension)||extension==='pdf'?'.'+extension:null,
      format,status:['parsed','partial','unsupported','failed'].includes(item.status)?item.status:'unsupported',complete:item.complete===true};
    if(typeof item.text==='string')entry.text=evidenceText(item.text,state,24000);
    if(Array.isArray(item.sheets)){if(item.sheets.length>25)state.truncated=true;entry.sheets=item.sheets.slice(0,25).map(sheet=>artifactSheet(sheet,state)).filter(Boolean);}
    for(const key of ['totalChars','pageCount'])if(key in item)entry[key]=count(item[key]);
    if(EVIDENCE_REASONS.has(item.reason))entry.reason=item.reason;
    entry.redacted=state.redacted;entry.complete=entry.complete&&!state.redacted&&!state.truncated;
    if(entry.status==='parsed'&&!entry.complete)entry.status='partial';
    entry.contentComplete=entry.complete;entry.sourceTruncated=state.truncated?true:typeof item.sourceTruncated==='boolean'?item.sourceTruncated:null;
    if(entry.sourceTruncated){entry.complete=false;entry.contentComplete=false;if(entry.status==='parsed')entry.status='partial';}
    result.files.push(entry);
  }
  for(const item of tools.slice(0,16)){
    if(!isPlainObject(item)||!ids.has(item.messageId)||!Number.isSafeInteger(item.index)||item.index<0||!TOOL_NAMES.has(item.toolName)){result.toolsTruncated=true;continue;}
    const identity=item.messageId+':'+item.index;if(toolIds.has(identity)){result.toolsTruncated=true;continue;}toolIds.add(identity);
    const state={redacted:item.redacted===true,truncated:false,nodes:0};
    const entry={messageId:item.messageId,index:item.index,toolName:item.toolName,args:scrubEvidence(item.args??null,state),result:scrubEvidence(item.result??null,state),
      status:['returned','running','completed','failed','stopped','unknown','unavailable'].includes(item.status)?item.status:'unknown'};
    if(item.scope==='latest_attempt')entry.scope='latest_attempt';
    if('rowCount'in item)entry.rowCount=count(item.rowCount);
    entry.redacted=state.redacted;entry.sourceTruncated=state.truncated?true:typeof item.sourceTruncated==='boolean'?item.sourceTruncated:null;
    entry.contentComplete=item.contentComplete===true&&!entry.redacted&&entry.sourceTruncated===false&&'result'in item;
    if(EVIDENCE_REASONS.has(item.errorCode))entry.errorCode=item.errorCode;
    result.toolCalls.push(entry);
  }
  // Preserve useful structure on large individual files/tools instead of dropping
  // every row. Sample removal is always visible as an incomplete evidence item.
  while(Buffer.byteLength(JSON.stringify(result))>EVIDENCE_BYTES){
    let reduced=false;
    for(const file of result.files){
      const sheet=file.sheets?.find(value=>value.rows.length);if(sheet){sheet.rows.pop();if(sheet.sampleRowNumbers?.length>sheet.rows.length)sheet.sampleRowNumbers.pop();sheet.rowsComplete=false;reduced=true;}
      else if(file.text?.length){file.text=file.text.slice(0,Math.floor(file.text.length/2));reduced=true;}
      if(reduced){file.complete=false;file.contentComplete=false;file.sourceTruncated=true;if(file.status==='parsed')file.status='partial';result.filesTruncated=true;break;}
    }
    if(reduced)continue;
    const tool=result.toolCalls.find(value=>shrinkPayload(value,'result')||shrinkPayload(value,'args'));
    if(tool){tool.sourceTruncated=true;tool.contentComplete=false;result.toolsTruncated=true;continue;}
    if(result.toolCalls.length){result.toolCalls.pop();result.toolsTruncated=true;}
    else if(result.files.length){result.files.pop();result.filesTruncated=true;}
    else break;
  }
  return result;
}
function messageMetadata(message) {
  // Legacy snapshots deliberately remain unknown. An empty array proves no
  // bound files only when metadataIncluded=true and attachmentsTruncated=false.
  const metadataIncluded = message.metadataIncluded === true && Array.isArray(message.attachments);
  const activityMetadataIncluded = message.activityMetadataIncluded === true && Array.isArray(message.activities);
  const attachmentsTruncated = metadataIncluded && (message.attachmentsTruncated === true || message.attachments.length > 4);
  const activitiesTruncated = activityMetadataIncluded && (message.activitiesTruncated === true || message.activities.length > 8);
  const attachments = metadataIncluded ? message.attachments.slice(0,4).map(raw => {
    const item = isPlainObject(raw) ? raw : {};
    return { kind: ['FILE','IMAGE','AUDIO'].includes(item.kind) ? item.kind : 'OTHER',
      extension: EXTENSIONS.has(item.extension) ? item.extension : null,
      size: Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= 2147483647 ? item.size : null,
      mimeType: MIME_TYPES.has(item.mimeType) ? item.mimeType : null };
  }) : [];
  const activities = activityMetadataIncluded ? message.activities.slice(-8).map(raw => {
    const item = isPlainObject(raw) ? raw : {};
    return { toolName: TOOL_NAMES.has(item.toolName) ? item.toolName : null,
      status: ['running','completed','failed','stopped'].includes(item.status) ? item.status : 'unknown',
      errorCode: ACTIVITY_ERRORS.has(item.errorCode) ? item.errorCode : null };
  }) : [];
  const questionsMetadataIncluded=message.questionsMetadataIncluded===true&&Array.isArray(message.questions);
  const questionsTruncated=questionsMetadataIncluded&&(message.questionsTruncated===true||message.questions.length>3);
  const questions=questionsMetadataIncluded?message.questions.slice(0,3).map(raw=>({multiSelect:raw?.multiSelect===true,
    optionCount:Number.isSafeInteger(raw?.optionCount)&&raw.optionCount>=0&&raw.optionCount<=12?raw.optionCount:null})):[];
  const assistantStatus=message.authorRole==='ASSISTANT'&&['queued','thinking','streaming','completed','stopped','error'].includes(message.assistantStatus)?message.assistantStatus:null;
  return { metadataIncluded,attachments,attachmentsTruncated,activityMetadataIncluded,activities,activitiesTruncated,
    questionsMetadataIncluded,questions,questionsTruncated,assistantStatus,
    imagesPrepared: activityMetadataIncluded && typeof message.imagesPrepared === 'boolean' ? message.imagesPrepared : null };
}
function sanitizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !/^[a-f0-9]{64}$/i.test(snapshot.sourceVersion || '') || !['OPEN', 'CLOSED'].includes(snapshot.status) ||
      typeof snapshot.itRequested !== 'boolean' || typeof snapshot.truncated !== 'boolean' || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.jobs)) failure();
  if (!Number.isSafeInteger(snapshot.lastEventId) || snapshot.lastEventId < 0) failure();
  const flags = new Set((Array.isArray(snapshot.privacyFlags) ? snapshot.privacyFlags : []).filter(flag => FLAGS.has(flag)));
  let truncated = snapshot.truncated;
  const ids = new Set(), sequences = new Set();
  const input = snapshot.messages.filter(message => message?.kind !== 'ASSISTANT_PROGRESS');
  if (input.length > 80) { flags.add('messages_truncated'); truncated = true; }
  const credentialContext = input.some(message => typeof message?.text === 'string' && CREDENTIAL_REQUEST.test(clean(message.text)));
  const messages = input.slice(-80).map(message => {
    if (!isPlainObject(message) || typeof message.text !== 'string' || !/^[A-Z_]{1,24}$/.test(message.authorRole || '') || !/^[A-Z_]{1,32}$/.test(message.kind || '')) failure();
    const id = positive(message.id), sequence = positive(message.sequence);
    if (ids.has(id) || sequences.has(sequence)) failure(); ids.add(id); sequences.add(sequence);
    if (message.rating !== null && (!Number.isInteger(message.rating) || message.rating < 0 || message.rating > 5)) failure();
    let text = clean(message.text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if (SECRET.test(text) || credentialContext && CREDENTIAL_PAIR.test(text.trim())) {
      text = '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]'; flags.add('credentials_suppressed'); truncated = true;
    } else {
      const redacted = text.replace(new RegExp(CONTACT.source, 'giu'), '[КОНТАКТ ИЛИ АДРЕС СКРЫТ]')
        .replace(new RegExp(PERSONAL.source, 'gu'), '[ПЕРСОНАЛЬНЫЕ ДАННЫЕ СКРЫТЫ]');
      if (redacted !== text) flags.add('contact_redacted'); text = redacted;
    }
    let textComplete=typeof message.textComplete==='boolean'?message.textComplete:null;
    if(text!==message.text)textComplete=false;
    const limit = 4000;
    if (text.length > limit) { text = text.slice(0, limit); flags.add('text_truncated'); truncated = true; textComplete=false; }
    const metadata = messageMetadata(message);
    if (metadata.attachmentsTruncated) { flags.add('attachments_truncated'); truncated = true; }
    if (metadata.activitiesTruncated) { flags.add('activities_truncated'); truncated = true; }
    if (metadata.questionsTruncated) { flags.add('questions_truncated'); truncated = true; }
    return { id, sequence, authorRole: message.authorRole, kind: message.kind, text, textComplete, rating: message.rating, createdAt: timestamp(message.createdAt), ...metadata };
  }).sort((a, b) => a.sequence - b.sequence);
  // Spend the text budget newest first, after privacy expansion. An older long
  // message must not erase a newer answer or masquerade as an empty response.
  let remaining=160000;
  for(const message of [...messages].reverse()){
    if(message.text.length>remaining){message.text=message.text.slice(0,remaining);message.textComplete=false;flags.add('text_truncated');truncated=true;}
    remaining-=message.text.length;
  }
  if (snapshot.jobs.length > 8) { flags.add('jobs_truncated'); truncated = true; }
  const jobs = snapshot.jobs.slice(0, 8).map(job => {
    if (!isPlainObject(job) || !/^[A-Z_]{1,24}$/.test(job.status || '') || !/^[a-z0-9_-]{1,40}$/.test(job.provider || '') ||
        job.errorCode !== null && !/^[A-Z0-9_]{1,100}$/.test(job.errorCode || '')) failure();
    return { status: job.status, errorCode: job.errorCode, provider: job.provider, completedAt: timestamp(job.completedAt, true) };
  });
  let metadataBudget=24000;
  for(const message of [...messages].reverse())for(const [field,flag,privacyFlag] of [['attachments','attachmentsTruncated','attachments_truncated'],['activities','activitiesTruncated','activities_truncated'],['questions','questionsTruncated','questions_truncated']]){
    while(message[field].length&&JSON.stringify(message[field]).length>metadataBudget){message[field].pop();message[flag]=true;flags.add(privacyFlag);truncated=true;}
    metadataBudget-=Math.min(metadataBudget,JSON.stringify(message[field]).length);
  }
  const result = { ...([3,4].includes(snapshot.projectionVersion)?{projectionVersion:snapshot.projectionVersion}:{}),ticketId: positive(snapshot.ticketId), sourceVersion: snapshot.sourceVersion.toLowerCase(), status: snapshot.status,
    closedAt: timestamp(snapshot.closedAt, true), itRequested: snapshot.itRequested, updatedAt: timestamp(snapshot.updatedAt),
    lastEventId: snapshot.lastEventId, truncated, messages, jobs, privacyFlags: [...flags].sort() };
  const analysisEvidence=sanitizeAnalysisEvidence(snapshot.analysisEvidence,{messageIds:ids});
  if(analysisEvidence){
    result.analysisEvidence=analysisEvidence;
    if(analysisEvidence.filesTruncated||analysisEvidence.toolsTruncated||analysisEvidence.files.some(item=>item.sourceTruncated)||analysisEvidence.toolCalls.some(item=>item.sourceTruncated)){
      result.truncated=true;result.privacyFlags.push('analysis_evidence_truncated');
    }
    if(analysisEvidence.files.some(item=>item.redacted)||analysisEvidence.toolCalls.some(item=>item.redacted)){
      result.truncated=true;result.privacyFlags.push('analysis_evidence_redacted');
    }
  }
  // JSON escaping, Unicode bytes and evidence count toward the envelope too.
  let excess=Buffer.byteLength(JSON.stringify(result))-180000;
  for(const message of result.messages){
    if(excess<=0)break;
    if(message.text.length){message.text=message.text.slice(Math.min(message.text.length,excess));message.textComplete=false;}
    result.truncated=true;if(!result.privacyFlags.includes('text_truncated'))result.privacyFlags.push('text_truncated');
    excess=Buffer.byteLength(JSON.stringify(result))-180000;
  }
  result.privacyFlags=[...new Set(result.privacyFlags)].sort();return result;
}
module.exports = { sanitizeSnapshot, sanitizeAnalysisEvidence, containsSensitiveText, isPlainObject };
