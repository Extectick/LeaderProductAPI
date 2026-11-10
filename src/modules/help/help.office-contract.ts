import { createHash } from 'node:crypto';
export type HelpSpreadsheetVerification = {
 method:'xlsx_readback_v1'; sha256:string; sheets:number; rows:number; columns:number;
 cells:number; numericCells:number; numericColumnsChecked:number; formulas:number;
 formulaResultsCalculated:false;
};
export type HelpOfficeFile = { name: string; mimeType: string; kind: 'FILE'; bytes: Buffer; reviewText?:string; verification?:HelpSpreadsheetVerification };
export const MAX_HELP_OFFICE_FILE_BYTES = 8 * 1024 * 1024;
export const HELP_OFFICE_MIME = {
 xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
export function validateHelpOfficeName(value: unknown, extension: 'xlsx'|'docx'): string {
 if(typeof value!=='string'||value.length<6||value.length>120||!/^[\p{L}\p{N} _().-]+$/u.test(value)||value.startsWith('.')||value.includes('..')||!value.toLowerCase().endsWith('.'+extension)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value))throw Object.assign(new Error('HELP_OFFICE_ARGUMENTS'),{code:'HELP_OFFICE_ARGUMENTS'});
 return value;
}
export function validateHelpOfficeFile(file:HelpOfficeFile):HelpOfficeFile {
 const extension=file.name.toLowerCase().endsWith('.xlsx')?'xlsx':file.name.toLowerCase().endsWith('.docx')?'docx':undefined;
 if(!extension||file.kind!=='FILE'||file.mimeType!==HELP_OFFICE_MIME[extension]||!Buffer.isBuffer(file.bytes)||file.bytes.length<4||file.bytes.length>MAX_HELP_OFFICE_FILE_BYTES||!file.bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])))throw Object.assign(new Error('HELP_OFFICE_INVALID_FILE'),{code:'HELP_OFFICE_INVALID_FILE'});
 if(file.verification&&(extension!=='xlsx'||file.verification.method!=='xlsx_readback_v1'||file.verification.sha256!==createHash('sha256').update(file.bytes).digest('hex')))throw Object.assign(new Error('HELP_OFFICE_INVALID_FILE'),{code:'HELP_OFFICE_INVALID_FILE'});
 validateHelpOfficeName(file.name,extension);return file;
}
