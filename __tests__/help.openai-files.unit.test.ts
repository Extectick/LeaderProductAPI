import { requestOpenAIAnswer, type OpenAIContext } from '../src/modules/help/help.openai';
const original = { ...process.env };
const input: OpenAIContext = { messages: [{ role: 'user', text: 'Пришли тестовый txt файл' }], sources: [], allowGeneral: true };
const response = (answer: unknown, stream = false) => {
  const envelope = { id: 'file-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] };
  const events = [{ type: 'response.output_text.delta', delta: JSON.stringify(answer) }, { type: 'response.completed', response: envelope }];
  return new Response(stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(envelope), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
};
const answer = { analysis_summary: 'Подготовлю содержимое небольшого TXT.', decision: 'answer', message: 'Тестовый TXT с несколькими строками.', source_ids: [], suggestions: [], questions: [], files: [{ name: 'test.txt', content: 'Test file\nSample data\n' }] };
beforeEach(() => {
  process.env = { ...original, NODE_ENV: 'development', HELP_OPENAI_ALLOW_GENERAL: 'true', HELP_AI_ENABLED: 'true', KNOWLEDGE_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture', OPENAI_API_KEY: 'fixture-key' };
  delete process.env.OPENAI_API_KEY_FILE; delete process.env.HELP_OPENAI_PROXY_URL;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Real network forbidden'); });
});
afterEach(() => { process.env = original; jest.restoreAllMocks(); });
test.each([false, true])('real file output is bounded and does not promise a saved attachment through progress (stream=%s)', async stream => {
  const progress = jest.fn().mockResolvedValue(undefined), transport = jest.fn().mockResolvedValue(response(answer, stream));
  const result = await requestOpenAIAnswer({ ...input, progress }, new AbortController().signal, transport);
  expect(result.files).toEqual(answer.files);
  expect(progress.mock.calls.some(([update]) => 'draftText' in update)).toBe(false);
  const schema = JSON.parse(transport.mock.calls[0][1].body).text.format.schema;
  expect(schema.required).toContain('files');
  expect(schema.properties.files.items.required.sort()).toEqual(['content', 'name']);
});
test('ticket 32 cannot be answered with fake copy/paste file instructions', async () => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, jest.fn().mockResolvedValue(response({ ...answer, files: [], message: 'Вот готовый файл test.txt. Скопируйте текст.' })))).rejects.toMatchObject({ code: 'HELP_AI_FILE_MISSING', retryable: true });
});
test.each([
  { files: [{ name: 'bad.exe', content: 'text' }] },
  { files: [{ name: 'test.txt', content: 'text' }], message: '[скачать](sandbox:/test.txt)' },
])('invalid file output and invented sandbox links never enter delivery', async override => {
  await expect(requestOpenAIAnswer(input, new AbortController().signal, jest.fn().mockResolvedValue(response({ ...answer, ...override })))).rejects.toMatchObject({ code: 'HELP_AI_INVALID_FILE' });
});
