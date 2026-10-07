import { createHmac } from 'node:crypto';
import { parseSentryServiceHook, verifySentrySignature } from '../src/modules/monitoring/crashEvents';

const secret = 'unit-test-only-'.repeat(4);
const eventId = 'a'.repeat(32);
const payload = () => ({
  project: { slug: 'leader-app-dev' }, group: { id: '123' },
  event: { eventID: eventId, dateCreated: '2026-09-01T10:00:00Z', title: 'Ошибка сохранения',
    user: { id: '42', email: 'private@example.com' },
    tags: [{ key: 'environment', value: 'development' }, { key: 'ota_update_id', value: 'embedded' }],
    request: { headers: { authorization: 'secret' }, data: 'private document' },
    contexts: { device: { model: 'Pixel' }, location: { latitude: 55 } },
  },
});

test('HMAC uses exact UTF-8 bytes and rejects forged, altered or absent signatures', () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  expect(verifySentrySignature(raw, signature, secret)).toBe(true);
  expect(verifySentrySignature(Buffer.concat([raw, Buffer.from(' ')]), signature, secret)).toBe(false);
  for (const value of ['', 'a', 'z'.repeat(64), '0'.repeat(64)]) expect(verifySentrySignature(raw, value, secret)).toBe(false);
  expect(verifySentrySignature(raw, signature, '')).toBe(false);
});

test('only allowlisted diagnostic fields survive; user ID is a diagnostic claim', () => {
  const result = parseSentryServiceHook(payload(), 'leader-app-dev', 'development');
  expect(result).toMatchObject({ eventId, reportedUserId: '42', deviceModel: 'Pixel', otaUpdateId: 'embedded' });
  expect(JSON.stringify(result)).not.toMatch(/private|latitude|authorization/);
});

test('rejects cross-project, cross-environment and malformed data', () => {
  expect(() => parseSentryServiceHook(payload(), 'prod', 'development')).toThrow('PROJECT');
  expect(() => parseSentryServiceHook(payload(), 'leader-app-dev', 'production')).toThrow('ENVIRONMENT');
  const broken = payload(); broken.event.eventID = 'bad';
  expect(() => parseSentryServiceHook(broken, 'leader-app-dev', 'development')).toThrow('EVENT_ID');
  broken.event.eventID = eventId; broken.event.dateCreated = 'bad';
  expect(() => parseSentryServiceHook(broken, 'leader-app-dev', 'development')).toThrow('EVENT_DATE');
});

test('bounds title and redacts common credentials and URLs', () => {
  const input = payload(); input.event.title = 'token=SECRET Bearer ABC https://example.com/?private=yes ' + 'a'.repeat(500);
  const { title } = parseSentryServiceHook(input, 'leader-app-dev', 'development');
  expect(title.length).toBeLessThanOrEqual(300);
  expect(title).not.toMatch(/SECRET|ABC|private/);
});
