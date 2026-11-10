export type HelpAIActivity = {
  id: string; kind: 'analysis' | 'knowledge' | 'tool' | 'status'; label: string;
  status: 'running' | 'completed' | 'failed' | 'stopped'; text?: string;
  startedAt?: number; completedAt?: number;
  toolName?: string; errorCode?: string; durationMs?: number;
};
export type HelpAIProgressUpdate = { activity?: HelpAIActivity; draftText?: string; phase?: string; flush?: boolean;
  validateAppAccess?: (db:import('@prisma/client').Prisma.TransactionClient)=>Promise<void>;
  validationSources?: import('./help.knowledge').HelpKnowledgeSource[];
  validationProofs?: import('../onec-personal/service').OnecProof[] };
export type HelpAIProgress = (update: HelpAIProgressUpdate) => Promise<void>;

/** Decode only a complete top-level string value's available prefix, never raw JSON or tool arguments. */
export function streamedStringField(json: string, field: string): string {
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    if (json[i] === '{' || json[i] === '[') { depth++; continue; }
    if (json[i] === '}' || json[i] === ']') { depth--; continue; }
    if (json[i] !== '"') continue;
    const start = i++;
    for (; i < json.length; i++) { if (json[i] === '\\') { i++; continue; } if (json[i] === '"') break; }
    if (i >= json.length) return '';
    let key: string; try { key = JSON.parse(json.slice(start, i + 1)); } catch { return ''; }
    if (depth !== 1 || key !== field) continue;
    let next = i + 1; while (/\s/.test(json[next] || '') && next < json.length) next++;
    if (json[next++] !== ':') continue;
    while (/\s/.test(json[next] || '') && next < json.length) next++;
    if (json[next++] !== '"') return '';
    let value = '';
    for (; next < json.length; next++) {
      const char = json[next];
      if (char === '"') return value;
      if (char !== '\\') { if (char.charCodeAt(0) < 32) return ''; value += char; continue; }
      const escape = json[++next]; if (!escape) break;
      if (escape === 'u') {
        const hex = json.slice(next + 1, next + 5); if (!/^[\da-f]{4}$/i.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16)); next += 4;
      } else {
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (!(escape in escapes)) return ''; value += escapes[escape];
      }
    }
    // A high surrogate at a chunk boundary must wait for its low surrogate.
    return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
  }
  return '';
}

export class HelpAIStreamError extends Error {}
/** Bounded SSE framing; supports CRLF, split UTF-8, multiple events and multiline data. */
export async function readHelpAIStream(response: Response, onEvent: (event: Record<string, any>) => Promise<void>): Promise<unknown> {
  if (!response.body) throw new HelpAIStreamError('EMPTY');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', size = 0, terminal: unknown;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new HelpAIStreamError('SIZE');
      pending += decoder.decode(part.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 1024 * 1024) throw new HelpAIStreamError('FRAME');
        const block = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (!event || typeof event.type !== 'string') throw new HelpAIStreamError('EVENT');
        if (event.type === 'error' || event.type === 'response.failed') throw new HelpAIStreamError('PROVIDER');
        await onEvent(event);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') terminal = event.response;
      }
      if (pending.length > 1024 * 1024) throw new HelpAIStreamError('FRAME');
    }
    if (!terminal) throw new HelpAIStreamError('INCOMPLETE');
    return terminal;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
