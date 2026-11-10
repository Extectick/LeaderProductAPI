'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ExcelJS=require('exceljs'),JSZip=require('jszip');
const {extractArtifact}=require('./artifact-reader.cjs');
async function workbook(setup){const book=new ExcelJS.Workbook();setup(book);return Buffer.from(await book.xlsx.writeBuffer());}
async function zipFile(entries){const zip=new JSZip();for(const [name,value]of Object.entries(entries))zip.file(name,value);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
function pdf(text){
 const stream=text?'BT /F1 12 Tf 50 250 Td (Actual PDF content) Tj ET':'';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let out='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(out);out+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))out+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 return Buffer.from(out+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const xlsx={extension:'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};

test('reads actual Excel cells, numeric zero/minus, sheets and formula cache without executing external formula',async()=>{
 const bytes=await workbook(book=>{
  const sheet=book.addWorksheet('Данные');sheet.addRow(['Клиент','Сумма','Активен','Формула']);sheet.addRow(['Тест А',0,true,{formula:'B2+1',result:1}]);sheet.addRow(['Тест Б',-12.5,false,{formula:'HYPERLINK("https://private.invalid/token","click")',result:'click'}]);
  sheet.getCell('A4').value={text:'Отображаемый текст',hyperlink:'https://private.invalid/secret'};
  book.addWorksheet('Скрытый',{state:'hidden'}).addRow(['Заголовок']);
 });
 const result=await extractArtifact(bytes,xlsx);assert.equal(result.status,'parsed');assert.equal(result.complete,true);assert.equal(result.sheets.length,2);
 const sheet=result.sheets[0];assert.deepEqual(sheet.headers,['Клиент','Сумма','Активен','Формула']);assert.equal(sheet.rowCount,4);assert.equal(sheet.dataRowCount,3);assert.equal(sheet.columnCount,4);
 assert.equal(sheet.rows[0][1],0);assert.equal(sheet.rows[1][1],-12.5);assert.equal(sheet.rows[0][2],true);assert.equal(sheet.rows[1][2],false);
 assert.deepEqual(sheet.rows[0][3],{formula:'B2+1',external:false,cachedValue:1});assert.equal(sheet.rows[1][3].formula,'[EXTERNAL_FORMULA]');assert.equal(sheet.formulaCount,2);assert.equal(sheet.externalFormulaCount,1);
 assert.equal(result.sheets[1].state,'hidden');assert.ok(!JSON.stringify(result).includes('private.invalid'));
});
test('a genuine zero-result dataset keeps real headers with no fabricated data rows',async()=>{
 const result=await extractArtifact(await workbook(book=>book.addWorksheet('Данные').addRow(['Товар','Склад','Регистратор','Остаток'])),xlsx);
 assert.equal(result.status,'parsed');assert.equal(result.complete,true);assert.equal(result.sheets[0].rowCount,1);assert.equal(result.sheets[0].dataRowCount,0);assert.deepEqual(result.sheets[0].rows,[]);assert.equal(result.sheets[0].rowsComplete,true);
});
test('sampling is explicit while structural row counts cover the complete worksheet',async()=>{
 const bytes=await workbook(book=>{const sheet=book.addWorksheet('Данные');sheet.addRow(['Id','Сумма']);for(let i=1;i<=7;i++)sheet.addRow([i,i*2]);});
 const result=await extractArtifact(bytes,xlsx,{maxSampleRows:2});assert.equal(result.status,'partial');assert.equal(result.complete,false);assert.equal(result.sheets[0].dataRowCount,7);assert.equal(result.sheets[0].rows.length,2);assert.equal(result.sheets[0].rowsComplete,false);assert.deepEqual(result.sheets[0].sampleRowNumbers,[2,3]);
});
test('real ticket63 file exposes metadata sheet instead of pretending to be the requested goods table',async t=>{
 const file=path.resolve(__dirname,'../../../.dev-runtime/help-ticket-63-review/result.xlsx');if(!fs.existsSync(file)){t.skip('private reviewed fixture is not present');return;}
 const result=await extractArtifact(fs.readFileSync(file),xlsx);assert.equal(result.status,'parsed');assert.equal(result.sheets.length,1);assert.equal(result.sheets[0].columnCount,2);assert.equal(result.sheets[0].dataRowCount,14);assert.deepEqual(result.sheets[0].headers,['Параметр','Значение']);assert.equal(result.sheets[0].layout,'two_column_records');assert.equal(result.sheets[0].rowsComplete,true);
});
test('CSV handles multiline quoted records and preserves formula-looking cells as strings',async()=>{
 const result=await extractArtifact(Buffer.from('Имя;Комментарий;Количество\r\n"Тест";"строка1\nстрока2";0\r\nДругой;"=HYPERLINK(""https://example.invalid"")";-2\r\n'),{extension:'csv'});
 assert.equal(result.status,'parsed');assert.equal(result.sheets[0].separator,';');assert.equal(result.sheets[0].dataRowCount,2);assert.equal(result.sheets[0].rows[0][1],'строка1\nстрока2');assert.equal(result.sheets[0].rows[0][2],'0');assert.equal(typeof result.sheets[0].rows[1][1],'string');
});
test('UTF8 text/JSON content is included with explicit truncation, malformed/binary input is not called empty',async()=>{
 const txt=await extractArtifact(Buffer.from('abcdef'),{extension:'txt'},{maxTextChars:3});assert.equal(txt.status,'partial');assert.equal(txt.text,'abc');assert.equal(txt.totalChars,6);
 const json=await extractArtifact(Buffer.from('{"rows":[{"n":0}]}'),{extension:'json'});assert.equal(json.status,'parsed');assert.ok(json.text.includes('"n":0'));
 assert.equal((await extractArtifact(Buffer.from('MIME content'),{mimeType:'text/plain; charset=utf-8'})).text,'MIME content');
 assert.equal((await extractArtifact(Buffer.from('{invalid'),{extension:'json'})).reason,'INVALID_DOCUMENT');
 assert.equal((await extractArtifact(Buffer.from([0xff,0xfe,0x80]),{extension:'txt'})).reason,'INVALID_ENCODING');
 assert.equal((await extractArtifact(Buffer.from('bad\0binary'),{extension:'md'})).reason,'INVALID_ENCODING');
 assert.equal((await extractArtifact(Buffer.from('image'),{extension:'png'})).status,'unsupported');
});
test('DOCX extracts plain text without rendering HTML or fetching hyperlinks',async()=>{
 const {Document,Packer,Paragraph,TextRun}=require('docx');const bytes=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph({children:[new TextRun('Проверяемое содержимое Word')]})]}]}));
 const result=await extractArtifact(bytes,{extension:'docx'});assert.equal(result.status,'parsed');assert.ok(result.text.includes('Проверяемое содержимое Word'));
});
test('PDF extracts real text and does not mistake page-number decoration for document content',async()=>{
 const result=await extractArtifact(pdf(true),{extension:'pdf'});assert.equal(result.status,'parsed');assert.equal(result.pageCount,1);assert.ok(result.text.includes('Actual PDF content'));
 const empty=await extractArtifact(pdf(false),{extension:'pdf'});assert.equal(empty.status,'unsupported');assert.equal(empty.reason,'OCR_REQUIRED');assert.equal(empty.complete,false);
});
test('size, timeout and output bounds are enforced independently of parser output',async()=>{
 assert.equal((await extractArtifact(Buffer.alloc(20),{extension:'txt'},{maxBytes:10})).reason,'TOO_LARGE');
 const bytes=await workbook(book=>book.addWorksheet('Данные').addRow(['Колонка']));
 assert.equal((await extractArtifact(bytes,xlsx,{timeoutMs:1})).reason,'TIMEOUT');
 const columns=await extractArtifact(bytes,xlsx,{maxColumns:1});assert.equal(columns.status,'parsed');
 const excessive=await extractArtifact(await workbook(book=>book.addWorksheet('Данные').addRow(['A','B'])),xlsx,{maxColumns:1});assert.equal(excessive.reason,'TOO_LARGE');
});
test('ZIP paths, macros, XML entities, encrypted flags and forged expansion metadata are rejected before document libraries',async()=>{
 const common={'[Content_Types].xml':'<Types/>','xl/workbook.xml':'<workbook/>'};
 const active=await zipFile({...common,'xl/vbaProject.bin':'bad'});assert.equal((await extractArtifact(active,xlsx)).reason,'ACTIVE_CONTENT');
 const entity=await zipFile({...common,'xl/worksheets/sheet1.xml':'<!DOCTYPE x [<!ENTITY e "bad">]><worksheet/>'});assert.equal((await extractArtifact(entity,xlsx)).reason,'INVALID_DOCUMENT');
 const traversal=await zipFile({...common,'xx/../escape.xml':'text'});assert.ok(traversal.includes(Buffer.from('xx/../escape.xml')));assert.equal((await extractArtifact(traversal,xlsx)).reason,'INVALID_DOCUMENT');
 const encrypted=Buffer.from(await zipFile(common));let central=encrypted.indexOf(Buffer.from([80,75,1,2]));encrypted.writeUInt16LE(encrypted.readUInt16LE(central+8)|1,central+8);assert.equal((await extractArtifact(encrypted,xlsx)).reason,'INVALID_DOCUMENT');
 const forged=await zipFile({...common,'xl/worksheets/sheet1.xml':'<x>'+('a'.repeat(100000))+'</x>'});central=forged.indexOf(Buffer.from([80,75,1,2]));for(;central>=0;central=forged.indexOf(Buffer.from([80,75,1,2]),central+4)){const n=forged.readUInt16LE(central+28),name=forged.subarray(central+46,central+46+n).toString();if(name==='xl/worksheets/sheet1.xml'){forged.writeUInt32LE(5,central+24);break;}}
 assert.equal((await extractArtifact(forged,xlsx)).reason,'INVALID_DOCUMENT');
});
