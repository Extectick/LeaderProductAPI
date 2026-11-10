import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import prisma from '../../prisma/client';
import { helpBucket, helpS3, helpStorageRequest } from './help.storage';
import { openAIConfiguration, proxyOptions } from './help.openai';
import type { HelpContextMessage } from './help.context-store';
import { helpAudioTranscriptStore, type HelpAudioTranscriptStore } from './help.audio-transcript-store';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 32000;
const formats: Record<string, string> = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};
export type HelpAudioTranscript = { attachmentId: string; status: 'transcribed' | 'no_speech' | 'unavailable' | 'pending' | 'not_started'; text?: string; truncated?: boolean; reason?: string };
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new Error('HELP_AUDIO_CANCELLED')); };
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function dispose(body: GetObjectCommandOutput['Body']) {
  if (body && 'destroy' in body) body.destroy();
  else if (body && 'cancel' in body) void body.cancel().catch(() => {});
}

/** No model-controlled URLs or identities. Each read rechecks the bound source,
 * including cache hits, before disclosure and before returning its transcript. */
export function helpAIAudio(ticketId: number, ownerId: number, throughSequence: number, validate: () => Promise<void>, transport: typeof fetch = fetch, store: HelpAudioTranscriptStore = helpAudioTranscriptStore, attachmentOwnerId = ownerId) {
  const scope = (id: string) => ({ id, ownerId: attachmentOwnerId, kind: 'AUDIO', message: {
    ticketId, authorId: attachmentOwnerId, kind: 'TEXT', sequence: { lte: throughSequence }, ticket: { ownerId },
  } });
  const select = { id: true, objectKey: true, sha256: true, size: true, mimeType: true, messageId: true } as const;
  async function transcribe(attachmentId: string, signal: AbortSignal, readOnly = false): Promise<HelpAudioTranscript> {
    signal.throwIfAborted();
    if (![ticketId, ownerId, throughSequence].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)) throw new Error('HELP_AUDIO_SCOPE');
    await abortable(validate(), signal); signal.throwIfAborted();
    const file = await abortable(prisma.helpAttachment.findFirst({ where: scope(attachmentId), select }), signal);
    if (!file) return { attachmentId, status: 'unavailable', reason: 'attachment_unavailable' };
    const mime = file.mimeType.split(';')[0].trim().toLowerCase(), extension = formats[mime];
    if (!extension) return { attachmentId, status: 'unavailable', reason: 'unsupported_format' };
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      return { attachmentId, status: 'unavailable', reason: 'invalid_audio_size_or_hash' };
    }
    const sameSource = async () => {
      await abortable(validate(), signal); signal.throwIfAborted();
      const current = await abortable(prisma.helpAttachment.findFirst({ where: scope(attachmentId), select }), signal);
      signal.throwIfAborted();
      if (!current || current.objectKey !== file.objectKey || current.sha256 !== file.sha256 || current.size !== file.size ||
          current.mimeType !== file.mimeType || current.messageId !== file.messageId) throw Object.assign(new Error('HELP_CONTEXT_CHANGED'), { code: 'HELP_CONTEXT_CHANGED', status: 409 });
    };
    const model = process.env.HELP_OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-transcribe';
    const key = createHash('sha256').update(JSON.stringify([ownerId,ticketId,attachmentId,file.messageId,file.sha256,file.size,file.mimeType,file.objectKey])).digest('hex');
    const saved = await store.read(attachmentId, key);
    if (readOnly || saved.status === 'transcribed' || saved.status === 'no_speech' || saved.status === 'pending') { await sameSource(); return saved; }
    const token = await store.claim(attachmentId, key, model);
    if (!token) { const current = await store.read(attachmentId, key); await sameSource(); return current; }
    try {
    const deadline = AbortSignal.timeout(90000), bounded = AbortSignal.any([signal, deadline]);
    let body: GetObjectCommandOutput['Body'];
    const cleanup = () => dispose(body);
    bounded.addEventListener('abort', cleanup, { once: true });
    let output: HelpAudioTranscript;
    try {
      if (!openAIConfiguration().enabled) throw new Error('not_configured');
      let apiKey: string;
      try { apiKey = (process.env.OPENAI_API_KEY_FILE ? readFileSync(process.env.OPENAI_API_KEY_FILE, 'utf8') : process.env.OPENAI_API_KEY || '').trim(); }
      catch { throw new Error('not_configured'); }
      if (!apiKey) throw new Error('not_configured');
      const response = await abortable(helpStorageRequest(() => helpS3.send(new GetObjectCommand({ Bucket: helpBucket, Key: file.objectKey }), { abortSignal: bounded })).then(result => {
        if (bounded.aborted) dispose(result.Body); return result;
      }), bounded);
      body = response.Body;
      if (!body || (response.ContentLength ?? file.size) > MAX_BYTES) throw new Error('invalid_audio');
      const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await abortable(iterator.next(), bounded);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BYTES || size > file.size) throw new Error('invalid_audio');
          chunks.push(chunk.value);
        }
      } finally { void iterator.return?.().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      if (size !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error('invalid_audio');
      await sameSource(); bounded.throwIfAborted();
      const form = new FormData();
      form.append('model', model); form.append('response_format', 'json');
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `voice.${extension}`);
      const result = await abortable(transport('https://api.openai.com/v1/audio/transcriptions', {
        ...proxyOptions(), method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: bounded,
      }), bounded);
      if (!result.ok) { void result.body?.cancel().catch(() => {}); throw new Error('provider_unavailable'); }
      // Read a bounded body; never log upstream text/headers or trust arbitrary JSON.
      const reader = result.body?.getReader(); if (!reader) throw new Error('provider_invalid');
      const parts: Uint8Array[] = []; let responseSize = 0;
      try {
        for (;;) {
          const part = await abortable(reader.read(), bounded); if (part.done) break;
          responseSize += part.value.byteLength; if (responseSize > 512 * 1024) throw new Error('provider_invalid'); parts.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (typeof value?.text !== 'string') throw new Error('provider_invalid');
      const text = value.text.trim(), truncated = text.length > MAX_TEXT;
      output = { attachmentId, status: text ? 'transcribed' : 'no_speech', text: text.slice(0, MAX_TEXT), truncated };
    } catch (error) {
      signal.throwIfAborted();
      if ((error as {code?:string})?.code==='HELP_CONTEXT_CHANGED' || [403,409].includes((error as {status?:number})?.status||0)) throw error;
      output = { attachmentId, status: 'unavailable', reason: deadline.aborted ? 'timeout' : 'transcription_unavailable' };
    } finally { bounded.removeEventListener('abort', cleanup); cleanup(); }
    // Source/authorization errors cannot be downgraded to a best-effort result.
    await sameSource(); signal.throwIfAborted();
    await store.finish(attachmentId, key, token, output);
    return output;
    } finally { await store.release(attachmentId, key, token); }
  }
  async function enrich(messages: HelpContextMessage[], signal: AbortSignal, newSequences: readonly number[] = [throughSequence]) {
    const candidates = messages.filter(message => message.role === 'user' && message.author?.kind !== 'it')
      .flatMap(message => message.attachments.filter(file => file.kind === 'AUDIO').map(file => ({ message, file })));
    const fresh = new Set(newSequences);
    candidates.sort((a, b) => Number(fresh.has(b.message.sequence)) - Number(fresh.has(a.message.sequence)) || b.message.sequence - a.message.sequence);
    const results = new Map<string, HelpAudioTranscript>();
    const deadline = AbortSignal.timeout(120000), bounded = AbortSignal.any([signal, deadline]);
    for (const { message, file } of candidates) {
      signal.throwIfAborted();
      if (deadline.aborted) { results.set(file.id, { attachmentId: file.id, status: 'unavailable', reason: 'timeout' }); continue; }
      try {
        let result = await transcribe(file.id, bounded, !fresh.has(message.sequence));
        // Another process may be recognizing this same new message for its UI.
        while (fresh.has(message.sequence) && result.status === 'pending' && !bounded.aborted) {
          await abortable(new Promise(resolve => setTimeout(resolve, 350)), bounded);
          result = await transcribe(file.id, bounded, true);
        }
        if (result.status !== 'not_started' && result.status !== 'pending') results.set(file.id, result);
      }
      catch (error) { signal.throwIfAborted(); if (!deadline.aborted) throw error; results.set(file.id, { attachmentId: file.id, status: 'unavailable', reason: 'timeout' }); }
    }
    signal.throwIfAborted();
    return { results: [...results.values()], messages: messages.map(message => {
      const audio = message.attachments.map(file => results.get(file.id)).filter((value): value is HelpAudioTranscript => !!value);
      if (!audio.length) return message;
      const notes = audio.map(value => value.status === 'transcribed'
        ? `[Голосовое сообщение ${value.attachmentId}; распознанная речь${value.truncated ? ', текст усечён' : ''}]:\n${value.text}`
        : value.status === 'no_speech' ? `[В голосовом сообщении ${value.attachmentId} речь не распознана. Не придумывай содержание.]`
        : `[Голосовое сообщение ${value.attachmentId} не удалось распознать. Не утверждай, что прослушал его; сообщи о недоступности распознавания.]`);
      return { ...message, text: [message.text, ...notes].filter(Boolean).join('\n\n') };
    }) };
  }
  return { transcribe, read: (id: string, signal: AbortSignal) => transcribe(id, signal, true), enrich };
}
