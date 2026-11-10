import { buildOpenAIInput, openAIConfiguration, OpenAIContext, requestOpenAIAnswer } from '../src/modules/help/help.openai';
const original = { ...process.env };
const source = { documentId: 'doc1', versionId: 'v1', revision: 1, title: 'Принтер', path: 'Материалы компании/Принтер.md', sourceUrl: '/knowledge/documents/doc1/published', excerpt: 'Проверьте бумагу.' };
const input: OpenAIContext = { messages: [{ role: 'user', text: 'Принтер не печатает' }], sources: [source] };
const answer = { decision: 'answer', message: 'Проверьте бумагу.', source_ids: ['S1'] };
const envelope = (result: unknown = answer) => ({ id: 'resp_fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } });
const mockResponse = (value: unknown, status = 200, headers?: Record<string, string>) => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async()=>new Response(JSON.stringify(value), { status, headers }));
beforeEach(() => {
  process.env = { ...original, HELP_AI_ENABLED: 'true', KNOWLEDGE_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture-model', OPENAI_API_KEY: 'fixture-key' };
  delete process.env.OPENAI_API_KEY_FILE;
  delete process.env.HELP_OPENAI_PROXY_URL;
  delete process.env.HELP_OPENAI_ALLOW_GENERAL;
  delete process.env.HELP_OPENAI_ALLOW_GENERAL_PRODUCTION;
  delete process.env.HELP_OPENAI_REASONING_EFFORT;
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

test('clarification carries separate questions and real answer options under the strict Responses schema', async () => {
  const questions = [{ id: 'os', header: 'Система', question: 'Какая операционная система?',
    multiSelect: false, options: [{ label: 'Windows 11', description: '' }, { label: 'Windows 10', description: '' }] },
    { id: 'error', header: 'Ошибка', question: 'Какой текст ошибки?', multiSelect: false, options: [] }];
  const transport = mockResponse(envelope({ decision: 'clarify', message: 'Уточните систему и ошибку.', source_ids: [], questions }));
  const result = await requestOpenAIAnswer(input, new AbortController().signal, transport);
  expect(result.questions).toEqual(questions);
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body.text.format.schema.required).toContain('questions');
  const validateRequiredKeys = (schema: any) => {
    if (schema.type === 'object') {
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(validateRequiredKeys);
    }
    if (schema.items) validateRequiredKeys(schema.items);
  };
  validateRequiredKeys(body.text.format.schema);
  expect(body.instructions).toContain('не помещай туда вопросы');
});
test('incomplete and refused responses are never treated as answers', async () => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ ...envelope(), status: 'incomplete' }))).rejects.toMatchObject({ code: 'HELP_OPENAI_INCOMPLETE' });
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ ...envelope(), output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }))).rejects.toMatchObject({ code: 'HELP_OPENAI_REFUSAL' });
});
test.each([null, { ...answer, unexpected: true }, { ...answer, message: '' }])('malformed answer is rejected', async malformed => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope(malformed)))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_RESPONSE' });
});
test('oversized response is bounded', async () => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse({ huge: 'x'.repeat(2 * 1024 * 1024 + 100) }))).rejects.toMatchObject({ code: 'HELP_OPENAI_RESPONSE_TOO_LARGE' });
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

test('reasoning effort is explicit and reasoning tokens are recorded', async () => {
  process.env.HELP_OPENAI_REASONING_EFFORT = 'low';
  const transport = mockResponse({ ...envelope(), usage: { ...envelope().usage, output_tokens_details: { reasoning_tokens: 12 } } });
  const result = await requestOpenAIAnswer(input, new AbortController().signal, transport);
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).reasoning).toEqual({ effort: 'low' });
  expect(result.usage).toMatchObject({ reasoningTokens: 12, totalTokens: 130 });
});

test('bad reasoning effort fails before a paid request', async () => {
  process.env.HELP_OPENAI_REASONING_EFFORT = 'typo'; const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});

test.each(['production', 'test', 'development'])('general answers need an explicit development opt-in (%s)', async mode => {
  process.env.NODE_ENV = mode; process.env.HELP_OPENAI_ALLOW_GENERAL = 'true';
  const transport = mockResponse(envelope({ ...answer, source_ids: [] }));
  const general = { ...input, sources: [], allowGeneral: true };
  if (mode === 'development') {
    await expect(requestOpenAIAnswer(general, new AbortController().signal, transport)).resolves.toMatchObject({ sources: [] });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).instructions).toContain('общая безопасная диагностика');
  } else {
    await expect(requestOpenAIAnswer(general, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_EMPTY_CONTEXT' });
    expect(transport).not.toHaveBeenCalled();
  }
});

test('general configuration alone does not weaken grounded citation validation', async () => {
  process.env.NODE_ENV = 'development'; process.env.HELP_OPENAI_ALLOW_GENERAL = 'true';
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope({ ...answer, source_ids: [] })))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_CITATIONS' });
});

test('configured proxy is applied to the OpenAI request without changing the global dispatcher', async () => {
  process.env.HELP_OPENAI_PROXY_URL = 'http://127.0.0.1:10809';
  const transport = mockResponse(envelope());
  await requestOpenAIAnswer(input, new AbortController().signal, transport);
  const dispatcher = (transport.mock.calls[0][1] as RequestInit & { dispatcher: { close(): Promise<void> } }).dispatcher;
  expect(dispatcher).toBeDefined();
  await dispatcher.close();
});

test('invalid proxy never falls back to a direct connection', async () => {
  process.env.HELP_OPENAI_PROXY_URL = 'socks5://127.0.0.1:10808'; const transport = mockResponse(envelope());
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_NOT_CONFIGURED' });
  expect(transport).not.toHaveBeenCalled();
});

