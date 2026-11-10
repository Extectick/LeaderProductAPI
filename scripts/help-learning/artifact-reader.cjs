'use strict';

// This child reads bytes only. It has no application/DB imports, credentials,
// network client, filesystem path argument, macro engine or formula evaluator.
const {spawn}=require('node:child_process');
const {inflateRawSync}=require('node:zlib');
const {TextDecoder}=require('node:util');
const HARD={maxBytes:10*1024*1024,maxUnpackedBytes:32*1024*1024,maxEntryBytes:16*1024*1024,maxEntries:2000,
  maxSheets:25,maxRows:20000,maxColumns:256,maxCells:200000,maxSampleRows:40,maxTextChars:24000,
  maxCellChars:1000,maxOutputBytes:96*1024,timeoutMs:10000,maxPdfPages:100};
const REASONS=new Set(['INVALID_INPUT','TOO_LARGE','INVALID_DOCUMENT','INVALID_ENCODING','UNSUPPORTED_FORMAT',
  'OCR_REQUIRED','EXTRACTION_FAILED','TIMEOUT','OUTPUT_LIMIT','ACTIVE_CONTENT']);
const knownFormat=extension=>typeof extension==='string'?extension.toLowerCase().replace(/^\./,''):'';
const MIME_FORMATS={'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/pdf':'pdf',
  'text/plain':'txt','text/markdown':'md','text/csv':'csv','application/json':'json'};
function limits(input={}){
  const result={...HARD};
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  for(const key of Object.keys(HARD))if(Number.isSafeInteger(input[key])&&input[key]>0)result[key]=Math.min(HARD[key],input[key]);
  // Reserve enough envelope space for deterministic metadata and failure output.
  result.maxOutputBytes=Math.max(8192,result.maxOutputBytes);return result;
}
function failure(format,reason){return {format:format||'unknown',status:'failed',complete:false,reason:REASONS.has(reason)?reason:'EXTRACTION_FAILED'};}
function fail(reason){throw Object.assign(new Error(reason),{reason});}
function text(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{fail('INVALID_ENCODING');}}
function clipped(value,max){let end=Math.min(value.length,max);if(end<value.length&&end>0&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;return value.slice(0,end);}
let crcTable;
function crc32(bytes){
  if(!crcTable)crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;
}

/** Validate central AND local ZIP records, then inflate each entry with an output
 * ceiling before a document library can allocate XML/object graphs. */
function checkZip(bytes,format,l){
  if(bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50)fail('INVALID_DOCUMENT');
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(bytes.readUInt32LE(p)===0x06054b50&&p+22+bytes.readUInt16LE(p+20)===bytes.length){end=p;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))fail('INVALID_DOCUMENT');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(!count||count>l.maxEntries||count===0xffff||count!==bytes.readUInt16LE(end+8)||size===0xffffffff||start===0xffffffff||start+size>end)fail('TOO_LARGE');
  let cursor=start,total=0;const names=new Set(),ranges=[];let contentTypes='';
  for(let index=0;index<count;index++){
    if(cursor+46>start+size||bytes.readUInt32LE(cursor)!==0x02014b50)fail('INVALID_DOCUMENT');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),packed=bytes.readUInt32LE(cursor+20),unpacked=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extra+comment;
    if(next>start+size||flags&1||![0,8].includes(method)||local===0xffffffff||packed===0xffffffff||unpacked===0xffffffff||local+30>start||bytes.readUInt32LE(local)!==0x04034b50)fail('INVALID_DOCUMENT');
    const name=text(bytes.subarray(cursor+46,cursor+46+nameLength));
    if(!name||/[\\\x00-\x1f\x7f]/.test(name)||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some((part,i,all)=>part==='..'||part==='.'||!part&&i!==all.length-1)||names.has(name.toLowerCase()))fail('INVALID_DOCUMENT');
    const unixMode=bytes.readUInt32LE(cursor+38)>>>16;if((unixMode&0xf000)===0xa000)fail('INVALID_DOCUMENT');
    if(/(?:^|\/)(?:vbaProject\.bin|activeX|embeddings)(?:\/|$)/i.test(name))fail('ACTIVE_CONTENT');
    names.add(name.toLowerCase());
    const localNameLength=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),data=local+30+localNameLength+localExtra;
    if(data>start||data+packed>start||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||text(bytes.subarray(local+30,local+30+localNameLength))!==name)fail('INVALID_DOCUMENT');
    if(!(flags&8)&&(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==packed||bytes.readUInt32LE(local+22)!==unpacked))fail('INVALID_DOCUMENT');
    if(unpacked>l.maxEntryBytes||(total+=unpacked)>l.maxUnpackedBytes)fail('TOO_LARGE');
    ranges.push([local,data+packed]);
    let raw;
    try{raw=method===0?bytes.subarray(data,data+packed):inflateRawSync(bytes.subarray(data,data+packed),{maxOutputLength:Math.max(1,unpacked+1)});}catch{fail('INVALID_DOCUMENT');}
    if(raw.length!==unpacked||crc32(raw)!==crc)fail('INVALID_DOCUMENT');
    if(/\.(?:xml|rels)$/i.test(name)){
      const xml=text(raw);if(/\x00|<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))fail('INVALID_DOCUMENT');
      if(name==='[Content_Types].xml')contentTypes=xml;
    }
    cursor=next;
  }
  ranges.sort((a,b)=>a[0]-b[0]);if(ranges.some((r,i)=>i&&r[0]<ranges[i-1][1])||cursor!==start+size)fail('INVALID_DOCUMENT');
  if(!names.has('[content_types].xml')||!names.has(format==='xlsx'?'xl/workbook.xml':'word/document.xml'))fail('INVALID_DOCUMENT');
  if(/macroEnabled|activeX|oleObject/i.test(contentTypes))fail('ACTIVE_CONTENT');
}

