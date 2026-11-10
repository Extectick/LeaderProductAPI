import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
const ExcelJS=jest.requireActual('../node_modules/exceljs') as typeof import('exceljs');
const JSZip=jest.requireActual('../node_modules/jszip');
let directory:string;
beforeAll(()=>{
 directory=mkdtempSync(path.join(tmpdir(),'leader-xlsx-reader-'));
 for(const name of ['knowledge.extract-child','knowledge.config']) {
  const source=readFileSync(path.resolve(__dirname,'../src/modules/knowledge',name+'.ts'),'utf8');
  writeFileSync(path.join(directory,name+'.js'),ts.transpileModule(source,{fileName:name+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
 }
});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
function extract(bytes:Buffer) {
 const result=spawnSync(process.execPath,['--max-old-space-size=192',path.join(directory,'knowledge.extract-child.js'),'xlsx'],{
  input:bytes,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024,
  env:{PATH:process.env.PATH,NODE_PATH:path.resolve(__dirname,'../node_modules')},
 });
 if(result.error)throw result.error;
 return {status:result.status,...JSON.parse(result.stdout)};
}
async function sample() {
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Продажи');
 sheet.addRow(['Товар','Количество','Сумма']);sheet.addRow(['Позиция А',2,14.5]);
 sheet.addRow(['Итого',{formula:'SUM(B2:B2)',result:2},{formula:'SUM(C2:C2)',result:14.5}]);
 sheet.addRow(['Без кэша',{formula:'1+2'}]);
 sheet.getCell('A6').value='две\nстроки\tклетка';
 sheet.getCell('A5').value={text:'Существующий документ',hyperlink:'https://must-never-be-fetched.invalid/private'};
 const hidden=workbook.addWorksheet('Архив',{state:'hidden'});hidden.addRow(['Архивные данные',true]);
 return Buffer.from(await workbook.xlsx.writeBuffer());
}
test('actual XLSX reads sheet names, scalar cells and cached formula results without evaluation or hyperlink requests',async()=>{
 const result=extract(await sample());expect(result.status).toBe(0);
 expect(result.text).toContain('Лист: Продажи');expect(result.text).toContain('Товар\tКоличество\tСумма');
 expect(result.text).toContain('Позиция А\t2\t14.5');expect(result.text).toContain('Итого\t2\t14.5');
 expect(result.text).toContain('[Формула: 1+2; результат не сохранён]');
 expect(result.text).toContain('две\\nстроки\\tклетка');
 expect(result.text).toContain('Существующий документ');expect(result.text).not.toContain('must-never-be-fetched');
 expect(result.text).toContain('Лист: Архив (скрытый)');expect(result.text).toContain('Архивные данные\ttrue');
});
test('rejects an excessive advertised ZIP expansion before XML decompression',async()=>{
 const bytes=Buffer.from(await sample()),central=bytes.indexOf(Buffer.from([80,75,1,2]));expect(central).toBeGreaterThan(0);
 bytes.writeUInt32LE(33*1024*1024,central+24);
 expect(extract(bytes)).toMatchObject({status:1,error:'DOCUMENT_TOO_LARGE'});
});
test('rejects a macro-bearing archive and unrelated ZIP content',async()=>{
 const macro=new JSZip();macro.file('[Content_Types].xml','fixture');macro.file('xl/workbook.xml','fixture');macro.file('xl/vbaProject.bin','fixture');
 expect(extract(await macro.generateAsync({type:'nodebuffer'}))).toMatchObject({status:1,error:'INVALID_DOCUMENT'});
 const unrelated=new JSZip();unrelated.file('notes.txt','Not a workbook');
 expect(extract(await unrelated.generateAsync({type:'nodebuffer'}))).toMatchObject({status:1,error:'INVALID_DOCUMENT'});
});
test('empty workbook yields a structured no-text result',async()=>{
 const workbook=new ExcelJS.Workbook();workbook.addWorksheet('Пустой лист');
 expect(extract(Buffer.from(await workbook.xlsx.writeBuffer()))).toMatchObject({status:1,error:'NO_TEXT_OCR_REQUIRED'});
});
