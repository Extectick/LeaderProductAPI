// One temporary file verifies the real HTTPS -> Nextcloud -> dedicated S3 path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = name => Object.fromEntries(fs.readFileSync(path.join(root, name), 'utf8')
  .split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map(line => { const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const login = readEnv('.env.nextcloud.local');
const storage = readEnv('.env.knowledge.local');
if (login.NEXTCLOUD_URL !== 'https://cloud.leader-product.ru' ||
    storage.KNOWLEDGE_S3_BUCKET !== '66f2164cfa3e-leader-knowledge' ||
    storage.KNOWLEDGE_S3_ENDPOINT !== 'https://s3.ru1.storage.beget.cloud') {
  throw new Error('Unexpected target');
}
const key = `Материалы компании/.knowledge-check-${randomUUID()}.txt`;
const url = `${login.NEXTCLOUD_URL}/remote.php/dav/files/${encodeURIComponent(login.NEXTCLOUD_USER)}/` +
  ['База знаний', ...key.split('/')].map(encodeURIComponent).join('/');
const headers = { Authorization: 'Basic ' + Buffer.from(`${login.NEXTCLOUD_USER}:${login.NEXTCLOUD_PASSWORD}`).toString('base64') };
const request = (method, body) => fetch(url, { method, body, headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
const client = new S3Client({ endpoint: storage.KNOWLEDGE_S3_ENDPOINT,
  region: storage.KNOWLEDGE_S3_REGION || 'ru1', forcePathStyle: true, maxAttempts: 1,
  credentials: { accessKeyId: storage.KNOWLEDGE_S3_ACCESS_KEY, secretAccessKey: storage.KNOWLEDGE_S3_SECRET_KEY } });
let attempted = false;
try {
  const body = `Nextcloud knowledge integration check ${randomUUID()}\n`;
  attempted = true;
  const uploaded = await request('PUT', body);
  await uploaded.body?.cancel();
  if (uploaded.status !== 201) throw new Error(`DavPutHTTP${uploaded.status}`);
  const downloaded = await request('GET');
  if (!downloaded.ok || await downloaded.text() !== body) throw new Error('DavContentMismatch');
  const object = await client.send(new GetObjectCommand({ Bucket: storage.KNOWLEDGE_S3_BUCKET, Key: key }),
    { abortSignal: AbortSignal.timeout(15000) });
  if (await object.Body.transformToString() !== body) throw new Error('S3ContentMismatch');
  console.log(JSON.stringify({ ok: true, https: true, webdavWriteRead: true, s3ReadablePath: true }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.name, message: /^(Dav|S3)/.test(error.message) ? error.message : 'request_failed' }));
  process.exitCode = 1;
} finally {
  if (attempted) {
    try {
      const deleted = await request('DELETE');
      await deleted.body?.cancel();
      if (![204, 404].includes(deleted.status)) throw new Error('delete_failed');
      console.log(JSON.stringify({ probeCleanedUp: true }));
    } catch { console.error(JSON.stringify({ cleanupRequired: true, key })); process.exitCode = 1; }
  }
  client.destroy();
}
