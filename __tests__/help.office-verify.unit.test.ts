jest.mock('exceljs',()=>jest.requireActual('../node_modules/exceljs'));
import ExcelJS from 'exceljs';
import { createHelpSpreadsheet } from '../src/modules/help/help.office-xlsx';
import { verifyHelpSpreadsheet } from '../src/modules/help/help.office-verify';
import { validateHelpOfficeFile } from '../src/modules/help/help.office-contract';
import { helpOfficeTools } from '../src/modules/help/help.office-tools';
const signal=()=>new AbortController().signal;
const sheets=[{name:'Данные',headers:['Имя','Сумма','Активен'],rows:[['Анна',-10.25,false],['Борис',0,true],['Вера',20.75,null],['',null,null],[null,null,null]]}];
async function generated(){return createHelpSpreadsheet({name:'Проверка.xlsx',sheets},signal());}
async function changed(change:(book:InstanceType<typeof ExcelJS.Workbook>)=>void){
 const file=await generated(),book=new ExcelJS.Workbook();
 await book.xlsx.load(file.bytes as any);change(book);return Buffer.from(await book.xlsx.writeBuffer());
}
test('readback proves typed cells, negative/zero numbers and trailing null row dimensions',async()=>{
 const file=await generated();expect(file.verification).toMatchObject({method:'xlsx_readback_v1',sheets:1,rows:5,columns:3,cells:18,numericCells:3,numericColumnsChecked:1,formulas:0,formulaResultsCalculated:false});
 expect(validateHelpOfficeFile(file)).toBe(file);
});
test.each([
 ['changed values with unchanged sum',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].getCell('B2').value=-9.25;book.worksheets[0].getCell('B4').value=19.75;}],
 ['numeric zero replaced by text',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].getCell('B3').value='0';}],
 ['negative value dropped',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].getCell('B2').value=null;}],
 ['missing source row',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].spliceRows(3,1);}],
 ['extra source row',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].addRow(['Injected',1,true]);}],
 ['changed column header',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].getCell('B1').value='Другая сумма';}],
 ['extra column',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].getCell('D2').value='Injected';}],
 ['extra sheet',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.addWorksheet('Injected');}],
 ['sheet renamed',(book:InstanceType<typeof ExcelJS.Workbook>)=>{book.worksheets[0].name='Other';}],
])('rejects actual XLSX corruption: %s',async(_label,change)=>{
 await expect(verifyHelpSpreadsheet(await changed(change),sheets,signal())).rejects.toMatchObject({code:'HELP_OFFICE_VERIFICATION_FAILED'});
});
test('proof is bound to the exact bytes, not just a valid ZIP signature',async()=>{
 const file=await generated();expect(()=>validateHelpOfficeFile({...file,bytes:Buffer.concat([file.bytes,Buffer.from('changed')])})).toThrow('HELP_OFFICE_INVALID_FILE');
});
test('formula zero/false caches survive readback without claiming calculated results',async()=>{
 const file=await createHelpSpreadsheet({name:'Формулы.xlsx',sheets:[{name:'Формулы',headers:['A'],rows:[[{formula:'SUM(0)',result:0}],[{formula:'FALSE()',result:false}],[{formula:'IF(1,"","")',result:''}]]}]},signal());
 expect(file.verification).toMatchObject({formulas:3,formulaResultsCalculated:false,numericCells:0});
});
test('source export receipt reports only provable completeness and filter limits',async()=>{
 const tools=helpOfficeTools();
 for(const truncated of [false,true,undefined])tools.rememberData(JSON.stringify({tool:'onec_execute_query',data:JSON.stringify({success:true,rowCount:1,truncated,data:[{A:-5,B:0}]})}));
 for(let i=1;i<=3;i++){
  const result=JSON.parse(await tools.call('help_create_spreadsheet',{name:`Источник${i}.xlsx`,dataSourceIds:[`table-${i}`]},signal()));
  expect(result.verification).toMatchObject({basis:'server_data',rows:1,numericCells:2,numericColumnsChecked:2,filtersVerified:false,sourceCompleteness:i===1?'complete_received_result':'partial_or_unknown'});
 }
 const result=JSON.parse(await tools.call('help_create_spreadsheet',{name:'Явный.xlsx',sheets},signal()));
 expect(result.verification).toMatchObject({basis:'rendered_input',filtersVerified:false,sourceCompleteness:'not_applicable'});
});
test('a serializer returning a different valid workbook cannot publish an attachment',async()=>{
 const wrongBytes=await changed(book=>{book.worksheets[0].getCell('B3').value=999;});
 const writer=jest.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx),'writeBuffer').mockResolvedValueOnce(wrongBytes);
 try {
  const tools=helpOfficeTools();const result=JSON.parse(await tools.call('help_create_spreadsheet',{name:'Проверка.xlsx',sheets},signal()));
  expect(result).toMatchObject({error:'HELP_OFFICE_CREATE_FAILED'});expect(tools.files).toEqual([]);
 } finally {writer.mockRestore();}
});
test('unreadable bytes and cancellation fail without a verification receipt',async()=>{
 await expect(verifyHelpSpreadsheet(Buffer.from('PK\u0003\u0004broken'),sheets,signal())).rejects.toMatchObject({code:'HELP_OFFICE_VERIFICATION_FAILED'});
 const abort=new AbortController();abort.abort(new Error('cancel verification'));
 await expect(verifyHelpSpreadsheet((await generated()).bytes,sheets,abort.signal)).rejects.toThrow('cancel verification');
});
