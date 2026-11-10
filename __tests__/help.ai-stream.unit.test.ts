import { readHelpAIStream, streamedStringField } from '../src/modules/help/help.ai-stream';

test('incremental JSON strings preserve escapes, boundaries and top-level ownership', () => {
  const value = { analysis_summary: 'Проверю «код» 😀\nи подключение.', message: 'Нажмите "Вход".\\', source_ids: [] };
  const json = JSON.stringify(value);
  for (let length = 0; length <= json.length; length++) {
    const partial = streamedStringField(json.slice(0, length), 'analysis_summary');
    expect(value.analysis_summary.startsWith(partial)).toBe(true);
  }
  expect(streamedStringField(json, 'message')).toBe(value.message);
  expect(streamedStringField('{"nested":{"message":"private"},"message":"public', 'message')).toBe('public');
  expect(streamedStringField('{"analysis_summary":"mentions \\"message\\"","message":"ok"}', 'missing')).toBe('');
  expect(streamedStringField('{"message":"x\\u04', 'message')).toBe('x');
});

test('SSE survives byte-sized UTF-8/CRLF chunks and requires a terminal response', async () => {
  const data = 'event: update\r\ndata: {"type":"response.output_text.delta","delta":"Привет 😀"}\r\n\r\ndata: {"type":"response.completed","response":{"id":"ok"}}\r\n\r\n';
  const bytes = new TextEncoder().encode(data), events: unknown[] = [];
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  await expect(readHelpAIStream(response, async event => { events.push(event); })).resolves.toEqual({ id: 'ok' });
  expect(events[0]).toEqual({ type: 'response.output_text.delta', delta: 'Привет 😀' });
  await expect(readHelpAIStream(new Response('data: {"type":"response.created"}\n\n'), async () => {})).rejects.toThrow('INCOMPLETE');
});

test('malformed or oversized SSE never becomes a completed response', async () => {
  await expect(readHelpAIStream(new Response('data: {broken}\n\n'), async () => {})).rejects.toThrow();
  await expect(readHelpAIStream(new Response('x'.repeat(1024 * 1024 + 1)), async () => {})).rejects.toThrow('FRAME');
});

test('encrypted provider metadata can arrive in a bounded larger SSE frame',async()=>{
 const response={id:'fixture',output:[{type:'reasoning',encrypted_content:'x'.repeat(300000)}]};
 const data='data: '+JSON.stringify({type:'response.completed',response})+'\n\n';
 await expect(readHelpAIStream(new Response(data),async()=>{})).resolves.toEqual(response);
});
