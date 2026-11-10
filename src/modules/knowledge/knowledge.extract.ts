import { spawn } from 'node:child_process';
import path from 'node:path';
import { KnowledgeError, MAX_FILE_BYTES, MAX_TEXT_CHARS } from './knowledge.config';

export function extractKnowledgeText(bytes: Buffer, extension: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new KnowledgeError(409, 'EXTRACTION_CANCELLED'));
  if (bytes.length > MAX_FILE_BYTES) return Promise.reject(new KnowledgeError(413, 'DOCUMENT_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    // Use the compiled entry point in development too: no ts-node or API environment in the child.
    const filename = path.resolve(__dirname.includes(`${path.sep}dist${path.sep}`) ? __dirname :
      path.resolve(__dirname, '../../..', 'dist/modules/knowledge'), 'knowledge.extract-child.js');
    const child = spawn(process.execPath, ['--max-old-space-size=192', filename, extension], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, LANG: 'C.UTF-8' },
    });
    let output = '', settled = false;
    const abort = () => finish(new KnowledgeError(409, 'EXTRACTION_CANCELLED'));
    const finish = (error?: Error, text?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(text!);
    };
    const timer = setTimeout(() => finish(new KnowledgeError(422, 'EXTRACTION_TIMEOUT')), 25000);
    timer.unref();
    child.on('error', () => finish(new KnowledgeError(503, 'EXTRACTOR_UNAVAILABLE')));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      if (output.length > MAX_TEXT_CHARS * 6 + 1000) finish(new KnowledgeError(413, 'DOCUMENT_TOO_LARGE'));
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(output);
        if (code === 0 && typeof result.text === 'string' && result.text.length > 0 && result.text.length <= MAX_TEXT_CHARS) return finish(undefined, result.text);
        const allowed = ['DOCUMENT_TOO_LARGE', 'UNSUPPORTED_FORMAT', 'INVALID_DOCUMENT', 'NO_TEXT_OCR_REQUIRED', 'EXTRACTION_FAILED'];
        finish(new KnowledgeError(422, allowed.includes(result.error) ? result.error : 'EXTRACTION_FAILED'));
      } catch { finish(new KnowledgeError(422, 'EXTRACTION_FAILED')); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!settled) child.stdin.end(bytes);
  });
}

export function chunkKnowledgeText(text: string, size = 1600, overlap = 200): string[] {
  if (size <= overlap || overlap < 0 || size < 100) throw new Error('Invalid chunk limits');
  const chunks: string[] = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (boundary > start + size / 2) end = boundary;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const part = text.slice(start, end).trim(); if (part) chunks.push(part);
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
    if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  }
  return chunks;
}
