import {
  formatDigits11ToDisplay,
  normalizePhoneToBigInt,
  normalizePhoneToDigits11,
  toApiPhoneString,
} from '../../src/utils/phone';

describe('phone utils', () => {
  test('normalizes different inputs to 11 digits', () => {
    expect(normalizePhoneToDigits11('+7 (961) 223-13-45')).toBe('79612231345');
    expect(normalizePhoneToDigits11('8-961-223-13-45')).toBe('79612231345');
    expect(normalizePhoneToDigits11('9612231345')).toBe('79612231345');
  });

  test('returns null for invalid phones', () => {
    expect(normalizePhoneToDigits11('123')).toBeNull();
    expect(normalizePhoneToDigits11('+1 555 111 22 33')).toBeNull();
  });

  test('converts to bigint and api string', () => {
    expect(normalizePhoneToBigInt('+7 (961) 223-13-45')).toBe(BigInt('79612231345'));
    expect(toApiPhoneString(BigInt('79612231345'))).toBe('79612231345');
  });

  test('formats display phone', () => {
    expect(formatDigits11ToDisplay('79612231345')).toBe('+7 (961) 223-13-45');
  });
});
