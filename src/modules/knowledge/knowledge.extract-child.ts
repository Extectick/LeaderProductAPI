// No API/DB imports or inherited application credentials in this parser process.
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from './knowledge.config';

async function extract(bytes: Buffer, extension: string): Promise<string> {
  if (extension === 'txt' || extension === 'md') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
