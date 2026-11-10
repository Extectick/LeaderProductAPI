jest.mock('exceljs',()=>jest.requireActual('../node_modules/exceljs'));
import ExcelJS from 'exceljs';
import { createHelpSpreadsheet, helpSpreadsheetParameters } from '../src/modules/help/help.office-xlsx';
const signal = () => new AbortController().signal;
const args = { name:'Топ менеджеров.xlsx',title:'Выручка за месяц',sheets:[{name:'Выручка',headers:['Место','Менеджер','Выручка'],rows:[[1,'Тестовый менеджер',12345.67],[2,'Второй менеджер',0]],numberFormats:['0','@','#,##0.00']}] };

test('creates an actual reopenable workbook with ordered typed data and office formatting',async()=>{
 const result=await createHelpSpreadsheet(args,signal());
 expect(result.name).toBe(args.name);expect(result.mimeType).toContain('spreadsheetml');expect(result.kind).toBe('FILE');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(result.bytes as any);
 expect(workbook.title).toBe(args.title);const sheet=workbook.getWorksheet('Выручка')!;
 expect(sheet.rowCount).toBe(3);expect(sheet.getRow(1).values).toEqual([undefined,...args.sheets[0].headers]);
 expect(sheet.getCell('C2').value).toBe(12345.67);expect(sheet.getCell('C3').value).toBe(0);
 expect(sheet.getCell('C2').numFmt).toBe('#,##0.00');expect(sheet.getRow(1).font.bold).toBe(true);
 expect(sheet.views[0]).toMatchObject({state:'frozen',ySplit:1});expect(sheet.autoFilter).toBe('A1:C3');
});

test('multiple sheets preserve booleans, nulls, Unicode and formula-like literal text',async()=>{
 const result=await createHelpSpreadsheet({name:'Данные.xlsx',sheets:[
 {name:'Один',headers:['Значение'],rows:[['=HYPERLINK("https://example.invalid")'],[true],[null],['😀']]},
 {name:'Два',headers:['Число'],rows:[[42]]},
 ]},signal());
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(result.bytes as any);
 expect(workbook.worksheets.map((s:{name:string})=>s.name)).toEqual(['Один','Два']);
 const sheet=workbook.getWorksheet('Один')!;
 expect(sheet.getCell('A2').value).toBe('=HYPERLINK("https://example.invalid")');expect(sheet.getCell('A2').type).toBe(ExcelJS.ValueType.String);
 expect(sheet.getCell('A3').value).toBe(true);expect(sheet.getCell('A4').value).toBeNull();expect(sheet.getCell('A5').value).toBe('😀');
});

test.each(['../report.xlsx','report.xlsm','CON.xlsx','.report.xlsx','bad\\path.xlsx'])('rejects unsafe or wrong office filenames %s',async name=>{
 await expect(createHelpSpreadsheet({...args,name},signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
});
test.each(['Bad/Sheet',"'quoted",'duplicate'])('rejects invalid or ambiguous sheet names %s',async name=>{
 const data={name:'Данные.xlsx',sheets:[{name,headers:['A'],rows:[[1]]}]};if(name==='duplicate')data.sheets.push({name:'DUPLICATE',headers:['A'],rows:[[2]]});
 await expect(createHelpSpreadsheet(data,signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
});
test('rejects extra cells and unsupported structures without silently losing data',async()=>{
 await expect(createHelpSpreadsheet({name:'Данные.xlsx',sheets:[{name:'Один',headers:['A'],rows:[[1,2]]}]},signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
 await expect(createHelpSpreadsheet({...args,script:'run'},signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
 await expect(createHelpSpreadsheet({name:'Данные.xlsx',sheets:[{name:'Один',headers:['A'],rows:[[{formula:'SUM(A1)',execute:true}]]}]},signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
});
test('rejects pre-aborted builds and exports a concrete provider schema',async()=>{
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await expect(createHelpSpreadsheet(args,controller.signal)).rejects.toThrow('cancelled');
 expect(helpSpreadsheetParameters.required).toEqual(['name','sheets']);expect(JSON.stringify(helpSpreadsheetParameters)).not.toContain('unknown');
});

test('cancellation while the async workbook is built prevents returning an artifact',async()=>{
 const controller=new AbortController();const pending=createHelpSpreadsheet(args,controller.signal);controller.abort(new Error('cancelled during build'));
 await expect(pending).rejects.toThrow('cancelled during build');
});

test('explicit ordinary Excel formulas persist distinctly from formula-like strings',async()=>{
 const file=await createHelpSpreadsheet({name:'Суммы.xlsx',sheets:[{name:'Данные',headers:['Сумма'],rows:[[10],[20],[{formula:'=SUM(A2:A3)',result:30}],['=SUM(A2:A3)'],[{formula:'IF(A2>0,ROUND(A3/2,2),0)'}]]}]},signal());
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.bytes as any);const sheet=workbook.getWorksheet('Данные')!;
 expect(sheet.getCell('A4').value).toEqual({formula:'SUM(A2:A3)',result:30});expect(sheet.getCell('A5').value).toBe('=SUM(A2:A3)');
 expect(sheet.getCell('A6').value).toMatchObject({formula:'IF(A2>0,ROUND(A3/2,2),0)'});
 const JSZip=jest.requireActual('../node_modules/jszip');const archive=await JSZip.loadAsync(file.bytes);
 expect(await archive.file('xl/workbook.xml').async('string')).toContain('fullCalcOnLoad="1"');
});
test.each(['WEBSERVICE("https://example.invalid")','HYPERLINK(A2)','[remote.xlsx]Sheet1!A1',"'file.xlsx'|Sheet1!A1",'CALL("lib","fn")','SUM(A2:A3','GET.WORKBOOK(1)'])('rejects external/macro/malformed formula %s',async formula=>{
 await expect(createHelpSpreadsheet({name:'Данные.xlsx',sheets:[{name:'Данные',headers:['A'],rows:[[{formula}]]}]},signal())).rejects.toMatchObject({code:'HELP_OFFICE_ARGUMENTS'});
});
test('local quoted sheet references and harmless URL-looking text constants remain usable',async()=>{
 const file=await createHelpSpreadsheet({name:'Данные.xlsx',sheets:[{name:'Первый лист',headers:['A'],rows:[[2]]},{name:'Итог',headers:['A'],rows:[[{formula:"'Первый лист'!A2*2",result:4}],[{formula:'IF(A1="http://example.invalid","Есть","Нет")'}]]}]},signal());
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.bytes as any);expect(workbook.getWorksheet('Итог')!.getCell('A2').value).toEqual({formula:"'Первый лист'!A2*2",result:4});
});

test('large requests fail explicitly rather than silently dropping rows or columns',async()=>{
 const headers=Array.from({length:50},(_,i)=>'Столбец '+i),rows=Array.from({length:4000},()=>Array(50).fill(1));
 await expect(createHelpSpreadsheet({name:'Большой.xlsx',sheets:[{name:'Лист',headers,rows}]},signal())).rejects.toMatchObject({code:'HELP_OFFICE_TOO_LARGE'});
});
