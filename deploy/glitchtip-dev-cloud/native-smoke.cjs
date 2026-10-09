// Synthetic diagnostics only. Does not crash a user's app or include user data.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const cfg = JSON.parse(fs.readFileSync('C:/ProgramData/LeaderProduct/GlitchTipDevCloud/credentials.json'));
const base = process.env.CRASH_BACKEND_URL || 'http://127.0.0.1:19020';
const ingest = process.env.CRASH_INGEST_BASE || 'https://dev.leader-product.ru/sentry';
assert.ok(['http://127.0.0.1:19010', 'http://127.0.0.1:19020'].includes(base));
assert.ok(['http://127.0.0.1:19010', 'https://dev.leader-product.ru/sentry'].includes(ingest));
assert.equal(new URL(cfg.dsn).hostname, 'dev.leader-product.ru');
const auth = { 'X-Sentry-Auth': `Sentry sentry_version=7,sentry_key=${new URL(cfg.dsn).username}` };
const eventUrl = id => `${base}/api/0/projects/${cfg.organization}/${cfg.project}/events/${id}/`;
const envelope = event => [JSON.stringify({ event_id: event.event_id, dsn: cfg.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n');
async function request(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
  return { status: r.status, body: await r.text() };
}
async function main() {
  if (process.argv[2] === 'read') {
    for (const id of process.argv.slice(3)) {
      assert.match(id, /^[a-f0-9]{32}$/);
      const r = await request(eventUrl(id), { headers: { Authorization: `Bearer ${cfg.readToken}` } });
      assert.equal(r.status, 200);
      const event = JSON.parse(r.body);
      const exception = event.entries?.find(e => e.type === 'exception')?.data?.values?.[0];
      assert.ok(exception?.type);
      console.log(JSON.stringify({ eventId: id, platform: event.platform, exception: exception.type, frames: exception.stacktrace?.frames?.length || 0 }));
    }
    return;
  }
  const javaId = crypto.randomBytes(16).toString('hex');
  const java = { event_id: javaId, timestamp: Date.now() / 1000, platform: 'java', level: 'fatal', environment: 'development', release: 'com.leaderproduct.app@0.1.34+33', dist: '33', tags: { qa_smoke: 'synthetic-java', app_version: '0.1.34', build_number: '33' }, exception: { values: [{ type: 'java.lang.IllegalStateException', value: 'Synthetic Java ingestion verification; not a user crash', mechanism: { type: 'UncaughtExceptionHandler', handled: false }, stacktrace: { frames: [{ filename: 'MainApplication.kt', function: 'syntheticSmoke', module: 'com.leaderproduct.app.MainApplication', lineno: 1, in_app: true }] } }] } };
  for (let i = 0; i < 2; i++) {
    const r = await request(`${ingest}/api/${cfg.projectId}/envelope/`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-sentry-envelope' }, body: envelope(java) });
    assert.equal(r.status, 200);
  }
  const form = new FormData();
  form.append('upload_file_minidump', new Blob([fs.readFileSync('C:/Share/GlitchTipDev/upstream/apps/event_ingest/tests/test_data/breakpad_linux_null_deref.dmp')]), 'fixture.dmp');
  form.append('sentry', JSON.stringify({ environment: 'development', release: 'glitchtip-native-fixture-qa', tags: { qa_smoke: 'upstream-breakpad-fixture' } }));
  const native = await request(`${ingest}/api/${cfg.projectId}/minidump/`, { method: 'POST', headers: auth, body: form });
  assert.equal(native.status, 200);
  const nativeId = JSON.parse(native.body).id;
  console.log(JSON.stringify({ javaId, javaSentTwice: true, nativeId, minidumpAccepted: true }));
  const anonymous = await request(`${base}/api/0/projects/${cfg.organization}/${cfg.project}/events/`);
  assert.ok([401, 403].includes(anonymous.status));
  const forged = await request('https://dev.leader-product.ru/integrations/sentry/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ServiceHook-Signature': '0'.repeat(64) }, body: '{}' });
  assert.equal(forged.status, 401);
  console.log(JSON.stringify({ anonymousRead: anonymous.status, forgedApiSummary: forged.status }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