function scalar(value,context,l){
  if(value==null)return null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='boolean')return value;
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.toISOString():null;
  if(typeof value==='string'){
    const clean=value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
    if(clean.length>l.maxCellChars)context.cellTruncated=true;
    return clipped(clean,l.maxCellChars);
  }
  if(typeof value!=='object')return null;
  if(Array.isArray(value.richText))return scalar(value.richText.map(part=>typeof part?.text==='string'?part.text:'').join(''),context,l);
  if('formula' in value||'sharedFormula' in value){
    context.formulaCount++;
    const expression=String(value.formula??value.sharedFormula??'');
    const external=/\[[^\]]+\]|(?:https?|file|ftp):|\b(?:HYPERLINK|WEBSERVICE|FILTERXML|IMAGE|RTD)\s*\(|\|[^!]*!/i.test(expression);
    if(external)context.externalFormulaCount++;
    const formula=external?'[EXTERNAL_FORMULA]':clipped(expression,l.maxCellChars);
    if(!external&&formula.length!==expression.length)context.cellTruncated=true;
    const result={formula,external};
    if(value.result!==undefined)result.cachedValue=scalar(value.result,context,l);
    return result;
  }
  // Only display text; a hyperlink's address is never returned or opened.
  if(typeof value.text==='string')return scalar(value.text,context,l);
  if(typeof value.error==='string')return {error:clipped(value.error,80)};
  return null;
}
function asHeader(value){if(value==null)return '';if(typeof value==='object')return value.formula?'[FORMULA]':value.error||'';return String(value);}
function newBudget(l){return {remaining:l.maxOutputBytes-4096,partial:false};}
function take(budget,value){const cost=Buffer.byteLength(JSON.stringify(value))+1;if(cost>budget.remaining){budget.partial=true;return false;}budget.remaining-=cost;return true;}
function finish(format,sheets,budget){const complete=!budget.partial&&sheets.every(s=>s.rowsComplete&&s.headersComplete);return {format,status:complete?'parsed':'partial',complete,sheets};}