test('tool continuation preserves encrypted reasoning and sums usage from every round', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'encrypted-fixture', summary: [] };
  const onec = { bases: [{ key: 'fixture', label: 'Fixture' }], definitions: [], proofs: [], validate: jest.fn().mockResolvedValue(undefined), call: jest.fn().mockResolvedValue('{"ok":true}') };
  const transport = mockResponse(envelope());
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_tool', status: 'completed', output: [reasoning,
    { type: 'function_call', name: 'onec_fixture', call_id: 'call_fixture', arguments: '{}' }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } } })));
  const result = await requestOpenAIAnswer({ ...input, onec }, new AbortController().signal, transport);
  const second = JSON.parse(String(transport.mock.calls[1][1]?.body));
  expect(second.input).toContainEqual(reasoning);
  expect(JSON.parse(second.input.find((item:any)=>item.type==='function_call_output'&&item.call_id==='call_fixture').output)).toMatchObject({ok:true,outcome:{status:'success',completeness:'unknown'}});
  expect(second.include).toContain('reasoning.encrypted_content');
  expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40, totalTokens: 160, reasoningTokens: 5 });
});

test('streams public explanations and decoded answer text; provider summaries and JSON stay on the server', async () => {
  const progress = jest.fn().mockResolvedValue(undefined);
  const result = { analysis_summary: 'Проверю очередь печати.', ...answer, suggestions: [] };
  const events = [
    { type: 'response.reasoning_text.delta', delta: 'PRIVATE_INTERNAL' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Проверка подключения.' },
    ...JSON.stringify(result).match(/.{1,7}/gs)!.map(delta => ({ type: 'response.output_text.delta', delta })),
    { type: 'response.completed', response: envelope(result) },
  ];
  const transport = jest.fn().mockResolvedValue(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  await expect(requestOpenAIAnswer({ ...input, progress }, new AbortController().signal, transport)).resolves.toMatchObject({ text: answer.message });
  expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({ stream: true });
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ draftText: answer.message }));
  const sent = JSON.stringify(progress.mock.calls);
  expect(sent).toContain('Проверю очередь'); expect(sent).not.toContain('PRIVATE_INTERNAL'); expect(sent).not.toContain('source_ids');
});

test('exhausted account quota does not retry as a transient rate limit', async () => {
  const transport = mockResponse({ error: { code: 'credit_balance_exhausted', message: 'private-body' } }, 429);
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport)).rejects.toMatchObject({ code: 'HELP_OPENAI_QUOTA', retryable: false });
});

test('capabilities reflect supplied sources and tools; unsupported rules and prior mistakes are explicitly fenced', async () => {
  process.env.NODE_ENV = 'development'; process.env.HELP_OPENAI_ALLOW_GENERAL = 'true';
  const transport = mockResponse(envelope({ decision: 'clarify', message: 'Какие правила вас интересуют?', source_ids: [] }));
  await requestOpenAIAnswer({ messages: [{ role: 'assistant', text: 'Знаю внутренние правила' }, { role: 'user', text: 'Какие правила?' }], sources: [], allowGeneral: true }, new AbortController().signal, transport);
  const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body.instructions).toContain('найдено документов для текущего вопроса: 0');
  expect(body.instructions).toContain('Инструменты чтения 1С: не предоставлены');
  expect(body.instructions).toContain('Предыдущие ответы помощника не являются подтверждением фактов');
  expect(body.instructions).toContain('Не называй общие советы');
  expect(body.instructions).toContain('Какие правила вас интересуют?');
});

test('provider reasoning summaries are not published as employee-facing activity', async () => {
  const final = envelope({ ...answer, analysis_summary: 'Проверяю инструкцию.' });
  const stream = [
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'English provider summary' },
    { type: 'response.output_text.delta', delta: JSON.stringify({ ...answer, analysis_summary: 'Проверяю инструкцию.' }) },
    { type: 'response.completed', response: final },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const transport = jest.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const progress = jest.fn().mockResolvedValue(undefined);
  await requestOpenAIAnswer({ ...input, progress }, new AbortController().signal, transport);
  expect(JSON.stringify(progress.mock.calls)).not.toContain('English provider summary');
  expect(JSON.stringify(progress.mock.calls)).toContain('Проверяю инструкцию.');
  const body = JSON.parse(String(transport.mock.calls[0][1].body));
  expect(body.reasoning?.summary).toBeUndefined();
});


test('production general diagnostics require both explicit flags and preserve request-level grounding', async () => {
  process.env.NODE_ENV = 'production';
  process.env.HELP_OPENAI_ALLOW_GENERAL_PRODUCTION = 'true';
  expect(openAIConfiguration().allowGeneral).toBe(false);
  process.env.HELP_OPENAI_ALLOW_GENERAL = 'true';
  expect(openAIConfiguration().allowGeneral).toBe(true);
  const transport = mockResponse(envelope({ ...answer, source_ids: [] }));
  await expect(requestOpenAIAnswer({ ...input, sources: [], allowGeneral: true }, new AbortController().signal, transport))
    .resolves.toMatchObject({ sources: [] });
  await expect(requestOpenAIAnswer(input, new AbortController().signal, mockResponse(envelope({ ...answer, source_ids: [] }))))
    .rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_CITATIONS' });
  const unapproved = mockResponse(envelope());
  await expect(requestOpenAIAnswer({ ...input, sources: [] }, new AbortController().signal, unapproved))
    .rejects.toMatchObject({ code: 'HELP_OPENAI_EMPTY_CONTEXT' });
  expect(unapproved).not.toHaveBeenCalled();
});
