import { z } from 'zod';
import { OnecBase, OnecPersonalError } from './config';

const name = z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,99}$/u);
const metaType = z.enum(['Catalogs','Documents','InformationRegisters','AccumulationRegisters','Reports','Enums']);
export const readToolSchemas = {
  list_metadata_objects: z.object({ metaType, nameMask: z.string().max(100).optional() }).strict(),
  get_metadata_structure: z.object({ metaType, name }).strict(),
  get_access_rights: z.object({ metadata: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]*\.[\p{L}_][\p{L}\p{N}_]*$/u) }).strict(),
  get_object: z.object({ metaType: z.enum(['Catalogs','Documents']), name, guid: z.uuid() }).strict(),
  execute_query: z.object({ query: z.string().max(6000), parameters: z.record(z.string().max(80), z.unknown()).optional() }).strict(),
} as const;
export type ReadTool = keyof typeof readToolSchemas;
export function readArguments(tool: string, args: unknown): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(readToolSchemas, tool)) throw new OnecPersonalError('ONEC_TOOL_FORBIDDEN', 403);
  const parsed = readToolSchemas[tool as ReadTool].safeParse(args);
  if (!parsed.success) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const value: Record<string, unknown> = parsed.data;
  if (tool === 'execute_query') {
    const q = String(value.query);
    const limit = q.match(/^\s*(?:ВЫБРАТЬ(?:\s+РАЗРЕШЕННЫЕ)?\s+ПЕРВЫЕ|SELECT\s+TOP)\s+(\d+)\b/iu);
    if (!limit || Number(limit[1]) < 1 || Number(limit[1]) > 100 || /;|--|\/\*|ДЛЯ\s+ИЗМЕНЕНИЯ|FOR\s+UPDATE|ПОМЕСТИТЬ|INTO\s|УНИЧТОЖИТЬ/iu.test(q)) throw new OnecPersonalError('ONEC_QUERY_FORBIDDEN', 403);
    value.maxRows = Math.min(100, Number(limit[1])); value.includeColumnTypes = false;
  }
  if (tool === 'get_object') { value.includeTabularSections = false; value.maxTabularRows = 0; }
  if (tool === 'get_metadata_structure') value.sections = ['fields'];
  if (tool === 'list_metadata_objects') value.maxItems = 50;
  if (JSON.stringify(value).length > 12000) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  return value;
}
async function boundedJson(response: Response) {
  if (!response.body) return null;
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.byteLength; if (bytes > 131072) throw new OnecPersonalError('ONEC_RESPONSE_TOO_LARGE', 502); parts.push(r.value); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** A client lives for one operation and one identity. No global sessions or shared-account fallback. */
export async function mcpOperation(base: OnecBase, login: string, password: string, operation?: { tool: string; args: unknown }, signal?: AbortSignal, transport: typeof fetch = fetch) {
  const args = operation ? readArguments(operation.tool, operation.args) : undefined;
  if (!login || login.includes(':') || /[\r\n\0]/.test(login + password)) throw new OnecPersonalError('ONEC_BAD_CREDENTIALS');
  const headers: Record<string, string> = { Authorization: 'Basic ' + Buffer.from(login + ':' + password).toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const timeout = AbortSignal.timeout(20000), abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let id = 0;
  const rpc = async (method: string, params: unknown, notification = false) => {
    const response = await transport(base.rpcUrl, { method: 'POST', redirect: 'error', signal: abort, headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, params }) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new OnecPersonalError(response.status === 401 ? 'ONEC_AUTH_REQUIRED' : response.status === 403 ? 'ONEC_ACCESS_DENIED' : 'ONEC_UNAVAILABLE', response.status === 401 || response.status === 403 ? 422 : 503); }
    const session = response.headers.get('mcp-session-id'); if (session && /^[\x21-\x7e]{1,256}$/.test(session)) headers['Mcp-Session-Id'] = session;
    if (response.status === 204 || notification) { await response.body?.cancel().catch(() => {}); return null; }
    const body = await boundedJson(response);
    if (!body || body.jsonrpc !== '2.0' || body.id !== id || body.error) throw new OnecPersonalError('ONEC_RPC_ERROR', 502);
    return body.result;
  };
  try {
    const hello = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'LeaderProduct', version: '1.0.0' } });
    if (!hello?.serverInfo || hello.protocolVersion !== '2025-03-26') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
    headers['MCP-Protocol-Version'] = hello.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    if (!operation) return { connected: true };
    const result = await rpc('tools/call', { name: operation.tool, arguments: args });
    // Tool errors may include request arguments/data. Do not echo upstream diagnostics to logs/model/UI.
    if (result?.isError) throw new OnecPersonalError('ONEC_TOOL_FAILED', 422);
    const text = (Array.isArray(result?.content) ? result.content : []).filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
    if (text.length > 40000) throw new OnecPersonalError('ONEC_RESPONSE_TOO_LARGE', 502);
    return { text };
  } catch (e) {
    if (e instanceof OnecPersonalError) throw e;
    throw new OnecPersonalError(abort.aborted ? 'ONEC_TIMEOUT' : 'ONEC_UNAVAILABLE', 503);
  } finally { delete headers.Authorization; }
}
