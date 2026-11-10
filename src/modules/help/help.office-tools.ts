import { createHash } from 'node:crypto';
import { z } from 'zod';
import {createHelpSpreadsheet,helpSpreadsheetParameters} from './help.office-xlsx';
import {createHelpDocument,helpDocumentParameters} from './help.office-docx';
import {validateHelpOfficeFile,type HelpOfficeFile} from './help.office-contract';
export type HelpOfficeTools={definitions:unknown[];files:HelpOfficeFile[];rememberData(output:string):string;call(name:string,args:unknown,signal:AbortSignal):Promise<string>};
type DataSource={rows:Array<Record<string,unknown>>;truncated:boolean};
type ExportInfo={dataSourceIds:string[];rowCount:number;partial:boolean;truncated:boolean};
const sourceArgs=z.object({
 name:z.string(),title:z.string().max(300).optional(),sheetName:z.string().min(1).max(31).optional(),
 dataSourceIds:z.array(z.string().regex(/^table-[1-9][0-9]*$/)).min(1).max(32),
 columns:z.array(z.object({key:z.string().min(1).max(300),header:z.string().min(1).max(300).optional(),numberFormat:z.string().max(100).optional()}).strict()).min(1).max(256).optional(),
}).strict();
const spreadsheetParameters={...helpSpreadsheetParameters,required:['name'],properties:{...helpSpreadsheetParameters.properties,
 dataSourceIds:{type:'array',minItems:1,maxItems:32,items:{type:'string'},description:'Идентификаторы dataSourceId из результатов чтения 1С текущего запуска. Данные попадут в Excel напрямую на сервере, без переписывания всех строк. Используй либо dataSourceIds, либо sheets.'},
 sheetName:{type:'string',minLength:1,maxLength:31,description:'Имя листа при экспорте dataSourceIds; по умолчанию Данные. Таблица данных сохраняет отдельные колонки даже при нуле найденных строк.'},
 columns:{type:'array',minItems:1,maxItems:256,items:{type:'object',additionalProperties:false,required:['key'],properties:{key:{type:'string',description:'Точное имя поля набора данных.'},header:{type:'string',description:'Название столбца Excel.'},numberFormat:{type:'string',description:'Формат Excel, например #,##0.00.'}}},description:'Выбранные поля, порядок, заголовки и форматы при использовании dataSourceIds. Все поля должны существовать в каждой непустой строке. Для пустого набора явно передай columns по полям проверенного запроса: получится таблица с заголовками и нулём строк данных.'},
}};
function fail(code='HELP_OFFICE_ARGUMENTS'):never{throw Object.assign(new Error(code),{code});}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Objects remain literal cells, never formula objects or model-supplied executable content. */
function cell(value:unknown):string|number|boolean|null{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))fail();return value;}
 if(record(value)&&value._objectRef===true&&typeof value.presentation==='string')return value.presentation;
 if(value===undefined)fail();
 const encoded=JSON.stringify(value);if(typeof encoded!=='string')fail();return encoded;
}
/** Only real server-created Office binaries are attached. No shell, macros or arbitrary model bytes. */
export function helpOfficeTools():HelpOfficeTools {
 const files:HelpOfficeFile[]=[],completed=new Map<string,{file:HelpOfficeFile;info?:ExportInfo}>(),sources=new Map<string,DataSource>();
 function spreadsheet(args:unknown):{args:unknown;info?:ExportInfo}{
  if(!record(args)||!Object.prototype.hasOwnProperty.call(args,'dataSourceIds'))return {args};
  const parsed=sourceArgs.safeParse(args);if(!parsed.success)fail();
  const input=parsed.data;
  if(new Set(input.dataSourceIds).size!==input.dataSourceIds.length)fail();
  const selected=input.dataSourceIds.map(id=>{const source=sources.get(id);if(!source)fail('HELP_OFFICE_DATA_SOURCE');return source;});
  const rows=selected.flatMap(source=>source.rows),keys=input.columns?.map(column=>column.key)||Object.keys(rows[0]||{});
  if(!keys.length||new Set(keys).size!==keys.length)fail();
  const expected=new Set(keys);
  for(const row of rows){
   if(!keys.every(key=>Object.prototype.hasOwnProperty.call(row,key)))fail();
   if(!input.columns&&(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!expected.has(key))))fail();
  }
  const partial=selected.some(source=>source.truncated);
  return {args:{name:input.name,...(input.title?{title:input.title}:{}),sheets:[{name:input.sheetName||'Данные',headers:input.columns?.map(column=>column.header||column.key)||keys,rows:rows.map(row=>keys.map(key=>cell(row[key]))),...(input.columns?.some(column=>column.numberFormat)?{numberFormats:input.columns.map(column=>column.numberFormat||'General')}:{})}]},
   info:{dataSourceIds:input.dataSourceIds,rowCount:rows.length,partial,truncated:partial}};
 }
 return {files,rememberData(output){
  try{
   const outer=JSON.parse(output);
   if(!record(outer)||outer.tool!=='onec_execute_query'||typeof outer.data!=='string')return output;
   const data=JSON.parse(outer.data);
   if(!record(data)||data.success!==true||!Array.isArray(data.data)||!Number.isSafeInteger(data.rowCount)||data.rowCount!==data.data.length||!data.data.every(record))return output;
   const dataSourceId=`table-${sources.size+1}`,truncated=data.truncated!==false;
   sources.set(dataSourceId,{rows:data.data,truncated});
   return JSON.stringify({...outer,dataSourceId,rowCount:data.data.length,truncated});
  }catch{return output;}
 },definitions:[
  {type:'function',name:'help_create_spreadsheet',strict:false,description:'Создать настоящий Excel-файл .xlsx. Для таблиц 1С используй dataSourceIds из результатов запросов: исходные строки будут перенесены сервером без потери числовых типов и без переписывания данных моделью. Несколько совместимых порций можно объединить. Если источник truncated=true, файл содержит только полученные порции и не доказывает полный экспорт. Можно также передать явные sheets из текущего диалога. Результат автоматически прикрепляется к текущему ответу; не заменяй CSV, если нужен Excel.',parameters:spreadsheetParameters},
  {type:'function',name:'help_create_document',strict:false,description:'Создать настоящий Word-файл .docx: заголовки, абзацы, списки и таблицы. Используй данные текущего диалога или подтверждённых результатов. Результат прикрепляется к ответу. Это создание файла, а не изменение 1С.',parameters:helpDocumentParameters},
 ],async call(name,args,signal){
  signal.throwIfAborted();
  if(!['help_create_spreadsheet','help_create_document'].includes(name))return JSON.stringify({error:'HELP_OFFICE_ARGUMENTS',label:'Неизвестный инструмент офисного документа.'});
  const signature=createHash('sha256').update(name+JSON.stringify(args)).digest('hex');
  try{
   let result=completed.get(signature);
   if(!result){
    const rendered:{args:unknown;info?:ExportInfo}=name==='help_create_spreadsheet'?spreadsheet(args):{args};
    let file=validateHelpOfficeFile(await(name==='help_create_spreadsheet'?createHelpSpreadsheet:createHelpDocument)(rendered.args,signal));
    signal.throwIfAborted();
    file={...file,reviewText:JSON.stringify(rendered.args)};
    const original=file.name;let version=1;
    while(files.some(item=>item.name.toLowerCase()===file.name.toLowerCase()))file={...file,name:original.replace(/\.(xlsx|docx)$/i,` (${++version}).$1`)};
    validateHelpOfficeFile(file);files.push(file);result={file,...(rendered.info?{info:rendered.info}:{})};completed.set(signature,result);
   }
   return JSON.stringify({created:true,name:result.file.name,mimeType:result.file.mimeType,size:result.file.bytes.length,...result.info,
    ...(result.file.verification?{verification:{...result.file.verification,basis:result.info?'server_data':'rendered_input',sourceCompleteness:result.info?(result.info.partial?'partial_or_unknown':'complete_received_result'):'not_applicable',filtersVerified:false}}:{}),
    note:result.info?.partial?'Файл создан из полученных порций; источник был усечён, поэтому полный набор данных не подтверждён. Файл будет прикреплён после проверки доступа и сохранения.':'Настоящий офисный файл подготовлен и будет прикреплён после сохранения и проверки доступа. Не придумывай URL.'});
  }catch(error){
   signal.throwIfAborted();
   const code=(error as {code?:string}).code;const argumentError=code==='HELP_OFFICE_ARGUMENTS'||(error as {name?:string}).name==='ZodError';
   return JSON.stringify({error:argumentError?'HELP_OFFICE_ARGUMENTS':code==='HELP_OFFICE_TOO_LARGE'?'HELP_OFFICE_TOO_LARGE':code==='HELP_OFFICE_DATA_SOURCE'?'HELP_OFFICE_DATA_SOURCE':'HELP_OFFICE_CREATE_FAILED',label:code==='HELP_OFFICE_DATA_SOURCE'?'Набор данных недоступен в текущем запуске. Используй dataSourceId из результата чтения 1С или передай таблицу явно.':argumentError?'Проверь имя файла и структуру таблиц или разделов документа.':'Не удалось создать офисный файл. Данные не сохранены в 1С.'});
  }
 }};
}
