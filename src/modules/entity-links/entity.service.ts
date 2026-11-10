import { onecBase } from '../onec-personal/config';
import { userMcpCall, validateOnecProofs } from '../onec-personal/service';
import { normalizeEntityTarget, type EntityCardData, type EntityField, type EntityTable, type EntityValue, type OnecEntityTarget } from './entity.contract';
import { onecReferenceValue } from './entity.reference';

export class EntityResolveError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = 'EntityResolveError'; }
}
export const ENTITY_TABLE_ROWS = 100;
const MAX_FIELDS = 500;
const MAX_TABLES = 30;
const MAX_COLUMNS = 100;
const MAX_VALUE_CHARS = 8000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const secret = (key: string) => /password|passwd|secret|credential|authorization|cookie|private.?key|api.?key|token|парол|токен|секрет/iu.test(key);
const omitted = (key: string) => secret(key) || key === 'navigationLink';
const label = (key: string) => key.replace(/([а-яёa-z0-9])([А-ЯЁA-Z])/g, '$1 $2').replace(/_/g, ' ');
const sameTarget = (left: OnecEntityTarget, right: OnecEntityTarget) => left.baseKey === right.baseKey && left.metaType === right.metaType && left.name === right.name && left.guid === right.guid;

/** Parse a successful MCP object, retaining values and typed references without executing content. */
export function entityCardFromOnec(target: OnecEntityTarget, payload: unknown, sourceLabel?: string, maxTabularRows = ENTITY_TABLE_ROWS): EntityCardData {
  if (!Number.isInteger(maxTabularRows) || maxTabularRows < 1 || maxTabularRows > 1000) throw new EntityResolveError('ENTITY_INVALID_LIMIT', 400);
  if (!object(payload)) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
  const errorCode = typeof payload.code === 'string' ? payload.code : object(payload.error) && typeof payload.error.code === 'string' ? payload.error.code : undefined;
  if (payload.found === false || payload.status === 'not_found' || errorCode && ['NOT_FOUND','OBJECT_NOT_FOUND','ONEC_OBJECT_NOT_FOUND','REFERENCE_NOT_FOUND'].includes(errorCode)) {
    throw new EntityResolveError('ENTITY_NOT_FOUND', 404);
  }
  if (payload.success !== true || !object(payload.data) || !object(payload.data.fields)) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
  const data = payload.data;
  if (data.tabularSections !== undefined && !object(data.tabularSections)) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
  const dataFields = data.fields as Record<string, unknown>;
  const reference = onecReferenceValue(data.reference, target.baseKey) || onecReferenceValue(dataFields.Ссылка, target.baseKey);
  if (reference?.target.source === 'onec' && !sameTarget(target, reference.target)) throw new EntityResolveError('ENTITY_RESPONSE_MISMATCH', 502);
  let truncated = payload.truncated === true || data.truncated === true;
  const shorten = (text: string) => {
    if (text.length > MAX_VALUE_CHARS) truncated = true;
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, MAX_VALUE_CHARS);
  };
  const cleaned = (value: unknown, depth = 0): unknown => {
    if (depth > 6) { truncated = true; return '[…]'; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return shorten(value);
    if (Array.isArray(value)) {
      if (value.length > 100) truncated = true;
      return value.slice(0, 100).map(item => cleaned(item, depth + 1));
    }
    if (object(value)) {
      const entries = Object.entries(value).filter(([key]) => !omitted(key));
      if (entries.length > 100) truncated = true;
      return Object.fromEntries(entries.slice(0, 100).map(([key, item]) => [key, cleaned(item, depth + 1)]));
    }
    return null;
  };
  const toValue = (value: unknown): EntityValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
      return value;
    }
    if (typeof value === 'string') return shorten(value);
    const ref = onecReferenceValue(value, target.baseKey);
    if (ref) return {...ref, label:shorten(ref.label)};
    // An enum, empty reference or unsupported reference kind remains readable text, never a fabricated link.
    if (object(value) && (value._objectRef === true || typeof value.metadata === 'string')) {
      return typeof value.presentation === 'string' ? shorten(value.presentation) || null : null;
    }
    return shorten(JSON.stringify(cleaned(value)) ?? '');
  };
  const entries = Object.entries(dataFields).filter(([key]) => !omitted(key));
  if (entries.length > MAX_FIELDS) truncated = true;
  const fields: EntityField[] = entries.slice(0, MAX_FIELDS).map(([key, value]) => ({key, label:label(key), value:toValue(value)}));
  const sections = object(data.tabularSections) ? Object.entries(data.tabularSections).filter(([key]) => !omitted(key)) : [];
  if (!reference && !entries.length && !sections.length) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
  if (sections.length > MAX_TABLES) truncated = true;
  const tables: EntityTable[] = sections.slice(0, MAX_TABLES).map(([key, section]) => {
    const sourceRows = Array.isArray(section) ? section : object(section) && Array.isArray(section.rows) ? section.rows : null;
    if (!sourceRows || sourceRows.some(row => !object(row))) throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502);
    const columnKeys = [...new Set(sourceRows.flatMap(row => Object.keys(row as object).filter(column => !omitted(column))))];
    const columns = columnKeys.slice(0, MAX_COLUMNS).map(column => ({key:column, label:label(column)}));
    // The upstream array form has no count: reaching its requested cap is conservatively partial.
    const tableTruncated = sourceRows.length >= maxTabularRows || columnKeys.length > MAX_COLUMNS || object(section) && (section.truncated === true || typeof section.totalRows === 'number' && section.totalRows > sourceRows.length);
    if (tableTruncated) truncated = true;
    const rows = sourceRows.slice(0, maxTabularRows).map(row => Object.fromEntries(columns.map(column => [column.key, toValue((row as Record<string, unknown>)[column.key])])));
    return {key, label:label(key), columns, rows, truncated:!!tableTruncated};
  });
  const rawTitle = reference?.label || (typeof dataFields.Наименование === 'string' && dataFields.Наименование.trim()) || (typeof dataFields.Номер === 'string' && dataFields.Номер.trim() ? `${label(target.name)} № ${dataFields.Номер.trim()}` : label(target.name));
  const title = shorten(rawTitle).slice(0, 500);
  return {target, view:target.metaType === 'Catalogs' && target.name === 'Номенклатура' ? 'product' : target.metaType === 'Documents' && target.name === 'ЗаказКлиента' ? 'client-order' : 'generic',
    title, ...(sourceLabel ? {subtitle:sourceLabel.slice(0, 200)} : {}), fields, tables, truncated};
}

