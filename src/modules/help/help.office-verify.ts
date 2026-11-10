import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { HelpSpreadsheetVerification } from './help.office-contract';

type Literal = string|number|boolean|null;
type InputCell = Literal|{formula:string;result?:string|number|boolean};
type InputSheet = {name:string;headers:string[];rows:InputCell[][];numberFormats?:string[]};
function mismatch():never { throw Object.assign(new Error('HELP_OFFICE_VERIFICATION_FAILED'),{code:'HELP_OFFICE_VERIFICATION_FAILED'}); }

/** Compare the persisted artifact, not the in-memory builder. This proves the
 * supplied table survived serialization, not business filters or formula maths. */
export async function verifyHelpSpreadsheet(bytes:Buffer, expected:InputSheet[], signal:AbortSignal):Promise<HelpSpreadsheetVerification> {
 signal.throwIfAborted();
 const book=new ExcelJS.Workbook();
 try { await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]); } catch { signal.throwIfAborted(); mismatch(); }
 signal.throwIfAborted();
 if(book.worksheets.length!==expected.length)mismatch();
 const proof:HelpSpreadsheetVerification={method:'xlsx_readback_v1',sha256:createHash('sha256').update(bytes).digest('hex'),sheets:expected.length,rows:0,columns:0,cells:0,numericCells:0,numericColumnsChecked:0,formulas:0,formulaResultsCalculated:false};
 for(let index=0;index<expected.length;index++) {
  const source=expected[index], sheet=book.worksheets[index], width=source.headers.length;
  if(sheet.name!==source.name||sheet.rowCount!==source.rows.length+1||sheet.columnCount!==width)mismatch();
  const lastAddress=sheet.getCell(source.rows.length+1,width).address;
  if(sheet.autoFilter!==`A1:${lastAddress}`)mismatch();
  proof.rows+=source.rows.length;proof.columns+=width;proof.cells+=(source.rows.length+1)*width;
  for(let c=0;c<width;c++) {
   if(sheet.getCell(1,c+1).value!==source.headers[c])mismatch();
   let expectedSum=0,actualSum=0,numericCount=0;
   for(let r=0;r<source.rows.length;r++) {
    if(r%256===0)signal.throwIfAborted();
    const input=source.rows[r][c]??null, actual=sheet.getCell(r+2,c+1);
    if(input!==null&&typeof input==='object') {
     const expression=input.formula.startsWith('=')?input.formula.slice(1):input.formula;
     if(actual.type!==ExcelJS.ValueType.Formula||actual.formula!==expression)mismatch();
     // ExcelJS's value getter omits false/0 caches; result preserves them.
     // An empty-string cache is represented as an empty <v/> on disk.
     if(input.result!==actual.result&&!(input.result===''&&actual.result===undefined))mismatch();
     proof.formulas++;
    } else {
     if(actual.value!==input)mismatch();
     if(typeof input==='number') {expectedSum+=input;actualSum+=actual.value as number;numericCount++;}
    }
    if(source.numberFormats?.[c]&&(actual.numFmt||'General')!==source.numberFormats[c])mismatch();
   }
   // Cell identity remains the primary guarantee, even when a floating-point
   // sum overflows; never call an infinite/NaN aggregate verified.
   proof.numericCells+=numericCount;
   if(numericCount&&Number.isFinite(expectedSum)&&Number.isFinite(actualSum)) {
    if(expectedSum!==actualSum)mismatch();
    proof.numericColumnsChecked++;
   }
  }
 }
 signal.throwIfAborted();
 return proof;
}
