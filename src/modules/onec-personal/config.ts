import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export class OnecPersonalError extends Error {
  constructor(public code: string, public status = 422, public diagnostic?: { line?: number; column?: number }) { super(code); this.name = 'OnecPersonalError'; }
}
const baseSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,48}$/), label: z.string().min(1).max(100),
  rpcUrl: z.url(), legacyGuidBinding: z.boolean().default(false),
  allowVpnHttp: z.boolean().default(false),
}).strict();
export type OnecBase = z.infer<typeof baseSchema>;
export function onecBases(): OnecBase[] {
  if (process.env.ONEC_PERSONAL_ENABLED !== 'true') return [];
  try {
    const bases = z.array(baseSchema).min(1).max(20).parse(JSON.parse(readFileSync(process.env.ONEC_PERSONAL_BASES_FILE || '', 'utf8')));
    if (new Set(bases.map(b => b.key)).size !== bases.length || bases.filter(b => b.legacyGuidBinding).length > 1) throw new Error();
    for (const b of bases) {
      const u = new URL(b.rpcUrl);
      const privateHost = /^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(u.hostname);
      if (u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/hs/mcp/rpc') ||
          u.protocol !== 'https:' && !(u.protocol === 'http:' && b.allowVpnHttp && privateHost)) throw new Error();
    }
    return bases;
  } catch { throw new OnecPersonalError('ONEC_NOT_CONFIGURED', 503); }
}
export function onecBase(key: string) {
  const b = onecBases().find(b => b.key === key);
  if (!b) throw new OnecPersonalError('ONEC_BASE_UNAVAILABLE', 404);
  return b;
}
export const baseBinding = (base: OnecBase) => createHash('sha256').update(JSON.stringify([base.key, base.rpcUrl, base.legacyGuidBinding])).digest('hex');
export const connectionAction = (baseKey?: string) => ({ type: 'connect_onec' as const, ...(baseKey ? { baseKey } : {}) });
