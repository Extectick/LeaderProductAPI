jest.mock('exceljs',()=>jest.requireActual('../node_modules/exceljs'));
import {helpOfficeTools} from '../src/modules/help/help.office-tools';
import ExcelJS from 'exceljs';
const signal=()=>new AbortController().signal;
const actualExcel=ExcelJS;
function source(data:Array<Record<string,unknown>>,truncated=false){return JSON.stringify({baseKey:'qa',tool:'onec_execute_query',data:JSON.stringify({success:true,rowCount:data.length,truncated,data})});}
async function workbook(bytes:Buffer){const result=new actualExcel.Workbook();await result.xlsx.load(bytes as any);return result;}

test('exports server-held 1C rows directly to real Excel, with typed numbers and reference presentations',async()=>{
 const tools=helpOfficeTools(),output=JSON.parse(tools.rememberData(source([{Менеджер:{_objectRef:true,presentation:'Анна',guid:'not-a-binary-file'},Сумма:1234.56,Активен:true},{Менеджер:{_objectRef:true,presentation:'Иван'},Сумма:0,Активен:false}])));
 expect(output).toMatchObject({dataSourceId:'table-1',rowCount:2,truncated:false});
 const reply=JSON.parse(await tools.call('help_create_spreadsheet',{name:'Продажи.xlsx',dataSourceIds:[output.dataSourceId],sheetName:'Выручка',columns:[{key:'Менеджер',header:'Имя'},{key:'Сумма',header:'Выручка',numberFormat:'#,##0.00'}]},signal()));
 expect(reply).toMatchObject({created:true,rowCount:2,partial:false,dataSourceIds:['table-1']});expect(reply).not.toHaveProperty('bytes');
 const book=await workbook(tools.files[0].bytes),sheet=book.getWorksheet('Выручка')!;expect(sheet.getCell('A1').value).toBe('Имя');expect(sheet.getCell('A2').value).toBe('Анна');expect(sheet.getCell('B2').value).toBe(1234.56);expect(sheet.getCell('B3').value).toBe(0);expect(sheet.getCell('B2').numFmt).toBe('#,##0.00');
 expect(tools.files[0].reviewText).toContain('Анна');expect(tools.files[0].reviewText).toContain('1234.56');
});

test('combines compatible pages and preserves partial status even on a repeated export',async()=>{
 const tools=helpOfficeTools();tools.rememberData(source([{Имя:'Первый',Сумма:1}],true));tools.rememberData(source([{Сумма:2,Имя:'Второй'}]));
 const args={name:'Порции.xlsx',dataSourceIds:['table-1','table-2']},first=JSON.parse(await tools.call('help_create_spreadsheet',args,signal()));
 expect(first).toMatchObject({created:true,rowCount:2,partial:true,truncated:true});expect(first.note).toContain('полный набор');
 expect(JSON.parse(await tools.call('help_create_spreadsheet',args,signal()))).toEqual(first);expect(tools.files).toHaveLength(1);
 const sheet=(await workbook(tools.files[0].bytes)).worksheets[0];expect(sheet.getCell('A3').value).toBe('Второй');expect(sheet.getCell('B3').value).toBe(2);
});

test('unknown data source IDs cannot access a different request cache',async()=>{
 const a=helpOfficeTools(),b=helpOfficeTools();a.rememberData(source([{A:1}]));
 expect(JSON.parse(await b.call('help_create_spreadsheet',{name:'Другой.xlsx',dataSourceIds:['table-1']},signal()))).toMatchObject({error:'HELP_OFFICE_DATA_SOURCE'});expect(b.files).toEqual([]);
});

test('failed, malformed or other tools remain unchanged and cannot seed datasets',()=>{
 const tools=helpOfficeTools();
 for(const output of ['not json','{"error":"ONEC_TOOL_FAILED"}',JSON.stringify({tool:'onec_execute_query',data:JSON.stringify({success:true,rowCount:2,truncated:false,data:[{A:1}]})}),JSON.stringify({tool:'onec_get_object',data:JSON.stringify({success:true,rowCount:1,data:[{A:1}]})})])expect(tools.rememberData(output)).toBe(output);
 expect(JSON.parse(tools.rememberData(source([{A:1}]))).dataSourceId).toBe('table-1');
});

test('schema mismatches, missing columns, duplicate IDs and mixed explicit data fail rather than silently changing rows',async()=>{
 const tools=helpOfficeTools();tools.rememberData(source([{A:1,B:2}]));tools.rememberData(source([{A:3,C:4}]));
 for(const args of [
 {name:'bad.xlsx',dataSourceIds:['table-1','table-2']},
 {name:'bad.xlsx',dataSourceIds:['table-1'],columns:[{key:'Missing'}]},
 {name:'bad.xlsx',dataSourceIds:['table-1','table-1']},
 {name:'bad.xlsx',dataSourceIds:['table-1'],sheets:[{name:'X',headers:['X'],rows:[[1]]}]},
 ])expect(JSON.parse(await tools.call('help_create_spreadsheet',args,signal())).error).toBe('HELP_OFFICE_ARGUMENTS');
 expect(tools.files).toHaveLength(0);
 const reply=JSON.parse(await tools.call('help_create_spreadsheet',{name:'Общий.xlsx',dataSourceIds:['table-1','table-2'],columns:[{key:'A'}]},signal()));expect(reply.created).toBe(true);
});

test('unknown object values remain literal text instead of becoming spreadsheet formulas',async()=>{
 const tools=helpOfficeTools();tools.rememberData(source([{A:{formula:'HYPERLINK("https://example.invalid")'}},{A:{_objectRef:true,presentation:'=1+1'}}]));
 expect(JSON.parse(await tools.call('help_create_spreadsheet',{name:'Литералы.xlsx',dataSourceIds:['table-1']},signal())).created).toBe(true);
 const sheet=(await workbook(tools.files[0].bytes)).worksheets[0];expect(sheet.getCell('A2').value).toBe('{"formula":"HYPERLINK(\\"https://example.invalid\\")"}');expect(sheet.getCell('A3').value).toBe('=1+1');expect(sheet.getCell('A2').formula).toBeUndefined();
});

test('an empty successful dataset exports only explicitly named headers; missing truncation stays unknown',async()=>{
 const tools=helpOfficeTools();tools.rememberData(source([]));
 expect(JSON.parse(await tools.call('help_create_spreadsheet',{name:'Пусто.xlsx',dataSourceIds:['table-1'],columns:[{key:'Клиент'}]},signal()))).toMatchObject({created:true,rowCount:0,partial:false});
 const output=JSON.parse(tools.rememberData(JSON.stringify({tool:'onec_execute_query',data:JSON.stringify({success:true,rowCount:1,data:[{A:1}]})})));expect(output.truncated).toBe(true);
});

test('explicit spreadsheets and Word documents keep the original path and receive review text',async()=>{
 const tools=helpOfficeTools();
 expect(JSON.parse(await tools.call('help_create_spreadsheet',{name:'Явно.xlsx',sheets:[{name:'Лист',headers:['A'],rows:[[5]]}]},signal())).created).toBe(true);
 expect(JSON.parse(await tools.call('help_create_document',{name:'Документ.docx',title:'Итог',blocks:[{type:'paragraph',text:'Исходный текст'}]},signal())).created).toBe(true);
 expect(tools.files).toHaveLength(2);expect(tools.files[1].reviewText).toContain('Исходный текст');
});