async function spreadsheet(bytes,l){
  checkZip(bytes,'xlsx',l);const ExcelJS=require('exceljs'),book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  if(book.worksheets.length>l.maxSheets)fail('TOO_LARGE');
  const budget=newBudget(l),sheets=[];let cells=0;
  for(const sheet of book.worksheets){
    if(sheet.rowCount>l.maxRows||sheet.columnCount>l.maxColumns)fail('TOO_LARGE');
    const context={cellTruncated:false,formulaCount:0,externalFormulaCount:0},rows=[],sampleRowNumbers=[];let headers=[],headerRow=null,nonEmptyRows=0,dataRows=0,headersComplete=true,sampledAll=true;
    const types={string:0,number:0,boolean:0,formula:0,date:0,other:0};
    sheet.eachRow({includeEmpty:false},row=>{
      const values=Array(sheet.columnCount).fill(null);let populated=false;
      row.eachCell({includeEmpty:false},(cell,column)=>{
        if(++cells>l.maxCells)fail('TOO_LARGE');
        if(cell.type===ExcelJS.ValueType.Merge)return;
        const raw=cell.value,value=scalar(raw,context,l);if(value!==null&&value!=='')populated=true;
        values[column-1]=value;
        if(raw instanceof Date)types.date++;else if(raw&&typeof raw==='object'&&('formula'in raw||'sharedFormula'in raw))types.formula++;
        else if(['string','number','boolean'].includes(typeof raw))types[typeof raw]++;else if(raw!=null)types.other++;
      });
      if(!populated)return;
      nonEmptyRows++;
      if(headerRow===null){
        headerRow=row.number;const candidate=values.map(asHeader);
        for(const value of candidate){const bounded=clipped(value,300);if(bounded!==value)headersComplete=false;if(!take(budget,bounded)){headersComplete=false;break;}headers.push(bounded);}
      }else{
        dataRows++;
        if(rows.length<l.maxSampleRows&&take(budget,values)){rows.push(values);sampleRowNumbers.push(row.number);}else sampledAll=false;
      }
    });
    const name=clipped(sheet.name,200);take(budget,name);
    sheets.push({name,state:sheet.state==='visible'?'visible':'hidden',rowCount:nonEmptyRows,declaredRowCount:sheet.rowCount,
      dataRowCount:dataRows,columnCount:sheet.columnCount,headerRow,headerStatus:'first_nonempty_row',headers,headersComplete,rows,sampleRowNumbers,
      rowsComplete:sampledAll&&!context.cellTruncated&&headersComplete,formulaCount:context.formulaCount,externalFormulaCount:context.externalFormulaCount,
      valueTypeCounts:types,layout:sheet.columnCount===2?'two_column_records':'rows_and_columns'});
  }
  return finish('xlsx',sheets,budget);
}
function plainText(format,source,l){
  const clean=source.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  const value=clipped(clean,Math.min(l.maxTextChars,Math.floor((l.maxOutputBytes-4096)/4))),complete=value.length===clean.length;
  return {format,status:complete?'parsed':'partial',complete,text:value,totalChars:clean.length};
}
function csv(source,l){
  // Count separators outside quotes in the first logical record only.
  const scores={',':0,';':0,'\t':0};let quoted=false;
  for(let i=0;i<source.length;i++){const ch=source[i];if(ch==='"'){if(quoted&&source[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted){if(ch==='\n'||ch==='\r')break;if(ch in scores)scores[ch]++;}}
  const separator=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0][0],all=[];let row=[],cell='',inQuote=false,afterQuote=false;
  function field(){row.push(cell);cell='';afterQuote=false;if(row.length>l.maxColumns)fail('TOO_LARGE');}
  let cells=0;
  function record(){field();cells+=row.length;if(cells>l.maxCells)fail('TOO_LARGE');all.push(row);row=[];if(all.length>l.maxRows)fail('TOO_LARGE');}
  for(let i=0;i<source.length;i++){
    const ch=source[i];
    if(inQuote){if(ch==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{inQuote=false;afterQuote=true;}}else cell+=ch;}
    else if(ch==='"'){if(cell||afterQuote)fail('INVALID_DOCUMENT');inQuote=true;}
    else if(ch===separator)field();
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&source[i+1]==='\n')i++;record();}
    else{if(afterQuote&&!/\s/.test(ch))fail('INVALID_DOCUMENT');if(!afterQuote)cell+=ch;}
  }
  if(inQuote)fail('INVALID_DOCUMENT');if(row.length||cell||afterQuote)record();
  const budget=newBudget(l),context={cellTruncated:false,formulaCount:0,externalFormulaCount:0};const originalHeaders=all.shift()||[],headers=[];let headersComplete=true;
  for(const value of originalHeaders){const bounded=clipped(value,300);if(bounded!==value)headersComplete=false;if(!take(budget,bounded)){headersComplete=false;break;}headers.push(bounded);}
  const columnCount=Math.max(originalHeaders.length,...all.map(item=>item.length),0),rows=[];
  for(const values of all.slice(0,l.maxSampleRows)){const safe=values.map(v=>scalar(v,context,l));if(!take(budget,safe))break;rows.push(safe);}
  return finish('csv',[{name:'CSV',rowCount:all.length+(originalHeaders.length?1:0),dataRowCount:all.length,columnCount,headerRow:originalHeaders.length?1:null,
    headerStatus:'first_record',headers,headersComplete,rows,rowsComplete:rows.length===all.length&&!context.cellTruncated&&headersComplete,separator}],budget);
}
async function parse(bytes,format,l){
  if(format==='xlsx')return spreadsheet(bytes,l);
  if(['txt','md','csv','json'].includes(format)){
    const source=text(bytes);if(source.includes('\0'))fail('INVALID_ENCODING');
    if(format==='csv')return csv(source,l);
    if(format==='json'){try{JSON.parse(source);}catch{fail('INVALID_DOCUMENT');}}
    return plainText(format,source,l);
  }
  if(format==='docx'){checkZip(bytes,'docx',l);const mammoth=require('mammoth');return plainText(format,(await mammoth.extractRawText({buffer:bytes})).value,l);}
  if(format==='pdf'){
    if(bytes.subarray(0,5).toString()!=='%PDF-')fail('INVALID_DOCUMENT');
    const {PDFParse}=require('pdf-parse'),parser=new PDFParse({data:bytes,isEvalSupported:false,useSystemFonts:false,disableFontFace:true});
    try{const info=await parser.getInfo();if(!Number.isSafeInteger(info.total)||info.total>l.maxPdfPages)fail('TOO_LARGE');
      // pdf-parse's default page-number separators otherwise look like content
      // even in scanned/image-only documents. No raster/OCR path is used here.
      const result=plainText(format,(await parser.getText({pageJoiner:''})).text,l);
      if(!result.text.trim())return {format,status:'unsupported',complete:false,reason:'OCR_REQUIRED'};
      return {...result,pageCount:info.total};}finally{await parser.destroy();}
  }
  return {format:format||'unknown',status:'unsupported',complete:false,reason:'UNSUPPORTED_FORMAT'};
}

