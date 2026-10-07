const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');

function harness(responses) {
  const elements = Object.fromEntries(['status', 'download', 'retry'].map(id => [id, {
    hidden: true, removeAttribute(name) { delete this[name]; },
    addEventListener(_event, action) { this.click = action; },
  }]));
  const requests = [], downloads = [];
  const context = { document: { getElementById: id => elements[id] },
    window: { location: { assign: url => downloads.push(url) } }, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
  };
  return { elements, requests, downloads, ready: vm.runInNewContext(source, context) };
}
const update = (version, token) => ({ ok: true, data: { updateAvailable: true, latestVersionName: version,
  downloadUrl: `https://api.leader-product.ru/files/prod/updates/apk/${version}.apk?token=${token}` } });

test('resolves prod at each visit and obtains a fresh URL after a new release', async () => {
  const h = harness([update('0.1.26', 'first'), update('0.1.33', 'second')]);
  await h.ready;
  assert.equal(h.requests[0].url, '/updates/check?platform=android&channel=prod&versionCode=0');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.elements.download.hidden, false);
  await h.elements.retry.click();
  assert.equal(h.downloads.length, 2);
  assert.match(h.downloads[1], /0\.1\.33\.apk\?token=second$/);
});
test('does not expose an old link after an API failure and allows retry', async () => {
  const h = harness([update('0.1.26', 'expired'), new Error('network'), update('0.1.26', 'fresh')]);
  await h.ready;
  await h.elements.retry.click();
  assert.equal(h.elements.download.hidden, true);
  assert.equal(h.elements.download.href, undefined);
  assert.equal(h.elements.retry.disabled, false);
  assert.equal(h.elements.retry.hidden, false);
  assert.equal(h.downloads.length, 1);
  await h.elements.retry.click();
  assert.match(h.downloads[1], /token=fresh$/);
});
for (const response of [
  { ok: false }, { ok: true, data: { updateAvailable: false } },
  { ok: true, data: { updateAvailable: true, downloadUrl: 'javascript:alert(1)' } },
  { ok: true, data: { updateAvailable: true, downloadUrl: 'https://user:password@example.com/a.apk' } },
]) test('rejects unavailable or unsafe release responses ' + JSON.stringify(response), async () => {
  const h = harness([response]); await h.ready;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.elements.download.hidden, true);
  assert.equal(h.elements.retry.hidden, false);
});
