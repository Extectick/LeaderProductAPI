import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OnecPersonalError } from './config';

type Keyring = { active: string; keys: Record<string, string> };
function keyring(): Keyring {
  try {
    const value = JSON.parse(readFileSync(process.env.ONEC_PERSONAL_KEYRING_FILE || '', 'utf8'));
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(value.active) || !value.keys?.[value.active] ||
        Object.values(value.keys).some(k => typeof k !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(k))) throw new Error();
    return value;
  } catch { throw new OnecPersonalError('ONEC_VAULT_UNAVAILABLE', 503); }
}
export function seal(value: string, binding: string): string {
  const ring = keyring(), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(ring.keys[ring.active], 'base64'), iv);
  cipher.setAAD(Buffer.from(binding));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', ring.active, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}
export function unseal(value: string, binding: string): string {
  const ring = keyring();
  try {
    const [v, id, iv, tag, body, extra] = value.split('.');
    if (v !== 'v1' || extra !== undefined || !ring.keys[id] || Buffer.from(iv, 'base64').length !== 12 || Buffer.from(tag, 'base64').length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(ring.keys[id], 'base64'), Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new OnecPersonalError('ONEC_CREDENTIALS_INVALID', 422); }
}
