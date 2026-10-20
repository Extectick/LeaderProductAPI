/** 1C hashes the parsed JSON including object insertion order. PostgreSQL JSONB
 * does not preserve that order. Normalize BOTH first writes and retries at the
 * transport boundary, without changing values, array order or stored receipts. */
export function canonicalOrderWriteBody(body: unknown): unknown {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) return undefined;
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
      : value;
  return sorted(JSON.parse(serialized));
}
