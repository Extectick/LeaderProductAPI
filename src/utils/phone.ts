export function normalizePhoneToDigits11(input: unknown): string | null {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return null;

  let normalized = digits;
  if (normalized.length === 10) normalized = `7${normalized}`;
  if (normalized.length === 11 && normalized.startsWith('8')) {
    normalized = `7${normalized.slice(1)}`;
  }

  if (normalized.length !== 11 || !normalized.startsWith('7')) {
    return null;
  }
  return normalized;
}

export function normalizePhoneToBigInt(input: unknown): bigint | null {
  const digits = normalizePhoneToDigits11(input);
  if (!digits) return null;
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

export function toApiPhoneString(value: bigint | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = normalizePhoneToDigits11(String(value));
  return digits;
}

export function formatDigits11ToDisplay(input: unknown): string | null {
  const digits = normalizePhoneToDigits11(input);
  if (!digits) return null;
  const p1 = digits.slice(1, 4);
  const p2 = digits.slice(4, 7);
  const p3 = digits.slice(7, 9);
  const p4 = digits.slice(9, 11);
  return `+7 (${p1}) ${p2}-${p3}-${p4}`;
}

export function sanitizePhoneForSearch(input: unknown): string {
  return String(input ?? '').replace(/\D/g, '');
}
