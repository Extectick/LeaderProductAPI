/** Versioned object identity shared by links, tools and card resolvers. No capabilities or credentials. */
export const entityOnecTypes = ['Catalogs', 'Documents', 'BusinessProcesses', 'Tasks', 'ExchangePlans', 'ChartsOfCharacteristicTypes', 'ChartsOfAccounts', 'ChartsOfCalculationTypes'] as const;
export type EntityOnecType = typeof entityOnecTypes[number];
export type OnecEntityTarget = { v: 1; source: 'onec'; baseKey: string; metaType: EntityOnecType; name: string; guid: string };
export type AppUserEntityTarget = { v: 1; source: 'app'; kind: 'user'; id: string };
export type AppProductEntityTarget = {v:1;source:'app';kind:'product';guid:string};
export type EntityTarget = OnecEntityTarget | AppUserEntityTarget | AppProductEntityTarget;
export type EntityValue = string | number | boolean | null | { label: string; target: EntityTarget };
export type EntityField = { key: string; label: string; value: EntityValue };
export type EntityTable = { key: string; label: string; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, EntityValue>>; truncated: boolean };
export type EntityCardData = { target: EntityTarget; view: 'product' | 'client-order' | 'user' | 'generic'; title: string; subtitle?: string; fields: EntityField[]; tables: EntityTable[]; truncated: boolean };

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namePattern = /^[\p{L}_][\p{L}\p{N}_]{0,99}$/u;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Returns null for untrusted, unsupported or ambiguous targets; never coerces unrelated IDs. */
export function normalizeEntityTarget(value: unknown): EntityTarget | null {
  if (!object(value) || value.v !== 1) return null;
  if (value.source === 'onec') {
    if (!keysEqual(value, ['v','source','baseKey','metaType','name','guid']) ||
        typeof value.baseKey !== 'string' || !/^[a-z0-9-]{1,48}$/.test(value.baseKey) ||
        typeof value.metaType !== 'string' || !(entityOnecTypes as readonly string[]).includes(value.metaType) ||
        typeof value.name !== 'string' || !namePattern.test(value.name) ||
        typeof value.guid !== 'string' || !guidPattern.test(value.guid) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.guid)) return null;
    return {v:1, source:'onec', baseKey:value.baseKey, metaType:value.metaType as EntityOnecType, name:value.name, guid:value.guid.toLowerCase()};
  }
  if(value.source==='app'&&value.kind==='product'&&keysEqual(value,['v','source','kind','guid'])&&typeof value.guid==='string'&&guidPattern.test(value.guid)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.guid))return {v:1,source:'app',kind:'product',guid:value.guid.toLowerCase()};
  if (value.source === 'app' && value.kind === 'user' && keysEqual(value, ['v','source','kind','id']) &&
      typeof value.id === 'string' && /^[1-9]\d{0,9}$/.test(value.id) && Number(value.id) <= 2147483647) {
    return {v:1, source:'app', kind:'user', id:value.id};
  }
  return null;
}

export function buildEntityLink(value: EntityTarget): string {
  const target = normalizeEntityTarget(value);
  if (!target) throw new TypeError('ENTITY_INVALID_TARGET');
  return target.source === 'app' ? target.kind==='product'?`leaderproduct://entity/v1/product/${target.guid}`:`leaderproduct://entity/v1/user/${target.id}` :
    `leaderproduct://entity/v1/onec/${encodeURIComponent(target.baseKey)}/${target.metaType}/${encodeURIComponent(target.name)}/${target.guid}`;
}

export function parseEntityLink(value: unknown): EntityTarget | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'leaderproduct:' || url.hostname !== 'entity' || url.username || url.password || url.port || url.search || url.hash) return null;
    const parts = url.pathname.split('/').map(decodeURIComponent);
    if(parts.length===4&&parts[0]===''&&parts[1]==='v1'&&parts[2]==='product')return normalizeEntityTarget({v:1,source:'app',kind:'product',guid:parts[3]});
    if (parts.length === 4 && parts[0] === '' && parts[1] === 'v1' && parts[2] === 'user') {
      return normalizeEntityTarget({v:1, source:'app', kind:'user', id:parts[3]});
    }
    if (parts.length === 7 && parts[0] === '' && parts[1] === 'v1' && parts[2] === 'onec') {
      return normalizeEntityTarget({v:1, source:'onec', baseKey:parts[3], metaType:parts[4], name:parts[5], guid:parts[6]});
    }
  } catch { /* Invalid escape sequences and URLs never navigate. */ }
  return null;
}
