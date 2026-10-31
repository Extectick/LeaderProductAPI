// Uses only the separate knowledge configuration, never application S3 credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  S3Client, HeadBucketCommand, ListObjectsV2Command,
  PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--write-probe')) {
  console.error('Usage: node scripts/knowledge-storage-check.mjs [--write-probe]');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, '.env.knowledge.local');
const values = {};
if (fs.existsSync(configPath)) {
  for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    values[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
}
const required = ['KNOWLEDGE_S3_ENDPOINT', 'KNOWLEDGE_S3_BUCKET', 'KNOWLEDGE_S3_ACCESS_KEY', 'KNOWLEDGE_S3_SECRET_KEY'];
const missing = required.filter(key => !values[key]);
if (missing.length) {
  console.log(JSON.stringify({ ok: false, reason: 'missing_configuration', missing }));
  process.exit(2);
}
if (values.KNOWLEDGE_S3_ENDPOINT !== 'https://s3.ru1.storage.beget.cloud' ||
    values.KNOWLEDGE_S3_BUCKET !== '66f2164cfa3e-leader-knowledge') {
  console.error(JSON.stringify({ ok: false, reason: 'unexpected_storage_target' }));
  process.exit(2);
}
const client = new S3Client({
  endpoint: values.KNOWLEDGE_S3_ENDPOINT,
  region: values.KNOWLEDGE_S3_REGION || 'ru1',
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: { accessKeyId: values.KNOWLEDGE_S3_ACCESS_KEY, secretAccessKey: values.KNOWLEDGE_S3_SECRET_KEY },
});
const Bucket = values.KNOWLEDGE_S3_BUCKET;
const send = command => client.send(command, { abortSignal: AbortSignal.timeout(12000) });
let probeKey;
try {
  await send(new HeadBucketCommand({ Bucket }));
  await send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
  if (args.includes('--write-probe')) {
    probeKey = `.knowledge-checks/${randomUUID()}.txt`;
    const body = `knowledge storage probe ${randomUUID()}\n`;
    await send(new PutObjectCommand({ Bucket, Key: probeKey, Body: body, ContentType: 'text/plain' }));
    const result = await send(new GetObjectCommand({ Bucket, Key: probeKey }));
    if (await result.Body.transformToString() !== body) throw new Error('ProbeContentMismatch');
    const anonymous = await fetch(`${values.KNOWLEDGE_S3_ENDPOINT}/${Bucket}/${probeKey}`, {
      signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    await anonymous.body?.cancel();
    if (![401, 403].includes(anonymous.status)) throw new Error('AnonymousReadNotDenied');
    await send(new DeleteObjectCommand({ Bucket, Key: probeKey }));
    probeKey = undefined;
  }
  console.log(JSON.stringify({ ok: true, read: true, writeProbe: args.includes('--write-probe'),
    anonymousProbeReadDenied: args.includes('--write-probe') }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.name, status: error.$metadata?.httpStatusCode }));
  process.exitCode = 1;
} finally {
  if (probeKey) {
    try { await send(new DeleteObjectCommand({ Bucket, Key: probeKey })); }
    catch { console.error(JSON.stringify({ cleanupRequired: true, key: probeKey })); process.exitCode = 1; }
  }
  client.destroy();
}
