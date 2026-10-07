const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

(async () => {
  const origin = 'https://api.leader-product.ru';
  const page = await fetch(origin + '/download', { signal: AbortSignal.timeout(30000) });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(await page.text(), fs.readFileSync(__dirname + '/index.html', 'utf8'));
  const js = await fetch(origin + '/download/app.js', { signal: AbortSignal.timeout(30000) });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /no-store/);
  const code = await js.text();
  assert.equal(code, fs.readFileSync(__dirname + '/app.js', 'utf8'));
  const slash = await fetch(origin + '/download/', { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(slash.status, 302);
  assert.equal(new URL(slash.headers.get('location'), origin).href, origin + '/download');

  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { addEventListener() {}, removeAttribute() {} });
    return elements.get(id);
  } };
  let target, metadata;
  // Execute only after comparing the public script with the local audited source.
  await vm.runInNewContext(code, { document, URL, AbortController, setTimeout, clearTimeout,
    window: { location: { assign(url) { target = url; } } },
    fetch: async (url, options) => {
      const response = await fetch(new URL(url, origin), options);
      return { ok: response.ok, json: async () => {
        const result = await response.json(); metadata = result.data; return result;
      } };
    },
  });
  assert.equal(target, metadata.downloadUrl);
  assert.ok(target && metadata.checksum);
  const apk = await fetch(target, { signal: AbortSignal.timeout(120000) });
  assert.equal(apk.status, 200);
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of apk.body) { bytes += chunk.length; hash.update(chunk); }
  assert.equal(hash.digest('hex'), metadata.checksum);
  assert.equal(bytes, metadata.fileSize);
  const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(30000) });
  assert.equal(health.status, 200);
  console.log(JSON.stringify({ url: origin + '/download', permanentPage: true,
    freshDownloadUrl: true, version: metadata.latestVersionName, versionCode: metadata.latestVersionCode,
    bytes, checksumVerified: true, apiHealthy: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