/** Trusted collector entry point. A fresh bounded child parses each untrusted file.
 * The caller should additionally use its container's RSS/CPU limits. */
async function extractArtifact(buffer,metadata={},options={}){
  const l=limits(options),format=knownFormat(metadata?.extension)||MIME_FORMATS[String(metadata?.mimeType||'').split(';')[0].trim().toLowerCase()]||'';
  if(!Buffer.isBuffer(buffer))return failure(format,'INVALID_INPUT');
  if(buffer.length>l.maxBytes)return failure(format,'TOO_LARGE');
  if(!['xlsx','docx','pdf','txt','md','csv','json'].includes(format))return {format:format||'unknown',status:'unsupported',complete:false,reason:'UNSUPPORTED_FORMAT'};
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--max-old-space-size=192',__filename,'--artifact-child',format,JSON.stringify(l)],{
      shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'},windowsHide:true,
    });
    let settled=false,size=0;const chunks=[];
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const stop=reason=>{child.kill('SIGKILL');finish(failure(format,reason));};
    const timer=setTimeout(()=>stop('TIMEOUT'),l.timeoutMs);timer.unref();
    child.on('error',()=>finish(failure(format,'EXTRACTION_FAILED')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>l.maxOutputBytes)stop('OUTPUT_LIMIT');else chunks.push(chunk);});
    // Drain diagnostics but never forward document text, paths or parser errors.
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('close',code=>{if(settled)return;try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||result.format!==format||!['parsed','partial','unsupported','failed'].includes(result.status)||typeof result.complete!=='boolean')throw Error();finish(result);}catch{finish(failure(format,'EXTRACTION_FAILED'));}});
    child.stdin.end(buffer);
  });
}
async function main(){
  const format=knownFormat(process.argv[3]);let l;try{l=limits(JSON.parse(process.argv[4]||'{}'));}catch{l=limits();}
  console.log=console.warn=console.error=()=>{};
  let size=0;const chunks=[];
  try{for await(const chunk of process.stdin){size+=chunk.length;if(size>l.maxBytes)fail('TOO_LARGE');chunks.push(chunk);}
    const result=await parse(Buffer.concat(chunks),format,l),output=JSON.stringify(result);if(Buffer.byteLength(output)>l.maxOutputBytes)fail('OUTPUT_LIMIT');process.stdout.write(output);
  }catch(error){process.stdout.write(JSON.stringify(failure(format,error?.reason)));}
}
module.exports={extractArtifact};
if(require.main===module&&process.argv[2]==='--artifact-child')void main();
