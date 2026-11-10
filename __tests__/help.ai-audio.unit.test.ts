import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: { helpAttachment: { findFirst: jest.fn() } } }));
jest.mock('../src/modules/help/help.storage', () => ({ helpBucket: 'private', helpS3: { send: jest.fn() }, helpStorageRequest: (fn: () => Promise<unknown>) => fn() }));
jest.mock('../src/modules/help/help.openai', () => ({ openAIConfiguration: () => ({ enabled: true }), proxyOptions: () => ({}) }));
import prisma from '../src/prisma/client';
import { helpS3 } from '../src/modules/help/help.storage';
import { helpAIAudio, type HelpAudioTranscript } from '../src/modules/help/help.ai-audio';
import type { HelpAudioTranscriptStore } from '../src/modules/help/help.audio-transcript-store';

const id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('fixture audio bytes');
const file = { id, objectKey: 'private-key', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mimeType: 'audio/webm', messageId: 3 };
let owner = 100, validate: jest.Mock, transport: jest.Mock;
let store: HelpAudioTranscriptStore, saved: Map<string, HelpAudioTranscript>, leases: Map<string, string>;
const controller = () => helpAIAudio(87, owner, 9, validate, transport as typeof fetch, store);
beforeEach(() => {
  saved = new Map(); leases = new Map();
  store = {
    async read(id,key) { return saved.get(key) || { attachmentId: id, status: leases.has(key) ? 'pending' : 'not_started' }; },
    async claim(id,key) { if(leases.has(key)||saved.has(key)) return null; leases.set(key,'token');return 'token'; },
    async finish(id,key,token,result) { if(leases.get(key)===token){ if(result.status==='transcribed'||result.status==='no_speech')saved.set(key,result);leases.delete(key); } },
    async release(id,key,token) { if(leases.get(key)===token)leases.delete(key); },
  };
  owner++; jest.clearAllMocks(); process.env.OPENAI_API_KEY = 'fixture-only'; delete process.env.OPENAI_API_KEY_FILE;
  validate = jest.fn(async () => {});
  transport = jest.fn(async () => new Response(JSON.stringify({ text: 'Покажи товары в заказе 77' }), { headers: { 'Content-Type': 'application/json' } }));
  (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(file);
  (helpS3.send as jest.Mock).mockImplementation(async () => ({ Body: Readable.from([bytes]), ContentLength: bytes.length }));
});

test('bound audio is SHA verified, transcribed once, and cached under the requesting account', async () => {
  const reader = controller(), signal = new AbortController().signal;
  await expect(reader.transcribe(id, signal)).resolves.toMatchObject({ status: 'transcribed', text: 'Покажи товары в заказе 77' });
  await reader.transcribe(id, signal);
  expect(transport).toHaveBeenCalledTimes(1); expect(helpS3.send).toHaveBeenCalledTimes(1);
  expect(prisma.helpAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id, ownerId: owner, kind: 'AUDIO', message: expect.objectContaining({ ticketId: 87, authorId: owner, sequence: { lte: 9 } }) }) }));
  const [url, request] = transport.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  expect(request.body.get('model')).toBe('gpt-transcribe'); expect(request.body.get('file').name).toBe('voice.webm');
  expect(request.body.get('file').size).toBe(bytes.length);
  owner++; await controller().transcribe(id, signal); expect(transport).toHaveBeenCalledTimes(2);
});

test('revoked access on a cache hit throws without disclosing the cached words', async () => {
  const reader = controller(), signal = new AbortController().signal;
  await reader.transcribe(id, signal); validate.mockRejectedValue(new Error('HELP_CONTEXT_FORBIDDEN'));
  await expect(reader.transcribe(id, signal)).rejects.toThrow('HELP_CONTEXT_FORBIDDEN');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a substituted blob cannot reach the provider', async () => {
  (helpS3.send as jest.Mock).mockResolvedValue({ Body: Readable.from([Buffer.from('bad')]), ContentLength: 3 });
  await expect(controller().transcribe(id, new AbortController().signal)).resolves.toMatchObject({ status: 'unavailable' });
  expect(transport).not.toHaveBeenCalled();
});

