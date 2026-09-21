// Explicitly dev-only synthetic event, never a real user crash. No secrets printed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync('C:/ProgramData/LeaderProduct/SentryDevTunnel/sentry-credentials.json', 'utf8'));
const dsn = new URL(config.dsn);
if (dsn.hostname !== 'dev.leader-product.ru' || config.project !== 'leader-app-dev') throw Error('Dev guard failed');
const eventId = process.argv[2] || crypto.randomBytes(16).toString('hex');
if (!/^[a-f0-9]{32}$/.test(eventId)) throw Error('Invalid event ID');

async function main() {
  if (!process.argv[2]) {
    const event = { event_id: eventId, timestamp: Date.now() / 1000, environment: 'development',
      platform: 'javascript', level: 'error', message: 'LeaderProduct dev ingestion smoke (not a user crash)',
      tags: { qa_smoke: 'true' } };
    const envelope = [JSON.stringify({ event_id: eventId, dsn: config.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n');
    const response = await fetch(`https://dev.leader-product.ru/sentry/api/${config.projectId}/envelope/`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body: envelope, signal: AbortSignal.timeout(25000),
    });
    console.log(JSON.stringify({ eventId, ingestionStatus: response.status }));
    if (!response.ok) throw Error('Dev ingestion failed');
  }
  const url = `${config.sentryUrl}/api/0/projects/${config.organization}/${config.project}/events/${eventId}/`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${config.readToken}` }, signal: AbortSignal.timeout(25000) });
  console.log(JSON.stringify({ eventId, sentryStoredStatus: response.status }));
  if (response.ok) {
    const event = await response.json();
    const payload = Buffer.from(JSON.stringify({ project: { slug: config.project }, group: { id: event.groupID }, event }));
    const signature = crypto.createHmac('sha256', config.webhookSecret).update(payload).digest('hex');
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await fetch('https://dev.leader-product.ru/integrations/sentry/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ServiceHook-Signature': signature }, body: payload,
        signal: AbortSignal.timeout(15000),
      });
      console.log(JSON.stringify({ eventId, deliveryAttempt: attempt + 1, apiStatus: saved.status }));
      if (saved.status !== 204) throw Error('API did not acknowledge event');
    }
  }
  const forged = await fetch('https://dev.leader-product.ru/integrations/sentry/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ServiceHook-Signature': '0'.repeat(64) }, body: '{}', signal: AbortSignal.timeout(15000),
  });
  const anonymous = await fetch('https://dev.leader-product.ru/admin/crash-events', { signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ forgedStatus: forged.status, anonymousReadStatus: anonymous.status }));
  if (forged.status !== 401 || anonymous.status !== 401) throw Error('Access guard failed');
}
main().catch(error => { console.error(error.name === 'Error' ? error.message : error.name); process.exitCode = 1; });
