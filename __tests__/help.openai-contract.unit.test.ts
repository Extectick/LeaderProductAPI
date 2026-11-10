import { requestOpenAIAnswer, type OpenAIContext } from '../src/modules/help/help.openai';
const initial = { ...process.env };
const input: OpenAIContext = { messages: [{ role: 'user', text: 'Нужна инструкция' }], sources: [{ documentId: 'd', versionId: 'v', revision: 1, title: 'Инструкция', path: 'Материалы компании/Инструкция.md', sourceUrl: '/knowledge/d', excerpt: 'Проверьте соединение.' }] };
const answer = { analysis_summary: 'Проверю инструкцию.', decision: 'answer', message: 'Проверьте соединение.', source_ids: ['S1'], suggestions: [] };
const envelope = (value: unknown) => ({ id: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function response(value: unknown, stream = false) {
  if (!stream) return new Response(JSON.stringify(envelope(value)), { headers: { 'content-type': 'application/json' } });
  const events = [ { type: 'response.output_text.delta', delta: JSON.stringify(value) }, { type: 'response.completed', response: envelope(value) } ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const transport = (reply: Response) => { const body=reply.text(); return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async()=>new Response(await body,{status:reply.status,headers:reply.headers})); };
beforeEach(() => {
  process.env = { ...initial, HELP_AI_ENABLED: 'true', KNOWLEDGE_ENABLED: 'true', HELP_AI_PROVIDER: 'openai', HELP_OPENAI_ENABLED: 'true', HELP_OPENAI_MODEL: 'fixture', OPENAI_API_KEY: 'fixture-key' };
  delete process.env.OPENAI_API_KEY_FILE; delete process.env.HELP_OPENAI_PROXY_URL; delete process.env.HELP_OPENAI_REASONING_EFFORT;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Real network forbidden'); });
});
afterEach(() => { process.env = initial; jest.restoreAllMocks(); });

test.each([false, true])('the same strict answer/clarify/handoff contract tolerates optional presentation defects (stream=%s)', async stream => {
  for (const decision of ['answer', 'clarify', 'handoff']) {
    const malformed = { ...answer, decision, analysis_summary: { unexpected: 'do not serialize' }, suggestions: [null, 17, ' ', '  Windows 11  ', 'Windows 11', 'x'.repeat(121), 'Телефон', 'Компьютер', 'Лишний'] };
    const result = await requestOpenAIAnswer({ ...input, progress: stream ? jest.fn().mockResolvedValue(undefined) : undefined }, new AbortController().signal, transport(response(malformed, stream)));
    expect(result.decision).toBe(decision); expect(result.text).toBe(answer.message);
    expect(result.suggestions).toEqual(decision === 'clarify' ? ['Windows 11', 'Телефон', 'Компьютер'] : []);
    expect(result.sources).toHaveLength(1);
  }
});
test.each([null, 'wrong', { bad: true }, undefined])('malformed optional suggestions %j do not turn an answer into a failure', async suggestions => {
  const result = await requestOpenAIAnswer(input, new AbortController().signal, transport(response({ ...answer, suggestions, analysis_summary: 'x'.repeat(2001) })));
  expect(result.text).toBe(answer.message); expect(result.suggestions).toEqual([]);
});
test.each(['decision', 'message', 'source_ids'])('missing core %s fails after one bounded answer correction, with only safe diagnostic metadata', async field => {
  const malformed: Record<string, unknown> = { ...answer }; delete malformed[field];
  const error = await requestOpenAIAnswer(input, new AbortController().signal, transport(response(malformed))).catch(value => value);
  expect(error).toMatchObject({ code: 'HELP_OPENAI_INVALID_RESPONSE', retryable: false, retryAfterMs: 0, diagnostic: { stage: 'answer_schema', issues: [{ path: field, code: field === 'decision' ? 'invalid_value' : 'invalid_type' }] } });
  expect(JSON.stringify(error)).not.toContain('Проверьте'); expect(JSON.stringify(error)).not.toContain('fixture-key');
});
test.each([
  { ...answer, message: '' }, { ...answer, message: ' ' }, { ...answer, message: 'x'.repeat(12001) },
  { ...answer, decision: 'execute' }, { ...answer, source_ids: 'S1' }, { ...answer, source_ids: [7] },
  { ...answer, source_ids: ['S1', 'S1', 'S1', 'S1'] }, { ...answer, 'PRIVATE_FIELD_DO_NOT_LOG': true },
])('invalid core fields and extra keys remain rejected after bounded correction', async malformed => {
  const error = await requestOpenAIAnswer(input, new AbortController().signal, transport(response(malformed))).catch(value => value);
  expect(error.code).toBe('HELP_OPENAI_INVALID_RESPONSE'); expect(error.diagnostic.stage).toBe('answer_schema');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_FIELD_DO_NOT_LOG');
});
test('citation validation runs before final public explanation or validating draft flush', async () => {
  const progress = jest.fn().mockResolvedValue(undefined);
  const error = await requestOpenAIAnswer({ ...input, progress }, new AbortController().signal, transport(response({ ...answer, source_ids: ['S9'], suggestions: ['  valid  ', null] }))).catch(value => value);
  expect(error).toMatchObject({ code: 'HELP_OPENAI_INVALID_CITATIONS', retryable: false });
  expect(progress.mock.calls.every(([update])=>update.draftText===''&&!update.activity?.text)).toBe(true);
});
test('upstream schema declares all limits enforced locally', async () => {
  const fetcher = transport(response(answer));
  await requestOpenAIAnswer(input, new AbortController().signal, fetcher);
  const fields = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).text.format.schema.properties;
  expect(fields.message).toMatchObject({ minLength: 1, maxLength: 12000 });
  expect(fields.analysis_summary).toMatchObject({ maxLength: 2000 });
  expect(fields.source_ids).toMatchObject({ maxItems: 3, items: { enum: ['S1'] } });
  expect(fields.suggestions).toMatchObject({ maxItems: 3, items: { minLength: 1, maxLength: 120 } });
});
test('every strict object requires exactly its declared properties, including composer questions', async () => {
  const fetcher = transport(response(answer));
  await requestOpenAIAnswer(input, new AbortController().signal, fetcher);
  const schema = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).text.format.schema;
  function check(node: any) {
    expect(node.$schema).toBeUndefined();
    if (node.type === 'object') {
      expect(node.additionalProperties).toBe(false);
      expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
      expect(new Set(node.required).size).toBe(node.required.length);
      Object.values(node.properties).forEach(check);
    }
    if (node.type === 'array') check(node.items);
  }
  check(schema);
  expect(schema.properties.questions.items.properties.options.items.required).toEqual(['label', 'description']);
  expect(schema.properties.questions.items.properties.multiSelect).toEqual({ type: 'boolean' });
});
test('clarification preserves composer questions and choices through the shared contract', async () => {
  const question = { id: 'os', header: 'Система', question: 'Какая версия Windows?',
    options: [{ label: 'Windows 11', description: '' }, { label: 'Windows 10', description: '' }], multiSelect: false };
  const result = await requestOpenAIAnswer(input, new AbortController().signal,
    transport(response({ ...answer, decision: 'clarify', questions: [question] })));
  expect(result.questions).toEqual([question]);
});
test('a valid escaped 12000-character answer fits the streamed transport bound', async () => {
  const message = '"'.repeat(12000);
  const result = await requestOpenAIAnswer({ ...input, progress: jest.fn().mockResolvedValue(undefined) }, new AbortController().signal, transport(response({ ...answer, message }, true)));
  expect(result.text.length).toBe(12000);
});
test.each([
  ['response_json', () => new Response('{invalid')],
  ['envelope', () => new Response(JSON.stringify({ id: 'x', status: 'completed', output: null }))],
  ['answer_json', () => new Response(JSON.stringify({ ...envelope(answer), output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{bad' }] }] }))],
  ['stream', () => new Response('data: {broken\n\n', { headers: { 'content-type': 'text/event-stream' } })],
] as const)('classifies %s without retaining response data', async (stage, create) => {
  const error = await requestOpenAIAnswer(input, new AbortController().signal, transport(create())).catch(value => value);
  expect(error).toMatchObject({ code: 'HELP_OPENAI_INVALID_RESPONSE', retryable: stage!=='answer_json', diagnostic: { stage } });
});
test('refusal remains nonretryable and truncated output is retryable', async () => {
  const refusal = { ...envelope(answer), output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] };
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport(new Response(JSON.stringify(refusal))))).rejects.toMatchObject({ code: 'HELP_OPENAI_REFUSAL', retryable: false });
  await expect(requestOpenAIAnswer(input, new AbortController().signal, transport(new Response(JSON.stringify({ ...envelope(answer), status: 'incomplete' }))))).rejects.toMatchObject({ code: 'HELP_OPENAI_INCOMPLETE', retryable: true });
});
test('malformed tool arguments are never executed or normalized as answer metadata', async () => {
  const onec = { bases: [], definitions: [], proofs: [], validate: jest.fn(), call: jest.fn() };
  const tool = { id: 'fixture', status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'onec_execute_query', arguments: '{bad' }] };
  await expect(requestOpenAIAnswer({ ...input, onec }, new AbortController().signal, transport(new Response(JSON.stringify(tool))))).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_TOOL', retryable: false, diagnostic: { stage: 'tool' } });
  expect(onec.call).not.toHaveBeenCalled();
});

test('tool-only answers cannot cite nonexistent document identifiers', async () => {
  const onec = { bases: [{ key: 'qa', label: 'QA' }], definitions: [], proofs: [{ baseKey: 'qa', revision: 1, binding: 'qa' }], validate: jest.fn(), call: jest.fn() };
  const fetcher = transport(response({ ...answer, source_ids: [] }));
  await requestOpenAIAnswer({ ...input, sources: [], onec }, new AbortController().signal, fetcher);
  const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(sent.text.format.schema.properties.source_ids).toMatchObject({ maxItems: 0 });
  expect(sent.text.format.schema.properties.source_ids.items.enum).toBeUndefined();
});

test('a rejected identical tool request is not executed twice, and failure activity retains its actual code', async () => {
  const call = { type: 'function_call', name: 'onec_execute_query', call_id: 'call1', arguments: '{"query":"fixture"}' };
  const toolEnvelope = (id: string) => ({ id, status: 'completed', output: [call] });
  const fetcher = transport(response({ ...answer, decision: 'handoff', source_ids: [] }));
  fetcher.mockResolvedValueOnce(Response.json(toolEnvelope('r1'))).mockResolvedValueOnce(Response.json(toolEnvelope('r2')));
  const onec = { bases: [], definitions: [], proofs: [], validate: jest.fn(), call: jest.fn().mockResolvedValue('{"error":"ONEC_TOOL_FAILED"}') };
  const progress = jest.fn();
  await requestOpenAIAnswer({ ...input, onec, progress }, new AbortController().signal, fetcher);
  expect(onec.call).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ errorCode: 'ONEC_TOOL_FAILED', label: '1С отклонила выполнение запроса' }) }));
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ errorCode: 'ONEC_REPEATED_REJECTED_REQUEST' }) }));
});