test('attachment edits during transcription invalidate its output', async () => {
  transport.mockImplementation(async () => {
    (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue({ ...file, sha256: 'a'.repeat(64) });
    return new Response(JSON.stringify({ text: 'stale transcript' }));
  });
  await expect(controller().transcribe(id, new AbortController().signal)).rejects.toThrow('HELP_CONTEXT_CHANGED');
});

test('provider failures are not no-speech and do not leak error bodies', async () => {
  transport.mockResolvedValue(new Response('private-provider-error-token', { status: 401 }));
  const result = await controller().transcribe(id, new AbortController().signal);
  expect(result).toMatchObject({ status: 'unavailable', reason: 'transcription_unavailable' });
  expect(JSON.stringify(result)).not.toContain('private-provider');
  transport.mockResolvedValue(new Response(JSON.stringify({ text: '' })));
  expect((await controller().transcribe(id, new AbortController().signal)).status).toBe('no_speech');
});

test('cancelled provider calls return promptly even if transport ignores abort', async () => {
  const abort = new AbortController();
  transport.mockImplementation(() => { abort.abort(new Error('cancelled')); return new Promise(() => {}); });
  await expect(controller().transcribe(id, abort.signal)).rejects.toThrow('cancelled');
});

test('speech stays with its original message and is available before downstream intent selection', async () => {
  const message = { id: 3, sequence: 9, role: 'user' as const, text: '', attachments: [{ id, kind: 'AUDIO', name: 'voice.webm', mimeType: 'audio/webm', size: bytes.length }] };
  const result = await controller().enrich([message], new AbortController().signal);
  expect(result.messages[0]).toMatchObject({ id: 3, sequence: 9, role: 'user' });
  expect(result.messages[0].text).toContain('Покажи товары в заказе 77'); expect(message.text).toBe('');
});

test('foreign or removed attachment stays unavailable without an S3/provider request', async () => {
  (prisma.helpAttachment.findFirst as jest.Mock).mockResolvedValue(null);
  expect((await controller().transcribe(id, new AbortController().signal)).status).toBe('unavailable');
  expect(helpS3.send).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

const message = (sequence: number, attachmentId = id) => ({ id: sequence, sequence, role: 'user' as const, text: '', attachments: [{ id: attachmentId, kind: 'AUDIO', name: 'voice.webm', mimeType: 'audio/webm', size: bytes.length }] });

test('new input only is recognized, old unsaved history never invokes speech', async () => {
  const signal = new AbortController().signal;
  const reader = controller();
  const oldOnly = await reader.enrich([message(2)], signal, [9]);
  expect(transport).not.toHaveBeenCalled(); expect(oldOnly.results).toEqual([]);
  expect(oldOnly.messages[0].text).toBe('');
  await reader.enrich([message(9)], signal, [9]);
  expect(transport).toHaveBeenCalledTimes(1);
  const history = await controller().enrich([message(9)],signal,[12]);
  expect(history.messages[0].text).toContain('Покажи товары');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a saved result survives a new reader and model changes', async () => {
  const signal = new AbortController().signal;
  await controller().transcribe(id,signal);
  process.env.HELP_OPENAI_TRANSCRIBE_MODEL='another-model';
  try { expect((await controller().read(id,signal)).status).toBe('transcribed'); await controller().transcribe(id,signal); }
  finally { delete process.env.HELP_OPENAI_TRANSCRIBE_MODEL; }
  expect(transport).toHaveBeenCalledTimes(1);
});

test('UI and worker concurrent requests share one recognition and GET never starts it', async () => {
  const signal = new AbortController().signal;
  expect((await controller().read(id,signal)).status).toBe('not_started');
  expect(transport).not.toHaveBeenCalled();
  let finish!: () => void;
  const gate = new Promise<void>(resolve=>{finish=resolve;});
  let started!: () => void;
  const active = new Promise<void>(resolve=>{started=resolve;});
  transport.mockImplementation(async()=>{started();await gate;return new Response(JSON.stringify({text:'shared'}));});
  const first = controller().transcribe(id,signal);await active;
  expect((await controller().transcribe(id,signal)).status).toBe('pending');
  expect((await controller().read(id,signal)).status).toBe('pending');
  finish();await first;
  expect((await controller().transcribe(id,signal)).text).toBe('shared');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('cancelled recognition releases its claim for explicit retry', async () => {
  const abort = new AbortController();
  transport.mockImplementation(()=>{abort.abort(new Error('cancelled'));return new Promise(()=>{});});
  await expect(controller().transcribe(id,abort.signal)).rejects.toThrow('cancelled');
  expect(leases.size).toBe(0);
  transport.mockResolvedValue(new Response(JSON.stringify({text:'retry'})));
  expect((await controller().transcribe(id,new AbortController().signal)).text).toBe('retry');
});
