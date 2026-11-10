// No API/DB imports or inherited application credentials in this parser process.
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from './knowledge.config';

/** Inspect only ZIP metadata before ExcelJS allocates decompressed XML/object graphs. */
function checkSpreadsheetZip(bytes: Buffer) {
  if (!bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]))) throw new Error('INVALID_DOCUMENT');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0,bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6)) throw new Error('INVALID_DOCUMENT');
  const count=bytes.readUInt16LE(end+10), directorySize=bytes.readUInt32LE(end+12), directory=bytes.readUInt32LE(end+16);
  if (!count || count>2000 || count!==bytes.readUInt16LE(end+8) || directory+directorySize>end) throw new Error('DOCUMENT_TOO_LARGE');
  let offset=directory,total=0; const names=new Set<string>();
  for(let i=0;i<count;i++) {
    if(offset+46>end || bytes.readUInt32LE(offset)!==0x02014b50) throw new Error('INVALID_DOCUMENT');
    const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),packed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24);
    const nameSize=bytes.readUInt16LE(offset+28),extraSize=bytes.readUInt16LE(offset+30),commentSize=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    const next=offset+46+nameSize+extraSize+commentSize;
    if(next>directory+directorySize || flags&1 || ![0,8].includes(method) || local+30>directory || bytes.readUInt32LE(local)!==0x04034b50) throw new Error('INVALID_DOCUMENT');
    const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    if(dataStart+packed>directory || size>16*1024*1024 || (total+=size)>32*1024*1024) throw new Error('DOCUMENT_TOO_LARGE');
    const name=bytes.subarray(offset+46,offset+46+nameSize).toString('utf8');
    if(names.has(name) || /(?:^|\/)(?:vbaProject\.bin|activeX)(?:\/|$)/i.test(name)) throw new Error('INVALID_DOCUMENT');
    names.add(name);offset=next;
  }
  if(offset!==directory+directorySize || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('INVALID_DOCUMENT');
}
async function extractSpreadsheet(bytes: Buffer): Promise<string> {
  checkSpreadsheetZip(bytes);
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const lines:string[]=[];let chars=0,cells=0,nonempty=0;
  const add=(line:string)=>{chars+=line.length+1;if(chars>MAX_TEXT_CHARS)throw new Error('DOCUMENT_TOO_LARGE');lines.push(line);};
  function scalar(value:unknown):string {
    if(value===null || value===undefined)return '';
    if(value instanceof Date)return Number.isFinite(value.getTime())?value.toISOString():'';
    if(typeof value==='string' || typeof value==='number' || typeof value==='boolean')return String(value);
    if(typeof value!=='object')return '';
    const record=value as Record<string,unknown>;
    if(Array.isArray(record.richText))return record.richText.map(part=>typeof part?.text==='string'?part.text:'').join('');
    if('formula' in record || 'sharedFormula' in record) {
      if(record.result!==undefined)return scalar(record.result);
      return '[Формула: '+String(record.formula??record.sharedFormula)+'; результат не сохранён]';
    }
    if(typeof record.text==='string')return record.text; // Hyperlink display text only; never fetch its target.
    if(typeof record.error==='string')return record.error;
    return '';
  }
  if(workbook.worksheets.length>100)throw new Error('DOCUMENT_TOO_LARGE');
  for(const sheet of workbook.worksheets) {
    if(sheet.rowCount>20000 || sheet.columnCount>256)throw new Error('DOCUMENT_TOO_LARGE');
    add('Лист: '+sheet.name+(sheet.state==='visible'?'':' (скрытый)'));
    sheet.eachRow((row:{eachCell(callback:(cell:{type:number;value:unknown},column:number)=>void):void})=>{
      const values:string[]=[];let hasText=false;
      row.eachCell((cell:{type:number;value:unknown},column:number)=>{
        if(++cells>200000)throw new Error('DOCUMENT_TOO_LARGE');
        const text=cell.type===ExcelJS.ValueType.Merge?'':scalar(cell.value).replace(/\r\n?|\n/g,'\\n').replace(/\t/g,'\\t');
        if(text){nonempty++;hasText=true;}
        values[column-1]=text;
      });
      if(hasText)add(values.map(value=>value||'').join('\t'));
    });
    add('');
  }
  if(!nonempty)throw new Error('NO_TEXT_OCR_REQUIRED');
  return lines.join('\n');
}

async function extract(bytes: Buffer, extension: string): Promise<string> {
  if (extension === 'txt' || extension === 'md') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (extension === 'xlsx') return extractSpreadsheet(bytes);
  if (extension === 'docx') {
    if (!bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error('INVALID_DOCUMENT');
    // Buffer input cannot resolve filesystem links; never render document HTML.
    const mammoth = require('mammoth') as typeof import('mammoth');
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  if (extension === 'pdf') {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('INVALID_DOCUMENT');
    const { PDFParse } = require('pdf-parse') as typeof import('pdf-parse');
    const parser = new PDFParse({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
    try {
      if ((await parser.getInfo()).total > 500) throw new Error('DOCUMENT_TOO_LARGE');
      return (await parser.getText()).text;
    } finally { await parser.destroy(); }
  }
  throw new Error('UNSUPPORTED_FORMAT');
}
async function main() {
  const parts: Buffer[] = []; let length = 0;
  for await (const part of process.stdin) {
    length += part.length;
    if (length > MAX_FILE_BYTES) throw new Error('DOCUMENT_TOO_LARGE');
    parts.push(Buffer.from(part));
  }
  const text = (await extract(Buffer.concat(parts), process.argv[2]))
    .replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  if (text.length > MAX_TEXT_CHARS) throw new Error('DOCUMENT_TOO_LARGE');
  if (!text) throw new Error('NO_TEXT_OCR_REQUIRED');
  process.stdout.write(JSON.stringify({ text }));
}
void main().catch(error => {
  const known = ['DOCUMENT_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'INVALID_DOCUMENT', 'NO_TEXT_OCR_REQUIRED'];
  process.stdout.write(JSON.stringify({ error: known.includes(error?.message) ? error.message : 'EXTRACTION_FAILED' }));
  process.exitCode = 1;
});