test('metadata discovery can continue beyond four calls, while the configured bound remains enforced', async () => {
  const onec = { bases: [], definitions: [], proofs: [], validate: jest.fn(), call: jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({success:true,data:[],rowCount:0})})) };
  const fetcher = transport(response(answer));
  for (let n = 0; n < 5; n++) fetcher.mockResolvedValueOnce(Response.json({ id: 'r' + n, status: 'completed', output: [{ type: 'function_call', name: 'onec_list_metadata_objects', call_id: 'c' + n, arguments: '{}' }] }));
  await requestOpenAIAnswer({ ...input, onec }, new AbortController().signal, fetcher);
  expect(onec.call).toHaveBeenCalledTimes(5);
  process.env.HELP_OPENAI_MAX_TOOL_CALLS = '1'; onec.call.mockClear();
  const repeated = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async () => Response.json({ id: 'r', status: 'completed', output: [{ type: 'function_call', name: 'onec_list_metadata_objects', call_id: 'c', arguments: '{}' }] }));
  await expect(requestOpenAIAnswer({ ...input, onec }, new AbortController().signal, repeated)).rejects.toMatchObject({ code: 'HELP_OPENAI_INVALID_TOOL' });
  expect(onec.call).toHaveBeenCalledTimes(1);
});

test('source selection is semantic rather than forced by a business-word dictionary', async () => {
  const onec = { bases: [], definitions: [], proofs: [], validate: jest.fn(), call: jest.fn() };
  for (const [text, choice] of [['Какое последнее приобретение по складу?', 'auto'], ['Какие устройства есть в филиале?', 'auto'], ['Задай вопросы обо мне как сотрудник', 'auto']]) {
    const fetcher = transport(response({ ...answer, decision: 'clarify' }));
    await requestOpenAIAnswer({ ...input, messages: [{role:'user',text}], onec }, new AbortController().signal, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).tool_choice).toBe(choice);
  }
});

