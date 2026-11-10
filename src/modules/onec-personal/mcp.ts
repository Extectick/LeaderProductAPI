import { z } from 'zod';
import { OnecBase, OnecPersonalError } from './config';
import { onecQueryFailure } from './mcp-diagnostics';

const name = z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,99}$/u);
export const onecListMetadataTypes = ["Catalogs", "Documents", "InformationRegisters", "AccumulationRegisters", "AccountingRegisters", "CalculationRegisters", "ChartsOfCharacteristicTypes", "ChartsOfAccounts", "ChartsOfCalculationTypes", "BusinessProcesses", "Tasks", "ExchangePlans", "FilterCriteria", "Reports", "DataProcessors", "Enums", "CommonModules", "SessionParameters", "CommonTemplates", "CommonPictures", "XDTOPackages", "WebServices", "HTTPServices", "WSReferences", "Styles", "Languages", "FunctionalOptions", "FunctionalOptionsParameters", "DefinedTypes", "CommonAttributes", "CommonCommands", "CommandGroups", "Constants", "CommonForms", "Roles", "Subsystems", "EventSubscriptions", "ScheduledJobs", "SettingsStorages", "Sequences", "DocumentJournals", "ExternalDataSources", "Interfaces"] as const;
export const onecStructureMetadataTypes = ["Catalogs", "Documents", "InformationRegisters", "AccumulationRegisters", "AccountingRegisters", "CalculationRegisters", "Reports", "DataProcessors", "ChartsOfCharacteristicTypes", "ChartsOfAccounts", "ChartsOfCalculationTypes", "BusinessProcesses", "Tasks", "ExchangePlans", "Enums"] as const;
export const onecObjectTypes = ["Catalogs", "Documents", "BusinessProcesses", "Tasks", "ExchangePlans", "ChartsOfCharacteristicTypes", "ChartsOfAccounts", "ChartsOfCalculationTypes"] as const;
export const onecMetadataSections = ["fields", "tabular_sections", "predefined", "owners", "register_records", "subsystems"] as const;
const objectReference = z.object({ metaType: z.enum(onecObjectTypes), name, guid: z.uuid() }).strict();
const isoDate = z.iso.datetime({ offset: true, local: true });
const metadataName = z.string().regex(/^[\p{L}_][\p{L}\p{N}_]*\.[\p{L}_][\p{L}\p{N}_]*$/u).max(201);
export const readToolSchemas = {
  list_metadata_objects: z.object({ metaType: z.enum(onecListMetadataTypes), nameMask: z.string().max(100).optional(), maxItems: z.number().int().min(1).max(1000).optional() }).strict(),
  get_metadata_structure: z.object({ metaType: z.enum(onecStructureMetadataTypes), name, sections: z.array(z.enum(onecMetadataSections)).min(1).max(6).optional(), maxTypesInComposite: z.number().int().min(0).max(1000).optional() }).strict(),
  get_access_rights: z.object({ metadata: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]*\.[\p{L}_][\p{L}\p{N}_]*$/u) }).strict(),
  get_object: z.object({ metaType: z.enum(onecObjectTypes), name, guid: z.uuid(), includeTabularSections: z.boolean().optional(), maxTabularRows: z.number().int().min(1).max(1000).optional() }).strict(),
  get_navigation_link: objectReference,
  get_object_history: objectReference.extend({ maxRows: z.number().int().min(1).max(100).optional(), beforeVersion: z.number().int().min(1).optional(), includeState: z.boolean().optional(), field: name.optional() }).strict(),
  get_event_log: z.object({ object: objectReference.optional(), startDate: isoDate.optional(), endDate: isoDate.optional(), levels: z.array(z.enum(['Information', 'Warning', 'Error', 'Note'])).min(1).max(4).optional(), events: z.array(z.string().min(1).max(200)).min(1).max(100).optional(), metadata: z.array(metadataName).min(1).max(100).optional(), comment: z.string().max(1000).optional(), maxRows: z.number().int().min(1).max(1000).optional() }).strict().refine(v => !v.startDate || !v.endDate || Date.parse(v.startDate) <= Date.parse(v.endDate)),
  execute_query: z.object({ query: z.string().max(6000), parameters: z.record(z.string().max(80), z.unknown()).optional(), maxRows: z.number().int().min(1).max(1000).optional() }).strict(),
} as const;
export type ReadTool = keyof typeof readToolSchemas;
export function readArguments(tool: string, args: unknown): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(readToolSchemas, tool)) throw new OnecPersonalError('ONEC_TOOL_FORBIDDEN', 403);
  const parsed = readToolSchemas[tool as ReadTool].safeParse(args);
  if (!parsed.success) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const value: Record<string, unknown> = parsed.data;
  // This MCP searches metadata by substring, not SQL LIKE or glob syntax.
  if (tool === 'list_metadata_objects' && typeof value.nameMask === 'string') value.nameMask = value.nameMask.replace(/^[*%]+|[*%]+$/g, '');
  if (tool === 'execute_query') {
    const q = String(value.query);
    // maxRows is a response page bound, not a filter on records used by COUNT/SUM.
    // Keep the tool read-only even when a read has no inline TOP/FIRST clause.
    const select = /^\s*(?:ВЫБРАТЬ|SELECT)(?=\s|$)/iu.test(q);
    const limit = q.match(/^\s*(?:ВЫБРАТЬ(?:\s+(?:РАЗРЕШЕННЫЕ|РАЗЛИЧНЫЕ))*\s+ПЕРВЫЕ|SELECT(?:\s+DISTINCT)?\s+TOP)\s+(\d+)\b/iu);
    const top = limit ? Number(limit[1]) : undefined;
    const unsafe = /;|--|\/\*|ДЛЯ\s+ИЗМЕНЕНИЯ|FOR\s+UPDATE|ПОМЕСТИТЬ|INTO\s|УНИЧТОЖИТЬ|\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC(?:UTE)?|GRANT|REVOKE)\b/iu.test(q);
    if (!select || unsafe || top !== undefined && (top < 1 || top > 1000)) throw new OnecPersonalError('ONEC_QUERY_FORBIDDEN', 403);
    value.maxRows = Math.min(Number(value.maxRows ?? top ?? 100), top ?? 1000); value.includeColumnTypes = false;
  }
  if (tool === 'get_object_history') {
    value.includeState = value.includeState !== false;
    value.maxRows = Math.min(Number(value.maxRows ?? 10), value.includeState ? 20 : 100);
  }
  if (tool === 'get_event_log') value.maxRows = value.maxRows ?? 200;
  if (tool === 'get_object') {
    value.includeTabularSections = value.includeTabularSections === true;
    value.maxTabularRows = value.includeTabularSections ? value.maxTabularRows ?? 20 : 0;
  }
  if (tool === 'get_metadata_structure') value.sections = value.sections ?? (value.metaType === 'Documents' ? ['fields','tabular_sections'] : ['fields']);
  if (tool === 'list_metadata_objects') value.maxItems = value.maxItems ?? 100;
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
export type OnecMcpCatalog = { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>; complete: boolean };

