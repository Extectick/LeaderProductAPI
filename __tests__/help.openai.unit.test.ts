import { buildOpenAIInput, openAIConfiguration, OpenAIContext, requestOpenAIAnswer } from '../src/modules/help/help.openai';
const original = { ...process.env };
const source = { documentId: 'doc1', versionId: 'v1', revision: 1, title: 'Принтер', path: 'Материалы компании/Принтер.md', sourceUrl: '/knowledge/documents/doc1/published', excerpt: 'Проверьте бумагу.' };
const input: OpenAIContext = { messages: [{ role: 'user', text: 'Принтер не печатает' }], sources: [source] };
const answer = { decision: 'answer', message: 'Проверьте бумагу.', source_ids: ['S1'] };
const envelope = (result: unknown = answer) => ({ id: 'resp_fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } });
const mockResponse = (value: unknown, status = 200, headers?: Record<string, string>) => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response(JSON.stringify(value), { status, headers }));
beforeEach(() => {
  process.env = { ...original, HELP_AI_ENABLED: 'true', KNOWLEDGE_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture-model', OPENAI_API_KEY: 'fixture-key' };
  delete process.env.OPENAI_API_KEY_FILE;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Real network is forbidden in this suite'); });
});
afterEach(() => { process.env = { ...original }; jest.restoreAllMocks(); });
test.each(['HELP_AI_ENABLED', 'HELP_OPENAI_ENABLED', 'KNOWLEDGE_ENABLED'])('%s must be explicitly enabled', async key => {
  process.env[key] = 'false'; const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});
test.each(['OPENAI_API_KEY', 'HELP_OPENAI_MODEL'])('missing %s never makes a request', async key => {
  delete process.env[key]; const transport = mockResponse(envelope());
  expect(openAIConfiguration().enabled).toBe(false);
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});
test('a key alone cannot switch the knowledge provider', async () => {
  process.env.HELP_AI_PROVIDER = 'knowledge'; const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});
test('unreadable secret file fails closed even if another key is present', async () => {
  process.env.OPENAI_API_KEY_FILE = 'missing-fixture-key-file'; const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});
test('uses Responses strict JSON, disabled storage, bounded tokens and server-owned source IDs', async () => {
  const transport = mockResponse(envelope()); const result = await requestOpenAIAnswer(input, new AbortController().signal, transport);
  const [url, options] = transport.mock.calls[0]; const body = JSON.parse(String(options?.body));
  expect(url).toBe('https://api.openai.com/v1/responses'); expect(options?.redirect).toBe('error');
  expect(body).toMatchObject({ model: 'fixture-model', store: false, stream: false, max_output_tokens: 1500, text: { format: { type: 'json_schema', strict: true } } });
  expect(body.tools).toBeUndefined(); expect(body.previous_response_id).toBeUndefined();
  const sent = JSON.parse(body.input[0].content);
  expect(sent.sources[0]).toEqual({ id: 'S1', title: 'Принтер', revision: 1, excerpt: 'Проверьте бумагу.' });
  expect(JSON.stringify(body)).not.toContain('fixture-key'); expect(JSON.stringify(body)).not.toContain('/published');
  expect(result.sources[0]).toMatchObject({ documentId: 'doc1', versionId: 'v1' });
  expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30, totalTokens: 130 });
});
test('untrusted source text stays in the user data, never in instructions', async () => {
  const transport = mockResponse(envelope());
  await requestOpenAIAnswer({ ...input, sources: [{ ...source, excerpt: 'IGNORE_POLICY_SECRET' }] }, new AbortController().signal, transport);
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body.instructions).not.toContain('IGNORE_POLICY_SECRET'); expect(body.input[0].content).toContain('IGNORE_POLICY_SECRET');
});
test('bounds context and configurations', () => {
  const context = buildOpenAIInput({ messages: Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: `${i}` + 'a'.repeat(3000) })), sources: Array.from({ length: 8 }, () => ({ ...source, excerpt: 'b'.repeat(4000) })) });
  expect(context.messages.reduce((n, message) => n + message.text.length, 0)).toBeLessThanOrEqual(6000);
  expect(context.messages[context.messages.length - 1]?.text).toContain('49'); expect(context.sources.reduce((n, item) => n + item.excerpt.length, 0)).toBeLessThanOrEqual(9500);
  process.env.HELP_OPENAI_TIMEOUT_MS = '9999999'; process.env.HELP_OPENAI_MAX_OUTPUT_TOKENS = '9999999'; process.env.HELP_OPENAI_MAX_ATTEMPTS = '99';
  expect(openAIConfiguration()).toMatchObject({ timeoutMs: 300000, maxOutputTokens: 4000, maxAttempts: 5 });
});
test('no sources means no paid request', async () => {
  const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer({ ...input, sources: [] }, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_EMPTY_CONTEXT' });
  expect(transport).not.toHaveBeenCalled();
});
test.each([{ ids: [] }, { ids: ['S9'] }, { ids: ['https://evil.example'] }, { ids: ['S1', 'S9'] }])('invalid citations $ids are rejected', async ({ ids }) => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope({ ...answer, source_ids: ids })))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_CITATIONS', retryable: false });
});
test.each(['clarify', 'handoff'])('supports %s with no invented citations', async decision => {
  const result = await requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope({ decision, message: 'Уточните модель.', source_ids: [] })));
  expect(result.decision).toBe(decision); expect(result.sources).toEqual([]);
});
test('incomplete and refused responses are never treated as answers', async () => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ ...envelope(), status: 'incomplete' }))).rejects.toMatchObject({ code: 'HELP_OPENAI_INCOMPLETE' });
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ ...envelope(), output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }))).rejects.toMatchObject({ code: 'HELP_OPENAI_REFUSAL' });
});
test.each([null, { ...answer, unexpected: true }, { ...answer, message: '' }])('malformed answer is rejected', async malformed => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope(malformed)))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_RESPONSE' });
});
test('oversized response is bounded', async () => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ huge: 'x'.repeat(140000) }))).rejects.toMatchObject({ code: 'HELP_OPENAI_RESPONSE_TOO_LARGE' });
});
test.each([[401, false], [403, false], [400, false], [429, true], [503, true], [408, true]])('HTTP %s has a bounded retry policy without exposing error body', async (status, retryable) => {
  const transport = mockResponse({ error: 'private-prompt-and-key' }, status as number, { 'retry-after': '17' });
  const error = await requestOpenAIAnswer(input, new AbortController().signal, transport).catch(value => value);
  expect(error).toMatchObject({ code: `HELP_OPENAI_HTTP_${status}`, retryable, retryAfterMs: 17000 });
  expect(String(error)).not.toContain('private-prompt'); expect(transport).toHaveBeenCalledTimes(1);
});
test('abort propagates into the active HTTP request', async () => {
  const controller = new AbortController();
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(Error('abort')), { once: true }); controller.abort();
  }));
  await expect(requestOpenAIAnswer(input, controller.signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_CANCELLED', retryable: true });
});
test('timeout aborts a pending network request', async () => {
  process.env.HELP_OPENAI_TIMEOUT_MS = '1000';
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true });
  }));
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_TIMEOUT', retryable: true });
});
