import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import prisma from '../../prisma/client';
import { helpBucket, helpS3, helpStorageRequest } from './help.storage';

export const HELP_AI_IMAGES_TIMEOUT_MS = 10000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Bound waiting even if a response body ignores the transport's abort signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

function disposeBody(body: GetObjectCommandOutput['Body']) {
  if (!body) return;
  if ('destroy' in body) body.destroy();
  else if ('cancel' in body) void body.cancel().catch(() => {});
}

export async function helpAIImages(ticketId: number, ownerId: number, signal: AbortSignal,
  selection?: { attachmentIds: string[]; throughSequence: number }) {
  if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
  if (selection !== undefined && (!selection || !Array.isArray(selection.attachmentIds) || selection.attachmentIds.length < 1 ||
      selection.attachmentIds.length > 2 || new Set(selection.attachmentIds.map(id => typeof id === 'string' ? id.toLowerCase() : id)).size !== selection.attachmentIds.length ||
      selection.attachmentIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      !Number.isSafeInteger(selection.throughSequence) || selection.throughSequence < 1 || selection.throughSequence > 2147483647)) {
    throw Object.assign(new Error('HELP_AI_IMAGE_SELECTION_INVALID'), { code: 'HELP_AI_IMAGE_SELECTION_INVALID' });
  }
  if (selection) selection = { attachmentIds: selection.attachmentIds.map(id => id.toLowerCase()), throughSequence: selection.throughSequence };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('HELP_AI_IMAGES_TIMEOUT')), HELP_AI_IMAGES_TIMEOUT_MS);
  timer.unref();
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const imageWhere = { kind: 'IMAGE', ownerId, ...(selection ? { id: { in: selection.attachmentIds } } : {}) };
    const messages = await abortable(prisma.helpMessage.findMany({ where: { ticketId, authorId: ownerId, kind: 'TEXT',
      ...(selection ? { sequence: { lte: selection.throughSequence }, ticket: { ownerId } } : {}),
      attachments: { some: imageWhere } }, orderBy: { sequence: 'desc' }, take: 2,
      select: { attachments: { where: imageWhere, orderBy: { position: 'asc' }, take: 2,
        select: { objectKey: true, size: true, ...(selection ? {id:true as const,sha256:true as const} : {}) } } } }), boundedSignal);
    const images: Array<{ image_url: string }> = [];
    const pending: Array<{ id: string; objectKey: string; size: number; sha256: string; image_url: string }> = [];
    const candidates = messages.flatMap(message => message.attachments).slice(0, 2);
    if (selection) candidates.sort((a,b) => selection.attachmentIds.indexOf(a.id!) - selection.attachmentIds.indexOf(b.id!));
    for (const file of candidates) {
      if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
      if (boundedSignal.aborted) break;
      if (file.size > MAX_IMAGE_BYTES) continue;
      if (selection && (!file.id || !selection.attachmentIds.includes(file.id) || !Number.isSafeInteger(file.size) || file.size < 1 ||
          typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256))) continue;
      let body: GetObjectCommandOutput['Body'];
      let iterator: AsyncIterator<Uint8Array> | undefined;
      let image: ReturnType<typeof sharp> | undefined;
      const dispose = () => { disposeBody(body); image?.destroy(); };
      boundedSignal.addEventListener('abort', dispose, { once: true });
      try {
        const request = helpStorageRequest(() => helpS3.send(new GetObjectCommand({ Bucket: helpBucket, Key: file.objectKey }), { abortSignal: boundedSignal }));
        // A transport completing after our deadline still owns a body to release.
        const result = await abortable(request.then(result => {
          if (boundedSignal.aborted) disposeBody(result.Body);
          return result;
        }), boundedSignal);
        body = result.Body;
        if (!body || (result.ContentLength ?? Infinity) > MAX_IMAGE_BYTES) continue;
        iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const chunk = await abortable(iterator.next(), boundedSignal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new Error('IMAGE_SIZE');
          chunks.push(chunk.value);
        }
        const bytes = Buffer.concat(chunks);
        if (selection && (size !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256!.toLowerCase())) continue;
        image = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, pages: 1 }).rotate()
          .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 });
        const jpeg = await abortable(image.toBuffer(), boundedSignal);
        boundedSignal.throwIfAborted();
        if (jpeg.length <= 1024 * 1024) {
          const image_url = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
          if (selection) pending.push({id:file.id!,objectKey:file.objectKey,size:file.size,sha256:file.sha256!,image_url});
          else images.push({ image_url });
        }
      } catch {
        if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
      } finally {
        boundedSignal.removeEventListener('abort', dispose);
        dispose();
        // Custom iterators may not settle return() until their pending next()
        // finishes; releasing them must not extend the attempt's deadline.
        void iterator?.return?.().catch(() => {});
      }
    }
    if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
    if (selection && pending.length && !boundedSignal.aborted) {
      // Hold every selected image until all I/O has finished, so processing a
      // second image cannot leave an already deleted first image in the result.
      try {
        const current = await abortable(prisma.helpAttachment.findMany({ where: {
          id: { in: pending.map(file => file.id) }, ownerId, kind: 'IMAGE',
          message: { ticketId, authorId: ownerId, kind: 'TEXT', sequence: { lte: selection.throughSequence }, ticket: { ownerId } },
        }, select: {id:true,objectKey:true,size:true,sha256:true} }), boundedSignal);
        boundedSignal.throwIfAborted();
        for (const image of pending) {
          const same = current.find(file => file.id === image.id);
          if (same && same.objectKey === image.objectKey && same.size === image.size && same.sha256.toLowerCase() === image.sha256.toLowerCase()) {
            images.push({image_url:image.image_url});
          }
        }
      } catch {
        if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
      }
    }
    if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
    return { images, skipped: (selection ? selection.attachmentIds.length : candidates.length) - images.length };
  } catch (error) {
    if (signal.aborted) throw new Error('HELP_AI_CANCELLED');
    throw error;
  } finally { clearTimeout(timer); }
}