test('a repeated read-consent question is kept internal and replaced by actual tool work', async () => {
  const onec = { bases: [], definitions: [], proofs: [], validate: jest.fn(), call: jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({success:true,data:[],rowCount:0})})) };
  const fetcher = transport(response(answer));
  fetcher.mockResolvedValueOnce(response({ ...answer, decision: 'clarify', message: 'Подтвердите выполнение запроса к 1С.' }))
    .mockResolvedValueOnce(Response.json({ id: 'tool', status: 'completed', output: [{type:'function_call',name:'onec_execute_query',call_id:'c1',arguments:'{}'}] }));
  const progress=jest.fn();
  await requestOpenAIAnswer({ ...input, messages: [{role:'user',text:'Какое последнее приобретение по складу?'}], onec, progress }, new AbortController().signal, fetcher);
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).tool_choice).toBe('required');
  expect(onec.call).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(progress.mock.calls)).not.toContain('Подтвердите выполнение');
});

test('latest purchase routes to the bounded server operation and permits a real warehouse choice', async () => {
 const name='onec_find_latest_purchase';
 const onec={bases:[],definitions:[{type:'function',name}],proofs:[],validate:jest.fn(),call:jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({status:'choose_warehouse',warehouses:['Склад Северный','Ответхранение Северный']})}))};
 const fetcher=transport(response({...answer,decision:'clarify',message:'Подтвердите выбор: Склад Северный или Ответхранение Северный?'}));
 fetcher.mockResolvedValueOnce(Response.json({id:'t',status:'completed',output:[{type:'function_call',name,call_id:'c',arguments:'{}'}]}));
 const result=await requestOpenAIAnswer({...input,messages:[{role:'user',text:'Какое последнее приобретение по складу Северный?'}],onec},new AbortController().signal,fetcher);
 expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).tool_choice).toBe('auto');
 expect(result.decision).toBe('clarify');expect(onec.call).toHaveBeenCalledTimes(1);
});

