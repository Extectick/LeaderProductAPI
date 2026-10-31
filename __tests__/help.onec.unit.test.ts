import { requestOpenAIAnswer } from '../src/modules/help/help.openai';
import { HelpOnecConnectionRequired } from '../src/modules/help/help.onec-tools';
import type { HelpOnecTools } from '../src/modules/help/help.onec-tools';
beforeEach(() => Object.assign(process.env, { HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'test-model', OPENAI_API_KEY: 'test-api-key', KNOWLEDGE_ENABLED: 'true' }));
const answer = { id: 'r2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ decision: 'answer', message: 'Проверено в базе Test.', source_ids: [] }) }] }] };
test('server executes one read then supplies only result to Responses; no credentials or source URL', async () => {
  const tools: HelpOnecTools = { bases: [{ key: 'test', label: 'Test' }], definitions: [{ type: 'function', name: 'onec_get_access_rights' }], proofs: [], validate: async () => {}, call: async () => { tools.proofs.push({ baseKey: 'test', revision: 1, binding: 'safe-binding' }); return '{"read":true}'; } };
  const transport = jest.fn().mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(init.body); expect(body.store).toBe(false); expect(body.parallel_tool_calls).toBe(false);
    expect(body.input[0].content).not.toContain('password');
    return Response.json({ id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'onec_get_access_rights', call_id: 'c1', arguments: '{"baseKey":"test","arguments":{"metadata":"Справочник.Товары"}}' }] });
  }).mockImplementationOnce(async (_url, init) => {
    const body = JSON.parse(init.body); expect(body.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'c1', output: '{"read":true}' });
    return Response.json(answer);
  });
  const r = await requestOpenAIAnswer({ messages: [{ role: 'user', text: 'Проверь данные в 1С' }], sources: [], onec: tools }, new AbortController().signal, transport);
  expect(r.text).toBe('Проверено в базе Test.'); expect(transport).toHaveBeenCalledTimes(2);
});
test('missing personal credentials stops model loop and asks application to show secure form', async () => {
  const tools: HelpOnecTools = { bases: [{ key: 'test', label: 'Test' }], definitions: [], proofs: [], validate: async () => {}, call: async () => { throw new HelpOnecConnectionRequired('test'); } };
  const transport = jest.fn(async () => Response.json({ id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'onec_get_access_rights', call_id: 'c1', arguments: '{}' }] }));
  await expect(requestOpenAIAnswer({ messages: [{ role: 'user', text: 'Проверь 1С' }], sources: [], onec: tools }, new AbortController().signal, transport)).rejects.toMatchObject({ baseKey: 'test' });
  expect(transport).toHaveBeenCalledTimes(1);
});
test('unsuccessful tools cannot justify a factual answer with no sources', async () => {
  const tools: HelpOnecTools = { bases: [], definitions: [], proofs: [], validate: async () => {}, call: async () => '{"error":"ONEC_ACCESS_DENIED"}' };
  await expect(requestOpenAIAnswer({ messages: [{ role: 'user', text: 'Проверь 1С' }], sources: [], onec: tools }, new AbortController().signal, jest.fn(async () => Response.json(answer)))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_CITATIONS' });
});

test('revocation stops disclosure of a previous tool result to the next model request', async () => {
  let revoked = false;
  const tools: HelpOnecTools = { bases: [], definitions: [], proofs: [],
    validate: async () => { if (revoked) throw new HelpOnecConnectionRequired('test'); },
    call: async () => { revoked = true; return '{"private":"business-data"}'; } };
  const transport = jest.fn(async () => Response.json({ id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'onec_get_access_rights', call_id: 'c1', arguments: '{}' }] }));
  await expect(requestOpenAIAnswer({ messages: [{ role: 'user', text: 'Проверь 1С' }], sources: [], onec: tools }, new AbortController().signal, transport)).rejects.toMatchObject({ baseKey: 'test' });
  expect(transport).toHaveBeenCalledTimes(1);
});
