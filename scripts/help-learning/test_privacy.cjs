'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { sanitizeSnapshot, containsSensitiveText } = require('./privacy.cjs');
function snapshot(text = 'Не печатает принтер') {
  return { ticketId: 1, sourceVersion: 'a'.repeat(64), status: 'CLOSED', closedAt: '2026-11-05T00:00:00Z', itRequested: false,
    updatedAt: '2026-11-05T00:00:00Z', lastEventId: 3, truncated: false,
    messages: [{ id: 1, sequence: 1, authorRole: 'OWNER', kind: 'TEXT', text, rating: null, createdAt: '2026-11-05T00:00:00Z' }], jobs: [] };
}
test('whitelist removes user identities, keys, files and context and is idempotent', () => {
  const input = snapshot(); input.owner = { name: 'PRIVATE NAME' }; input.context = 'PRIVATE CONTEXT';
  input.messages[0].authorId = 7; input.messages[0].attachments = [{ objectKey: 'PRIVATE KEY' }];
  const result = sanitizeSnapshot(input), json = JSON.stringify(result);
  for (const value of ['PRIVATE NAME', 'PRIVATE CONTEXT', 'PRIVATE KEY', 'authorId', 'attachments']) assert.equal(json.includes(value), false);
  assert.deepEqual(sanitizeSnapshot(result), result); assert.equal(result.sourceVersion, input.sourceVersion);
});
test('credential-bearing messages are suppressed whole and cannot become complete evidence', () => {
  for (const text of ['password=fixture-private', 'Пароль: fixture-private', 'Authorization: Bearer fixture-private', 'postgres://user:fixture-private@fixture.invalid/db', 'sk-fixture-private-key-12345']) {
    const result = sanitizeSnapshot(snapshot('Prefix ' + text + ' suffix'));
    assert.equal(result.messages[0].text, '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]'); assert.equal(result.truncated, true);
    assert.equal(JSON.stringify(result).includes('fixture-private'), false);
    assert.equal(containsSensitiveText(text), true);
  }
});
test('redacts contact endpoints before model and screens them after model', () => {
  const result = sanitizeSnapshot(snapshot('Напишите qa@example.org или +7 (900) 123-45-67. Сервер 192.168.1.2, https://fixture.invalid/path.'));
  assert.equal(result.privacyFlags.includes('contact_redacted'), true);
  assert.equal(containsSensitiveText(result.messages[0].text), false);
  assert.equal(result.messages[0].text.includes('example.org'), false);
});
test('redacts common Russian full names and formatted domestic phone numbers', () => {
  const safe = sanitizeSnapshot(snapshot('Ответил Иван Иванов, телефон 8 (900) 123-45-67.'));
  assert.equal(safe.messages[0].text.includes('Иван Иванов'), false);
  assert.equal(safe.messages[0].text.includes('123-45-67'), false);
  assert.equal(containsSensitiveText(safe.messages[0].text), false);
});
test('bounded text/messages and duplicate IDs cannot silently look complete', () => {
  const input = snapshot('x'.repeat(5000)); assert.equal(sanitizeSnapshot(input).messages[0].text.length, 4000);
  assert.equal(sanitizeSnapshot(input).truncated, true);
  input.messages.push({ ...input.messages[0] }); assert.throws(() => sanitizeSnapshot(input), { code: 'HELP_LEARNING_INVALID_SNAPSHOT' });
  const many = snapshot(); many.messages = Array.from({ length: 81 }, (_, i) => ({ ...many.messages[0], id: i + 1, sequence: i + 1 }));
  assert.equal(sanitizeSnapshot(many).messages.length, 80); assert.equal(sanitizeSnapshot(many).truncated, true);
});
test('normalization catches invisible-character credential labels and rejects malformed versions', () => {
  assert.equal(sanitizeSnapshot(snapshot('pass\u200Bword=fixture-private')).truncated, true);
  assert.throws(() => sanitizeSnapshot({ ...snapshot(), sourceVersion: '../unsafe' }), { code: 'HELP_LEARNING_INVALID_SNAPSHOT' });
});
test('account-labelled credentials and SSH bare passwords suppress the whole message', () => {
  for (const text of ['Для теста можно использовать учетку: fixture_user FictionPass_73',
    'Учётная запись: fixture_user FictionPass_73', 'Учётные данные: fixture_user FictionPass_73',
    'SSH fixture_user@192.0.2.10 FictionPass_73']) {
    const result = sanitizeSnapshot(snapshot(text));
    assert.equal(result.truncated, true); assert.equal(JSON.stringify(result).includes('FictionPass_73'), false);
    assert.equal(containsSensitiveText(text), true);
  }
  const safe = sanitizeSnapshot(snapshot('Подключите учётную запись через профиль.'));
  assert.equal(safe.truncated, false); assert.equal(containsSensitiveText(safe.messages[0].text), false);
});
test('a bare credential reply following a request is suppressed before model input', () => {
  const input = snapshot('Укажите логин и пароль для тестирования.');
  input.messages.push({ ...input.messages[0], id: 2, sequence: 2, text: 'fixture_user FictionPass_73' });
  const safe = sanitizeSnapshot(input);
  assert.equal(safe.messages[1].text, '[СООБЩЕНИЕ С УЧЁТНЫМИ ДАННЫМИ СКРЫТО]');
  assert.equal(safe.truncated, true); assert.equal(JSON.stringify(safe).includes('FictionPass_73'), false);
});
