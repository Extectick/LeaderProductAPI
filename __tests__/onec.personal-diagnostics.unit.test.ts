import { mcpOperation } from '../src/modules/onec-personal/mcp';
import { onecQueryFailure } from '../src/modules/onec-personal/mcp-diagnostics';
import { helpOnecFailure } from '../src/modules/help/help.onec-errors';

const base = { key: 'test', label: 'Test', rpcUrl: 'https://onec.example.org/test/hs/mcp/rpc', legacyGuidBinding: false, allowVpnHttp: false };
const query = 'ВЫБРАТЬ Версии.НомерВерсии ИЗ РегистрСведений.ВерсииОбъектов КАК Версии ГДЕ Версии.Объект = &Объект';
function transport(call: (args: any, id: number) => Response) {
  return jest.fn(async (_url: any, init: any) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: '1C' } } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 204 });
    return call(request.params.arguments, request.id);
  });
}
const reply = (id: number, text: string, isError = false) => Response.json({ jsonrpc: '2.0', id, result: { isError, content: [{ type: 'text', text }] } });

test('ticket93 reserved alias failure becomes actionable identifier location without upstream text', async () => {
  const raw = 'secret-login:secret-password\n{Module/private/path(15)}: Ошибка выполнения\nпо причине:\n{(1, 176)}: Ожидается имя\nВЫБРАТЬ В.НомерВерсии ИЗ РегистрСведений.ВерсииОбъектов КАК <<?>>В';
  const fetch = transport((_args, id) => reply(id, raw, true));
  let failure: any;
  try { await mcpOperation(base, 'employee', 'secret-password', { tool: 'execute_query', args: { query, parameters: { Объект: 'private-value' } } }, undefined, fetch as any); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'ONEC_QUERY_EXPECTED_IDENTIFIER', diagnostic: { line: 1, column: 176 } });
  const visible = helpOnecFailure(failure.code, failure.diagnostic);
  expect(visible.hint).toContain('псевдонимы');
  expect(visible.diagnostic).toEqual({ line: 1, column: 176 });
  expect(JSON.stringify(failure) + JSON.stringify(visible)).not.toMatch(/secret|private|Module|ВерсииОбъектов/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each([
  ['{(2, 11)}: Поле не найдено "СекретныйПараметр"', 'ONEC_QUERY_FIELD_UNKNOWN'],
  ['Таблица не найдена', 'ONEC_QUERY_TABLE_UNKNOWN'],
  ['Не задано значение параметра "Пароль"', 'ONEC_QUERY_PARAMETER_MISSING'],
  ['Неверный тип выражения', 'ONEC_QUERY_TYPE_MISMATCH'],
  ['Синтаксическая ошибка', 'ONEC_QUERY_SYNTAX'],
  ['Недостаточно прав для выполнения запроса', 'ONEC_QUERY_ACCESS_DENIED'],
  ['Unknown upstream error https://private.example/?token=abc', 'ONEC_TOOL_FAILED'],
])('classifies a bounded diagnostic without echoing it: %s', (text, code) => {
  const error = onecQueryFailure(text);
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(JSON.stringify(error)).not.toContain(text);
});

test('RPC query errors retain the same safe diagnostic contract', async () => {
  const fetch = transport((_args, id) => Response.json({ jsonrpc: '2.0', id, error: { code: -32603, message: '{(1, 7)}: Ожидается имя', data: 'private-stack' } }));
  await expect(mcpOperation(base, 'employee', 'pw', { tool: 'execute_query', args: { query } }, undefined, fetch as any)).rejects.toMatchObject({ code: 'ONEC_QUERY_EXPECTED_IDENTIFIER', diagnostic: { line: 1, column: 7 } });
});

test('oversized response reduces only page size, preserves query/identity, and exposes partial result', async () => {
  const pages: number[] = [], parameters = { Объект: { guid: '61deedc5-38b6-4c23-9fab-675df0d3843e', metadata: 'Документ.РасходныйОрдерНаТовары', _objectRef: true } };
  const fetch = transport((args, id) => {
    pages.push(args.maxRows); expect(args.query).toBe(query); expect(args.parameters).toEqual(parameters);
    return args.maxRows > 25 ? reply(id, 'x'.repeat(40001)) : reply(id, JSON.stringify({ success: true, rowCount: 2, data: [{ n: 1 }, { n: 2 }], truncated: true }));
  });
  const result = await mcpOperation(base, 'employee', 'pw', { tool: 'execute_query', args: { query, parameters, maxRows: 100 } }, undefined, fetch as any);
  expect(pages).toEqual([100, 25]);
  expect(JSON.parse(result.text!)).toMatchObject({ rowCount: 2, truncated: true, requestedMaxRows: 100, pageLimitApplied: 25, responseSizeReduced: true });
});

test('transport byte overflow can recover but does not pretend a smaller complete page is truncated', async () => {
  const fetch = transport((args, id) => args.maxRows > 1 ? new Response('x'.repeat(131073)) : reply(id, JSON.stringify({ success: true, rowCount: 1, data: [{ n: 1 }], truncated: false })));
  const r = await mcpOperation(base, 'employee', 'pw', { tool: 'execute_query', args: { query, maxRows: 4 } }, undefined, fetch as any);
  expect(JSON.parse(r.text!)).toMatchObject({ truncated: false, pageLimitApplied: 1 });
});

test('one oversized row terminates bounded retry; metadata reads and syntax errors are not retried', async () => {
  const pages: number[] = [];
  const fetch = transport((args, id) => { pages.push(args.maxRows); return reply(id, 'x'.repeat(40001)); });
  await expect(mcpOperation(base, 'employee', 'pw', { tool: 'execute_query', args: { query, maxRows: 1000 } }, undefined, fetch as any)).rejects.toMatchObject({ code: 'ONEC_RESPONSE_TOO_LARGE' });
  expect(pages).toEqual([1000, 250, 62, 15, 3, 1]);
  pages.length = 0;
  await expect(mcpOperation(base, 'employee', 'pw', { tool: 'get_metadata_structure', args: { metaType: 'Catalogs', name: 'Номенклатура' } }, undefined, fetch as any)).rejects.toMatchObject({ code: 'ONEC_RESPONSE_TOO_LARGE' });
  expect(pages).toHaveLength(1);
});

test('a retried response without explicit completeness does not become a successful full answer', async () => {
  const fetch = transport((args, id) => args.maxRows > 1 ? reply(id, 'x'.repeat(40001)) : reply(id, JSON.stringify({ success: true, rowCount: 1, data: [{ n: 1 }] })));
  await expect(mcpOperation(base, 'employee', 'pw', { tool: 'execute_query', args: { query, maxRows: 4 } }, undefined, fetch as any)).rejects.toMatchObject({ code: 'ONEC_PROTOCOL_ERROR' });
});

test('only bounded numeric source locations can enter model diagnostics', () => {
  expect(helpOnecFailure('ONEC_TOOL_FAILED', { line: 1, column: 0 })).not.toHaveProperty('diagnostic');
  expect(helpOnecFailure('ONEC_QUERY_SYNTAX', { line: 1, column: 7, message: 'private' } as any).diagnostic).toEqual({ line: 1, column: 7 });
});