test('the model cannot silently replace a partial warehouse name with one guessed candidate', async () => {
 const name='onec_find_latest_purchase';const onec={bases:[],definitions:[{type:'function',name}],proofs:[],validate:jest.fn(),call:jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({status:'choose_warehouse'})}))};
 const fetcher=transport(response({...answer,decision:'clarify'}));
 fetcher.mockResolvedValueOnce(Response.json({id:'t',status:'completed',output:[{type:'function_call',name,call_id:'c',arguments:JSON.stringify({baseKey:'qa',arguments:{warehouseText:'Ответхранение Северный'}})}]}));
 await requestOpenAIAnswer({...input,messages:[{role:'user',text:'Какое последнее приобретение по складу Северный?'}],onec},new AbortController().signal,fetcher);
 expect(onec.call).toHaveBeenCalledWith(name,{baseKey:'qa',arguments:{warehouseText:'Северный'}},expect.any(AbortSignal));
});

test('a found warehouse document remains evidence for completing the overall goal', async () => {
 const name='onec_find_latest_purchase';
 const onec={bases:[],definitions:[{type:'function',name}],proofs:[{baseKey:'qa',revision:1,binding:'fixture'}],validate:jest.fn(),call:jest.fn().mockResolvedValue(JSON.stringify({data:JSON.stringify({kind:'purchase',period:{},status:'found',warehouse:'Тестовый склад',document:{number:'TEST-1',date:'2026-06-01T00:00:00',posted:true}})}))};
 const fetcher=transport(response({...answer,message:'Найдено проведённое приобретение TEST-1 от 01.06.2026.'}));
 fetcher.mockResolvedValueOnce(Response.json({id:'t',status:'completed',output:[{type:'function_call',name,call_id:'c',arguments:'{}'}]}));
 const r=await requestOpenAIAnswer({...input,messages:[{role:'user',text:'Какое последнее приобретение по складу Тестовый?'}],onec},new AbortController().signal,fetcher);
 expect(r.text).toContain('TEST-1 от 01.06.2026');expect(r.text).toContain('проведённое');expect(fetcher).toHaveBeenCalledTimes(2);expect(onec.validate).toHaveBeenCalled();
});

test('clarification form markers are not streamed or left in the saved fallback', async () => {
 const progress=jest.fn();const fetcher=transport(response({...answer,decision:'clarify',message:'Какие системы?\nOptions: - 1С\n multiSelect: true'},true));
 const r=await requestOpenAIAnswer({...input,progress},new AbortController().signal,fetcher);
 expect(r.text).not.toContain('multiSelect');expect(r.text).not.toContain('Options:');expect(JSON.stringify(progress.mock.calls)).not.toContain('multiSelect');
});
test.each([false,true])('tool-enabled instructions do not retain the knowledge-only IT fallback (general=%s)',async general=>{
 process.env.NODE_ENV='development';process.env.HELP_OPENAI_ALLOW_GENERAL='true';
 const onec={bases:[],definitions:[],proofs:[{baseKey:'qa',revision:1,binding:'qa'}],validate:jest.fn(),call:jest.fn()};
 const fetcher=transport(response(answer));await requestOpenAIAnswer({...input,onec,allowGeneral:general},new AbortController().signal,fetcher);
 const sent=JSON.parse(String(fetcher.mock.calls[0][1]?.body));
 expect(sent.instructions).not.toContain('Если материалы не отвечают на проблему, противоречат друг другу, действия не помогли');
 expect(sent.instructions).not.toContain('Если требуется специалист или действия не помогли, верни decision=handoff.');
});
test('bounded encrypted provider metadata does not count as visible answer text',async()=>{
 const body=envelope(answer);(body.output as any[]).unshift({type:'reasoning',encrypted_content:'x'.repeat(300000)});
 const result=await requestOpenAIAnswer(input,new AbortController().signal,transport(Response.json(body)));
 expect(result.text).toBe(answer.message);expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
});