/** A client lives for one operation and one identity. No global sessions or shared-account fallback. */
async function mcpSession(base: OnecBase, login: string, password: string, operation?: { tool: string; args: unknown }, signal?: AbortSignal, transport: typeof fetch = fetch, discover = false) {
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
    if (!body || body.jsonrpc !== '2.0' || body.id !== id) throw new OnecPersonalError('ONEC_RPC_ERROR', 502);
    if (body.error) {
      if (operation?.tool === 'execute_query' && method === 'tools/call') throw onecQueryFailure(body.error.message, 'ONEC_RPC_ERROR');
      throw new OnecPersonalError('ONEC_RPC_ERROR', 502);
    }
    return body.result;
  };
  try {
    const hello = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'LeaderProduct', version: '1.0.0' } });
    if (!hello?.serverInfo || hello.protocolVersion !== '2025-03-26') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
    headers['MCP-Protocol-Version'] = hello.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    if (discover) {
      const catalog: OnecMcpCatalog = { tools: [], complete: false }, cursors = new Set<string>(), names = new Set<string>();
      let cursor: string | undefined, totalChars = 0;
      for (let page = 0; page < 8; page++) {
        const result = await rpc('tools/list', cursor ? { cursor } : {});
        if (!result || !Array.isArray(result.tools)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
        for (const item of result.tools) {
          if (!item || typeof item.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(item.name) || names.has(item.name)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
          if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 4000)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
          if (item.inputSchema !== undefined && (!item.inputSchema || typeof item.inputSchema !== 'object' || Array.isArray(item.inputSchema) || JSON.stringify(item.inputSchema).length > 32000)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
          const tool = { name: item.name, ...(item.description !== undefined ? { description: item.description } : {}), ...(item.inputSchema !== undefined ? { inputSchema: item.inputSchema } : {}) };
          const size = JSON.stringify(tool).length;
          if (catalog.tools.length >= 256 || totalChars + size > 131072) return { catalog };
          catalog.tools.push(tool); names.add(item.name); totalChars += size;
        }
        if (result.nextCursor === undefined || result.nextCursor === null) { catalog.complete = true; return { catalog }; }
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
        cursor = result.nextCursor as string; cursors.add(cursor);
      }
      return { catalog };
    }
    if (!operation) return { connected: true };
    const requestedRows = Number(args?.maxRows), queryArgs = { ...args };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await rpc('tools/call', { name: operation.tool, arguments: queryArgs });
        const text = (Array.isArray(result?.content) ? result.content : []).filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
        // Never echo upstream diagnostics. Numeric positions and fixed cause codes
        // let the agent correct its own query without disclosing SQL/credentials.
        if (result?.isError) throw operation.tool === 'execute_query' ? onecQueryFailure(text) : new OnecPersonalError('ONEC_TOOL_FAILED', 422);
        if (text.length > 40000) throw new OnecPersonalError('ONEC_RESPONSE_TOO_LARGE', 502);
        if (attempt && operation.tool === 'execute_query') {
          let data: any; try { data = JSON.parse(text); } catch { throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502); }
          if (data?.success !== true || !Array.isArray(data.data) || data.rowCount !== data.data.length || typeof data.truncated !== 'boolean') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
          return { text: JSON.stringify({ ...data, requestedMaxRows: requestedRows, pageLimitApplied: queryArgs.maxRows, responseSizeReduced: true }) };
        }
        return { text };
      } catch (e) {
        // maxRows bounds the returned page, not the query's source/aggregate. Retry
        // only a read that exceeded the byte limit; retain the exact query/params,
        // identity and deadline and require the server's explicit truncation flag.
        const rows = Number(queryArgs.maxRows);
        if (!(e instanceof OnecPersonalError) || e.code !== 'ONEC_RESPONSE_TOO_LARGE' || operation.tool !== 'execute_query' || rows <= 1 || attempt >= 5) throw e;
        queryArgs.maxRows = Math.max(1, Math.floor(rows / 4));
        abort.throwIfAborted();
      }
    }
  } catch (e) {
    if (e instanceof OnecPersonalError) throw e;
    throw new OnecPersonalError(abort.aborted ? 'ONEC_TIMEOUT' : 'ONEC_UNAVAILABLE', 503);
  } finally { delete headers.Authorization; }
}

/** Catalog metadata is untrusted discovery data, never permission to execute a tool. */
export async function mcpListTools(base: OnecBase, login: string, password: string, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<OnecMcpCatalog> {
  const result = await mcpSession(base, login, password, undefined, signal, transport, true);
  if (!result.catalog) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  return result.catalog;
}
export async function mcpOperation(base: OnecBase, login: string, password: string, operation?: { tool: string; args: unknown }, signal?: AbortSignal, transport: typeof fetch = fetch) {
  const { catalog: _catalog, ...result } = await mcpSession(base, login, password, operation, signal, transport);
  return result;
}