export async function resolveEntityTarget(userId: number, input: unknown, signal: AbortSignal, maxTabularRows = ENTITY_TABLE_ROWS): Promise<EntityCardData> {
  if (!Number.isInteger(maxTabularRows) || maxTabularRows < 1 || maxTabularRows > 1000) throw new EntityResolveError('ENTITY_INVALID_LIMIT', 400);
  const target = normalizeEntityTarget(input);
  if (!target) throw new EntityResolveError('ENTITY_INVALID_TARGET', 400);
  // APP profile rendering intentionally uses its existing endpoint and existing profile ACL.
  if (target.source === 'app') throw new EntityResolveError('ENTITY_PROFILE_USE_EXISTING', 400);
  signal.throwIfAborted();
  const base = onecBase(target.baseKey);
  const result = await userMcpCall(userId, target.baseKey, 'get_object', {metaType:target.metaType, name:target.name, guid:target.guid,
    includeTabularSections:true, maxTabularRows}, signal);
  signal.throwIfAborted();
  let payload: unknown;
  try { payload = JSON.parse(result.text || ''); }
  catch { throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED', 502); }
  const card = entityCardFromOnec(target, payload, base.label, maxTabularRows);
  await validateOnecProofs(userId, [result.proof]);
  signal.throwIfAborted();
  return card;
}
