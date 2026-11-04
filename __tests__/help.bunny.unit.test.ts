jest.mock('../src/prisma/client', () => ({__esModule: true, default: {helpMessage: {findMany: jest.fn()}}}));
import prisma from '../src/prisma/client';
import {buildBunnyMessages, bunnyConfiguration, requestBunnyAnswer, prepareHelpBunnyAnswer} from '../src/modules/help/help.bunny';
const original = {...process.env};
beforeEach(() => { process.env = {...original, NODE_ENV: 'development', HELP_AI_ENABLED: 'true', HELP_AI_PROVIDER: 'bunny', HELP_BUNNY_DEV_ENABLED: 'true', BUNNY_CHAT_API_KEY: 'unit-test-key'}; delete process.env.BUNNY_CHAT_API_KEY_FILE; jest.clearAllMocks(); });
afterAll(() => {process.env = original;});
const history = [{role: 'user' as const, text: 'Не работает принтер'}];
const ok = (content = 'Какая модель принтера?') => new Response(JSON.stringify({id: 'response1', choices: [{finish_reason: 'stop', message: {content}}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}));
test('requires explicit dev opt-in and refuses production', async () => {
  expect(bunnyConfiguration().enabled).toBe(true);
  process.env.NODE_ENV = 'production'; expect(bunnyConfiguration().enabled).toBe(false);
  const transport = jest.fn(); await expect(requestBunnyAnswer(history, new AbortController().signal, transport)).rejects.toMatchObject({code: 'HELP_BUNNY_NOT_CONFIGURED'});
  expect(transport).not.toHaveBeenCalled();
  process.env.NODE_ENV = 'development'; process.env.HELP_BUNNY_DEV_ENABLED = 'false'; expect(bunnyConfiguration().enabled).toBe(false);
});
test('sends server-side Chat Completions contract and returns only final content', async () => {
  const transport = jest.fn().mockResolvedValue(ok());
  const result = await requestBunnyAnswer(history, new AbortController().signal, transport);
  const [url, init] = transport.mock.calls[0]; const body = JSON.parse(init.body);
  expect(url).toBe('https://ai.bunny.ge/api/v1/chat/completions'); expect(init.redirect).toBe('error');
  expect(body).toMatchObject({model: 'bunny-qwen3.5-4b', max_tokens: 512, stream: false, chat_template_kwargs: {enable_thinking: false}});
  expect(body.messages[0].role).toBe('system'); expect(body.messages[1].content).toBe(history[0].text);
  expect(result).toMatchObject({text: 'Какая модель принтера?', usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}});
});
test('bounds UTF-8 history and preserves the latest question', () => {
  const messages = buildBunnyMessages([{role: 'assistant', text: 'old '.repeat(5000)}, {role: 'user', text: 'Актуальный вопрос'}]);
  expect(messages).toHaveLength(2); expect(messages[1].content).toBe('Актуальный вопрос');
  const long = buildBunnyMessages([{role: 'user', text: '😀'.repeat(5000)}]);
  expect(Buffer.byteLength(long[1].content)).toBeLessThanOrEqual(2400); expect(long[1].content).not.toContain('\uFFFD');
});
test.each([
  {finish_reason: 'length', message: {content: 'незаконченный'}},
  {finish_reason: 'stop', message: {content: null, reasoning_content: 'hidden'}},
  {finish_reason: 'stop', message: {content: 'x', tool_calls: [{id: 'call'}]}},
])('rejects incomplete responses, reasoning-only and unexpected tools: %j', async choice => {
  await expect(requestBunnyAnswer(history, new AbortController().signal, jest.fn().mockResolvedValue(new Response(JSON.stringify({choices: [choice]}))))).rejects.toMatchObject({code: 'HELP_BUNNY_INVALID_RESPONSE'});
});
test('retries context overflow once with smaller history', async () => {
  const transport = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({error: {code: 'context_length_exceeded'}}), {status: 400})).mockResolvedValueOnce(ok());
  await requestBunnyAnswer([{role: 'user', text: 'я'.repeat(5000)}], new AbortController().signal, transport);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(JSON.parse(transport.mock.calls[1][1].body).messages[1].content.length).toBeLessThan(JSON.parse(transport.mock.calls[0][1].body).messages[1].content.length);
});
test('429 uses Retry-After and hides provider response bodies', async () => {
  await expect(requestBunnyAnswer(history, new AbortController().signal, jest.fn().mockResolvedValue(new Response('private upstream content', {status: 429, headers: {'retry-after': '10'}})))).rejects.toMatchObject({message: 'HELP_BUNNY_HTTP_429', retryable: true, retryAfterMs: 10000});
});
test('abort reaches the upstream request', async () => {
  const controller = new AbortController();
  const transport = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {init.signal.addEventListener('abort', () => reject(new Error('aborted'))); controller.abort();}));
  await expect(requestBunnyAnswer(history, controller.signal, transport as typeof fetch)).rejects.toMatchObject({code: 'HELP_BUNNY_CANCELLED'});
});
test('collects history only from this ticket and owner/system authors', async () => {
  (prisma.helpMessage.findMany as jest.Mock).mockResolvedValue([{authorId: 7, text: 'Hello'}]);
  const oldFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue(ok());
  try {
    await expect(prepareHelpBunnyAnswer(3, 7, [], new AbortController().signal)).resolves.toMatchObject({mode: 'bunny', sources: []});
    expect(prisma.helpMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({where: {ticketId: 3, kind: 'TEXT', OR: [{authorId: 7}, {authorId: null, authorRole: 'SYSTEM'}]}}));
  } finally {global.fetch = oldFetch;}
});
