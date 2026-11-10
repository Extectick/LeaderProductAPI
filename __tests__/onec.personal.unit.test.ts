import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../src/modules/onec-personal/vault';
import { onecBases, baseBinding, OnecPersonalError } from '../src/modules/onec-personal/config';
import { mcpOperation, readArguments } from '../src/modules/onec-personal/mcp';

const folder = mkdtempSync(join(tmpdir(), 'onec-vault-test-'));
const base = { key: 'test', label: 'Test', rpcUrl: 'https://onec.example.org/test/hs/mcp/rpc', legacyGuidBinding: false, allowVpnHttp: false };
beforeAll(() => { process.env.ONEC_PERSONAL_KEYRING_FILE = join(folder, 'keys.json'); writeFileSync(process.env.ONEC_PERSONAL_KEYRING_FILE, JSON.stringify({ active: 'a', keys: { a: randomBytes(32).toString('base64') } })); });
afterAll(() => { rmSync(folder, { recursive: true, force: true }); delete process.env.ONEC_PERSONAL_ENABLED; });
test('authenticated encryption is randomized and binds identity, base and credential kind', () => {
  const secret = 'private-login:private-password', binding = JSON.stringify([1, baseBinding(base), 'password']);
  const a = seal(secret, binding), b = seal(secret, binding);
  expect(a).not.toContain(secret); expect(a).not.toBe(b); expect(unseal(a, binding)).toBe(secret);
  expect(() => unseal(a, binding.replace('[1,', '[2,'))).toThrow('ONEC_CREDENTIALS_INVALID');
  expect(() => unseal(a, binding.replace('password', 'login'))).toThrow('ONEC_CREDENTIALS_INVALID');
  const parts = a.split('.'); parts[4] = Buffer.from('tampered').toString('base64');
  expect(() => unseal(parts.join('.'), binding)).toThrow('ONEC_CREDENTIALS_INVALID');
});
test('catalog rejects public plaintext endpoints, duplicate keys and multiple legacy GUID bases', () => {
  process.env.ONEC_PERSONAL_ENABLED = 'true'; process.env.ONEC_PERSONAL_BASES_FILE = join(folder, 'bases.json');
  for (const bases of [[{ ...base, rpcUrl: 'http://195.208.129.43:61380/test/hs/mcp/rpc', allowVpnHttp: true }], [base, base], [{ ...base, legacyGuidBinding: true }, { ...base, key: 'two', legacyGuidBinding: true }]]) {
    writeFileSync(process.env.ONEC_PERSONAL_BASES_FILE, JSON.stringify(bases)); expect(() => onecBases()).toThrow('ONEC_NOT_CONFIGURED');
  }
});
test('only bounded reads are accepted; code, writes, extra parameters and query batches are forbidden', () => {
  for (const tool of ['execute_code','save_object','post_document','toString']) expect(() => readArguments(tool, {})).toThrow('ONEC_TOOL_FORBIDDEN');
  for (const query of ['DELETE FROM x', 'ВЫБРАТЬ ПЕРВЫЕ 1001 Ссылка ИЗ Справочник.Товары', 'ВЫБРАТЬ ПЕРВЫЕ 10 Ссылка ИЗ X; ВЫБРАТЬ 1', 'SELECT TOP 10 * FROM x FOR UPDATE']) expect(() => readArguments('execute_query', { query })).toThrow('ONEC_QUERY_FORBIDDEN');
  expect(() => readArguments('execute_query', { query: 'SELECT TOP 1 x FROM t', privilegedMode: true })).toThrow('ONEC_TOOL_ARGUMENTS');
  expect(readArguments('execute_query', { query: 'ВЫБРАТЬ ПЕРВЫЕ 7 Ссылка ИЗ Справочник.Товары' })).toMatchObject({ maxRows: 7, includeColumnTypes: false });
});
test('MCP always uses the supplied personal Basic identity, rejects redirects and bounds reads', async () => {
  const transport = jest.fn(async (_url: any, init: any) => {
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('alice:personal-password').toString('base64'));
    const req = JSON.parse(init.body);
    if (req.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: '1C' } } });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 204 });
    expect(req.params.arguments).toMatchObject({ maxItems: 100 });
    return Response.json({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'allowed data' }] } });
  });
  expect(await mcpOperation(base, 'alice', 'personal-password', { tool: 'list_metadata_objects', args: { metaType: 'Catalogs' } }, undefined, transport as any)).toEqual({ text: 'allowed data' });
  expect(transport).toHaveBeenCalledTimes(3);
});
test('401 and upstream diagnostics never disclose secrets', async () => {
  const fail = jest.fn(async () => new Response('echo-password-and-internal-stack', { status: 401 }));
  await expect(mcpOperation(base, 'alice', 'secret', undefined, undefined, fail)).rejects.toEqual(new OnecPersonalError('ONEC_AUTH_REQUIRED', 422));
  const oversized = jest.fn(async () => new Response('x'.repeat(131073)));
  await expect(mcpOperation(base, 'alice', 'secret', undefined, undefined, oversized)).rejects.toMatchObject({ code: 'ONEC_RESPONSE_TOO_LARGE' });
});
