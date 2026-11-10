import { mcpListTools, mcpOperation, readArguments } from '../src/modules/onec-personal/mcp';

const base = { key: 'test', label: 'Test', rpcUrl: 'https://onec.example.org/test/hs/mcp/rpc', legacyGuidBinding: false, allowVpnHttp: false };
const object = { metaType: 'Documents', name: 'РасходныйОрдерНаТовары', guid: 'e77f8004-c62d-11f1-9d3a-f1cbadb7fc65' };
function transport(page: (params: any) => any) {
  return jest.fn(async (_url: any, init: any) => {
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('alice:personal-secret').toString('base64'));
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: '1C' } } }, { headers: { 'mcp-session-id': 'personal-session' } });
    expect(init.headers['Mcp-Session-Id']).toBe('personal-session');
    if (req.method === 'notifications/initialized') return new Response(null, { status: 204 });
    expect(req.method).toBe('tools/list');
    return Response.json({ jsonrpc: '2.0', id: req.id, result: page(req.params) });
  });
}

test('personal tools/list follows cursors in one authenticated session and keeps catalog separate from call permissions', async () => {
  const fetch = transport(params => params.cursor ? { tools: [{ name: 'get_event_log', inputSchema: { type: 'object' } }] } : {
    tools: [{ name: 'get_object_history', description: 'History' }, { name: 'execute_code', annotations: { readOnlyHint: true } }], nextCursor: 'page-2',
  });
  const result = await mcpListTools(base, 'alice', 'personal-secret', undefined, fetch as any);
  expect(result).toEqual({ complete: true, tools: [{ name: 'get_object_history', description: 'History' }, { name: 'execute_code' }, { name: 'get_event_log', inputSchema: { type: 'object' } }] });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(() => readArguments('execute_code', {})).toThrow('ONEC_TOOL_FORBIDDEN');
  expect(() => readArguments('save_object', {})).toThrow('ONEC_TOOL_FORBIDDEN');
  expect(() => readArguments('new_unknown_read', {})).toThrow('ONEC_TOOL_FORBIDDEN');
});

test('catalog is explicitly incomplete at its page bound; repeated cursor is rejected', async () => {
  let n = 0;
  const fetch = transport(() => ({ tools: [{ name: `read_${++n}` }], nextCursor: `page-${n}` }));
  const result = await mcpListTools(base, 'alice', 'personal-secret', undefined, fetch as any);
  expect(result.complete).toBe(false); expect(result.tools).toHaveLength(8); expect(fetch).toHaveBeenCalledTimes(10);
  await expect(mcpListTools(base, 'alice', 'personal-secret', undefined, transport(() => ({ tools: [], nextCursor: 'repeat' })) as any)).rejects.toMatchObject({ code: 'ONEC_PROTOCOL_ERROR' });
});

test.each([
  {}, { tools: {} }, { tools: [{ name: '../private' }] }, { tools: [{ name: 'read', description: { injected: true } }] },
  { tools: [{ name: 'read', inputSchema: [] }] }, { tools: [{ name: 'read' }, { name: 'read' }] }, { tools: [], nextCursor: 7 },
])('malformed catalog cannot be treated as known capabilities: %j', async page => {
  await expect(mcpListTools(base, 'alice', 'personal-secret', undefined, transport(() => page) as any)).rejects.toMatchObject({ code: 'ONEC_PROTOCOL_ERROR' });
});

test('catalog entry bound preserves incompleteness without silently dropping capabilities', async () => {
  const tools = Array.from({ length: 257 }, (_, i) => ({ name: `read_${i}` }));
  const result = await mcpListTools(base, 'alice', 'personal-secret', undefined, transport(() => ({ tools })) as any);
  expect(result.tools).toHaveLength(256); expect(result.complete).toBe(false);
});

test('catalog authorization/RPC errors never echo upstream credentials or private details', async () => {
  const fail = jest.fn(async () => new Response('personal-secret upstream detail', { status: 401 }));
  await expect(mcpListTools(base, 'alice', 'personal-secret', undefined, fail)).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  const failure = jest.fn(async (_url: any, init: any) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32603, message: 'personal-secret upstream detail' } }));
  let e: unknown;
  try { await mcpListTools(base, 'alice', 'personal-secret', undefined, failure); } catch (error) { e = error; }
  expect(e).toMatchObject({ code: 'ONEC_RPC_ERROR' }); expect(JSON.stringify(e)).not.toMatch(/personal-secret|upstream/);
});

test('history explicitly defaults to snapshots and bounds pages without removing cursor or field', () => {
  expect(readArguments('get_object_history', object)).toEqual({ ...object, includeState: true, maxRows: 10 });
  expect(readArguments('get_object_history', { ...object, maxRows: 100, beforeVersion: 7, field: 'Статус' })).toEqual({ ...object, maxRows: 20, beforeVersion: 7, field: 'Статус', includeState: true });
  expect(readArguments('get_object_history', { ...object, includeState: false, maxRows: 100 })).toMatchObject({ maxRows: 100, includeState: false });
  for (const extra of [{ beforeVersion: 0 }, { maxRows: 101 }, { field: 'Статус;Удалить' }, { metaType: 'InformationRegisters' }, { write: true }]) {
    expect(() => readArguments('get_object_history', { ...object, ...extra })).toThrow('ONEC_TOOL_ARGUMENTS');
  }
});

test('event log accepts exact-object/time/level filters and rejects invalid/unbounded/write inputs', () => {
  const args = { object, startDate: '2026-10-12T00:00:00', endDate: '2026-11-10T23:59:59+07:00', levels: ['Error'], events: ['_$Data$_.SetDeletionMark'], metadata: ['Документ.РасходныйОрдерНаТовары'], comment: 'Пометка' };
  expect(readArguments('get_event_log', args)).toEqual({ ...args, maxRows: 200 });
  for (const invalid of [{ maxRows: 1001 }, { object: { ...object, write: true } }, { startDate: 'yesterday' }, { startDate: '2026-11-10T00:00:00Z', endDate: '2026-10-12T00:00:00Z' }, { levels: ['Debug'] }, { metadata: ['Документ.Имя;Удалить'] }, { privilegedMode: true }]) {
    expect(() => readArguments('get_event_log', invalid)).toThrow('ONEC_TOOL_ARGUMENTS');
  }
});

test('new history call preserves the same read transport and does not request tools/list as authorization', async () => {
  const fetch = jest.fn(async (_url: any, init: any) => {
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: '1C' } } });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 204 });
    expect(req.method).toBe('tools/call'); expect(req.params).toMatchObject({ name: 'get_object_history', arguments: { ...object, includeState: true, maxRows: 10 } });
    return Response.json({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: '{"versions":[]}' }] } });
  });
  expect(await mcpOperation(base, 'alice', 'personal-secret', { tool: 'get_object_history', args: object }, undefined, fetch as any)).toEqual({ text: '{"versions":[]}' });
});

test('navigation links accept only the verified read-object selector', () => {
  expect(readArguments('get_navigation_link', object)).toEqual(object);
  expect(() => readArguments('get_navigation_link', { ...object, privileged: true })).toThrow('ONEC_TOOL_ARGUMENTS');
  expect(() => readArguments('get_navigation_link', { ...object, guid: 'guessed-link' })).toThrow('ONEC_TOOL_ARGUMENTS');
});
