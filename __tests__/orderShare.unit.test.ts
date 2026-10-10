import { clientContactsSchema, normalizeContactPhone, normalizeMessenger, resolveClientContacts } from '../src/modules/orderShare/clientContacts';
import { createShareToken, encryptShareToken, decryptShareToken, isShareToken, projectShareOrder, shareTokenHash } from '../src/modules/orderShare/orderShare.model';

test('customer contacts use default phone only when custom phones are absent', () => {
  expect(resolveClientContacts(null, 79001234567n).phones).toEqual([{ label: '', number: '+79001234567' }]);
  expect(resolveClientContacts({ phones: [{ label: 'Рабочий', number: '8 (900) 765-43-21' }], telegramUrl: '@manager_one', maxUrl: null }, 79001234567n))
    .toEqual({ phones: [{ label: 'Рабочий', number: '+79007654321' }], telegramUrl: 'https://t.me/manager_one', maxUrl: null });
  expect(normalizeContactPhone('9001234567')).toBe('+79001234567');
  expect(normalizeContactPhone('tel:79001234567')).toBeNull();
});
test('rejects invalid phones, duplicate normalized phones, arbitrary or credential-bearing links', () => {
  expect(clientContactsSchema.safeParse({ phones: [{ number: '123' }] }).success).toBe(false);
  expect(clientContactsSchema.safeParse({ phones: [{ number: '89001234567' }, { number: '+79001234567' }] }).success).toBe(false);
  expect(clientContactsSchema.safeParse({ phones: Array.from({ length: 6 }, (_, i) => ({ number: `7900123456${i}` })) }).success).toBe(false);
  for (const url of ['javascript:alert(1)', 'https://t.me.evil.ru/name', 'https://user@t.me/name', 'https://t.me/name?token=x', 'http://max.ru/user']) {
    expect(normalizeMessenger(url, 'telegram')).toBeNull();
    expect(normalizeMessenger(url, 'max')).toBeNull();
  }
  expect(normalizeMessenger('https://max.ru/u/abc-123', 'max')).toBe('https://max.ru/u/abc-123');
  expect(clientContactsSchema.safeParse({ phones: [], telegramId: '123' }).success).toBe(false);
});
test('public projection preserves saved final prices, package coefficients and authoritative amounts', () => {
  const order = { status: 'DRAFT', number1c: null, currency: 'RUB', totalAmount: '63.75', comment: 'private', profit: 999,
    counterparty: { guid: 'client', name: 'Клиент', inn: 'secret' },
    items: [{ id: 'line', product: { guid: 'p', name: 'Товар', receiptPrice: 999 }, quantity: '1.5', price: '8.5',
      package: { name: 'кор.', multiplier: '5' }, lineAmount: '63.75', stock: 999, comment: 'private' },
      { isCancelled: true, product: { guid: 'cancelled', name: 'Отменён' }, quantity: 1, price: 300, lineAmount: 300 }] };
  const result = projectShareOrder(order);
  expect(result.items).toEqual([{ id: 'line', productGuid: 'p', name: 'Товар', quantity: '1.5', unit: 'кор.', unitPrice: '42.5', amount: '63.75' }]);
  expect(result.total).toBe('63.75');
  expect(JSON.stringify(result)).not.toMatch(/private|receiptPrice|profit|stock|inn/);
  expect(() => projectShareOrder({ ...order, items: [] })).toThrow();
});
test('capability token is random-sized, encrypted, tamper-resistant and cannot be substituted by a JWT', () => {
  process.env.ORDER_SHARE_SECRET = 'unit-test-only-32-byte-secret-not-live';
  const token = 'a'.repeat(43);
  const encrypted = encryptShareToken(token);
  expect(encrypted).not.toContain(token);
  expect(decryptShareToken(encrypted)).toBe(token);
  const bytes = Buffer.from(encrypted, 'base64url'); bytes[bytes.length - 1] ^= 1;
  expect(() => decryptShareToken(bytes.toString('base64url'))).toThrow();
  expect(isShareToken(token)).toBe(true);
  expect(isShareToken('one.two.three')).toBe(false);
  expect(shareTokenHash(token)).toHaveLength(64);
});

test('new share codes have exactly 12 cryptographic URL-safe characters; old links remain valid', () => {
  process.env.ORDER_SHARE_SECRET = 'unit-test-only-32-byte-secret-not-live';
  const codes = Array.from({ length: 100 }, createShareToken);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) {
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(isShareToken(code)).toBe(true);
    expect(decryptShareToken(encryptShareToken(code))).toBe(code);
  }
  expect(isShareToken('a'.repeat(43))).toBe(true);
  for (const value of ['a'.repeat(8), 'a'.repeat(11), 'a'.repeat(13), 'a'.repeat(44), '../bad/token', 'a'.repeat(12) + '\n']) expect(isShareToken(value)).toBe(false);
});
