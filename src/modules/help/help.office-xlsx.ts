import ExcelJS from 'exceljs';
import { z } from 'zod';
import { validateHelpOfficeName, MAX_HELP_OFFICE_FILE_BYTES, type HelpOfficeFile } from './help.office-contract';
import { verifyHelpSpreadsheet } from './help.office-verify';

const MAX_CELLS = 200000;
const formulaSchema = z.object({formula:z.string().trim().min(1).max(4000),result:z.union([z.string().max(32000),z.number().finite(),z.boolean()]).optional()}).strict();
const cellSchema = z.union([z.string().max(32000), z.number().finite(), z.boolean(), z.null(), formulaSchema]);
const sheetSchema = z.object({
  name: z.string().trim().min(1).max(31),
  headers: z.array(z.string().min(1).max(300)).min(1).max(256),
  rows: z.array(z.array(cellSchema).max(256)).max(20000),
  numberFormats: z.array(z.string().max(100)).max(256).optional(),
  columnWidths: z.array(z.number().min(3).max(100)).max(256).optional(),
}).strict();
const schema = z.object({
  name: z.string().trim().min(6).max(100),
  title: z.string().max(300).optional(),
  sheets: z.array(sheetSchema).min(1).max(20),
}).strict();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function formula(value:string):string {
  const normalized=value.startsWith('=')?value.slice(1):value;
  if(!normalized.trim() || /[\u0000-\u001f\u007f]/u.test(normalized))fail('HELP_OFFICE_ARGUMENTS');
  const expression=normalized.replace(/"(?:[^"]|"")*"/gu,'""');
  if(/[\[\]\\|]|:\/\//u.test(expression))fail('HELP_OFFICE_ARGUMENTS');
  // Spreadsheet expressions are stored, never evaluated here. Do not produce
  // formulas that fetch remote data, invoke DDE or legacy macro commands.
  const code=expression.replace(/'(?:[^']|'')*'/gu,"''");
  if(/(?:^|[^\p{L}\p{N}_])(?:_xlfn\.)?(?:WEBSERVICE|HYPERLINK|IMAGE|RTD|CALL|REGISTER(?:\.ID)?|EVALUATE|EXEC|RUN|DDE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTRANGE|SQL\.REQUEST|CUBEMEMBER|CUBEVALUE|CUBESET|GET\.(?:WORKSPACE|WORKBOOK|CELL)|SET\.NAME|FORMULA|FILES|DIRECTORY|FOPEN|FWRITE|SEND\.KEYS|ON\.TIME)\s*\(/iu.test(code))fail('HELP_OFFICE_ARGUMENTS');
  let depth=0,quote='';
  for(let i=0;i<normalized.length;i++) {
    const c=normalized[i];
    if(quote) { if(c===quote){if(normalized[i+1]===quote)i++;else quote='';}continue; }
    if(c==='"'||c==="'")quote=c;
    else if(c==='(')depth++;
    else if(c===')'&&--depth<0)fail('HELP_OFFICE_ARGUMENTS');
  }
  if(depth!==0||quote)fail('HELP_OFFICE_ARGUMENTS');
  return normalized;
}

/** Plain, portable schema. The model supplies table data, never executable code or a ZIP payload. */
export const helpSpreadsheetParameters = {
  type: 'object', additionalProperties: false, required: ['name', 'sheets'], properties: {
    name: { type: 'string', minLength: 6, maxLength: 100, description: 'Имя создаваемого файла .xlsx, без пути.' },
    title: { type: 'string', maxLength: 300, description: 'Название отчёта в свойствах книги.' },
    sheets: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['name','headers','rows'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 31, description: 'Имя листа Excel, уникальное в книге.' },
        headers: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 300 } },
        rows: { type: 'array', maxItems: 20000, items: { type: 'array', maxItems: 256, items: { anyOf: [{ type:'string',maxLength:32000 },{type:'number'},{type:'boolean'},{type:'null'},{type:'object',additionalProperties:false,required:['formula'],properties:{formula:{type:'string',minLength:1,maxLength:4000},result:{anyOf:[{type:'number'},{type:'string',maxLength:32000},{type:'boolean'}]}}}] } }, description: 'Строки в порядке заголовков. Суммы и количества передавай числами, а не форматированными строками. Текст остаётся текстом, даже если начинается с =. Для формулы передай объект с полем formula (например SUM(C2:C11)) и необязательным кэшированным значением result. Поддерживаются обычные локальные формулы Excel; внешние книги, сеть и макрокоманды не поддерживаются.' },
        numberFormats: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 100 }, description: 'Необязательно: форматы столбцов Excel, например 0 или #,##0.00.' },
        columnWidths: { type: 'array', maxItems: 256, items: { type: 'number', minimum: 3, maximum: 100 } },
      },
    } },
  },
};

/** Build real Office Open XML in memory; formulas are stored for Excel to calculate, never executed here. */
export async function createHelpSpreadsheet(args: unknown, signal: AbortSignal): Promise<HelpOfficeFile> {
  signal.throwIfAborted();
  const parsed = schema.safeParse(args);
  if (!parsed.success) fail('HELP_OFFICE_ARGUMENTS');
  validateHelpOfficeName(parsed.data.name,'xlsx');
  const input = parsed.data, names = new Set<string>();
  let cells = 0;
  for (const sheet of input.sheets) {
    if (/[\[\]:*?/\\\u0000-\u001f\u007f]/u.test(sheet.name) || /^'|'$/u.test(sheet.name) || names.has(sheet.name.toLocaleLowerCase('ru-RU')))
      fail('HELP_OFFICE_ARGUMENTS');
    names.add(sheet.name.toLocaleLowerCase('ru-RU'));
    if (sheet.rows.some(row => row.length > sheet.headers.length) ||
        (sheet.numberFormats?.length || 0) > sheet.headers.length || (sheet.columnWidths?.length || 0) > sheet.headers.length)
      fail('HELP_OFFICE_ARGUMENTS');
    for(const row of sheet.rows)for(const cell of row)if(cell&&typeof cell==='object')formula(cell.formula);
    cells += (sheet.rows.length + 1) * sheet.headers.length;
    if (cells > MAX_CELLS) fail('HELP_OFFICE_TOO_LARGE');
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Лидер Продукт';
  workbook.title = input.title || input.name.slice(0,-5);
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.created = new Date();
  workbook.modified = workbook.created;
  for (const data of input.sheets) {
    signal.throwIfAborted();
    const sheet = workbook.addWorksheet(data.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(data.headers);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245477' } };
    sheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    sheet.getRow(1).height = 28;
    for (const row of data.rows) {
      signal.throwIfAborted();
      // An explicit formula object is distinct from a literal =... string.
      const outputRow=sheet.addRow(row.map(cell=>cell&&typeof cell==='object'?{formula:formula(cell.formula),...(cell.result!==undefined?{result:cell.result}:{})}:cell));
      // Materialize even a trailing all-null source row in the actual XLSX.
      if(row.every(cell=>cell===null))outputRow.height=15;
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.rows.length + 1, column: data.headers.length } };
    data.headers.forEach((header,index)=>{
      const column = sheet.getColumn(index + 1);
      column.width = data.columnWidths?.[index] || Math.min(60, Math.max(12, Array.from(header).length + 3,
        ...data.rows.slice(0,200).map(row=>Math.min(60,Array.from(String(row[index] ?? '')).length + 2))));
      if (data.numberFormats?.[index]) column.numFmt = data.numberFormats[index];
      column.alignment = { vertical: 'top', wrapText: true };
    });
  }
  signal.throwIfAborted();
  let result: Buffer;
  try { result = Buffer.from(await workbook.xlsx.writeBuffer()); }
  catch { fail('HELP_OFFICE_BUILD_FAILED'); }
  signal.throwIfAborted();
  if (!result.length || result.length > MAX_HELP_OFFICE_FILE_BYTES) fail('HELP_OFFICE_TOO_LARGE');
  const verification=await verifyHelpSpreadsheet(result,input.sheets,signal);
  return { name: input.name, kind: 'FILE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: result, verification };
}
