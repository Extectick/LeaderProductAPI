import { OnecPersonalError } from '../onec-personal/config';
import { type OnecProof, userMcpCall } from '../onec-personal/service';
import { onecReferenceValue } from '../entity-links/entity.reference';

export type WarehouseDocumentKind = 'purchase' | 'receipt' | 'order';
export type LatestWarehouseDocumentInput = {
  kind: WarehouseDocumentKind;
  warehouseText: string;
  /** Inclusive ISO calendar dates. Omit either bound when the employee did not specify it. */
  startDate?: string;
  endDate?: string;
};
export type WarehouseMcpExecutor = (userId: number, baseKey: string, tool: string, args: unknown, signal?: AbortSignal) => Promise<{ text?: string; proof: OnecProof }>;
type Common = { kind: WarehouseDocumentKind; proofs: OnecProof[]; period: { startDate?: string; endDate?: string } };
export type LatestWarehouseDocumentResult = Common & (
  | { status: 'metadata_unavailable' }
  | { status: 'warehouse_not_found' }
  | { status: 'choose_warehouse'; warehouses: string[]; moreMatches: boolean }
  | { status: 'not_found'; warehouse: string; documentLabel: string }
  | { status: 'found'; warehouse: string; documentLabel: string; document: { number: string; date: string; posted: true; reference?: {_objectRef:true;metadata:string;guid:string;presentation:string} } }
);
// Configuration metadata names, never record IDs/names/dates. Every run verifies
// these names and required field types in this employee's actual available base.
const DOCUMENTS: Record<WarehouseDocumentKind, { name: string; label: string }> = {
  purchase: { name: 'ПриобретениеТоваровУслуг', label: 'Приобретение товаров и услуг' },
  receipt: { name: 'ПоступлениеТоваровНаСклад', label: 'Поступление товаров на склад' },
  order: { name: 'ПриходныйОрдерНаТовары', label: 'Приходный ордер на товары' },
};
const sqlString = (value: string) => '"' + value.replace(/"/g, '""') + '"';
function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9998) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  return date;
}
function dateLiteral(date: Date): string {
  return `ДАТАВРЕМЯ(${date.getUTCFullYear()},${date.getUTCMonth() + 1},${date.getUTCDate()})`;
}
function warehouseWords(text: string): string[] {
  if (!text.trim() || text.length > 160 || /[\x00-\x1f]/.test(text)) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const words = [...new Set((text.match(/[\p{L}\p{N}]+/gu) || []).filter(word => !/^(?:склад|складе|склада|складу|на|в|по|город|г)$/iu.test(word)))];
  if (!words.length || words.length > 8) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  return words;
}
function queryRows(text: string): Array<Record<string, unknown>> {
  let result: unknown;
  try { result = JSON.parse(text); } catch { throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502); }
  if (!result || typeof result !== 'object') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  const value = result as { success?: unknown; data?: unknown; rowCount?: unknown; truncated?: unknown };
  if (value.truncated === true) throw new OnecPersonalError('ONEC_RESPONSE_TOO_LARGE', 502);
  if (value.success === false) throw new OnecPersonalError('ONEC_TOOL_FAILED', 422);
  if (value.success !== true || !Array.isArray(value.data) || typeof value.rowCount !== 'number' || value.rowCount !== value.data.length || value.data.length > 10 || value.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  return value.data;
}
function structureHasFields(text: string): boolean {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const field = line.match(/^\s*([\p{L}\p{N}_]+)\s+-\s+(.+?)\s+-\s+/u);
    if (field) fields.set(field[1], field[2]);
  }
  return fields.get('Склад') === 'Справочник.Склады' && fields.get('Номер') === 'Строка' && fields.get('Дата') === 'Дата' && fields.get('Проведен') === 'Булево' && fields.get('ПометкаУдаления') === 'Булево';
}

/** Bounded server workflow; all network access uses the employee's personal MCP
 * connection, with no fallback identity and no arbitrary model-authored query. */
export async function latestWarehouseDocument(userId: number, baseKey: string, input: LatestWarehouseDocumentInput, signal?: AbortSignal, execute: WarehouseMcpExecutor = userMcpCall): Promise<LatestWarehouseDocumentResult> {
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^[a-z0-9-]{1,48}$/.test(baseKey) || !input || !Object.prototype.hasOwnProperty.call(DOCUMENTS, input.kind) || typeof input.warehouseText !== 'string') throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const words = warehouseWords(input.warehouseText);
  const start = input.startDate === undefined ? undefined : calendarDate(input.startDate);
  const end = input.endDate === undefined ? undefined : calendarDate(input.endDate);
  if (start && end && start > end) throw new OnecPersonalError('ONEC_TOOL_ARGUMENTS', 400);
  const endExclusive = end ? new Date(end.getTime() + 86400000) : undefined;
  const period = { ...(input.startDate ? { startDate: input.startDate } : {}), ...(input.endDate ? { endDate: input.endDate } : {}) };
  const proofs: OnecProof[] = [];
  const common: Common = { kind: input.kind, period, proofs };
  async function call(tool: string, args: unknown) {
    if (signal?.aborted) throw new OnecPersonalError('ONEC_CANCELLED', 422);
    const result = await execute(userId, baseKey, tool, args, signal);
    if (signal?.aborted) throw new OnecPersonalError('ONEC_CANCELLED', 422);
    if (!result.proof || result.proof.baseKey !== baseKey || !Number.isSafeInteger(result.proof.revision) || result.proof.revision < 0 || typeof result.proof.binding !== 'string' || result.proof.binding.length > 200 || typeof result.text !== 'string') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
    if (proofs.length && (proofs[0].revision !== result.proof.revision || proofs[0].binding !== result.proof.binding)) throw new OnecPersonalError('ONEC_AUTH_REQUIRED', 422);
    if (!proofs.length) proofs.push({ baseKey, revision: result.proof.revision, binding: result.proof.binding });
    return result.text;
  }
  const metadata = DOCUMENTS[input.kind];
  const available = await call('list_metadata_objects', { metaType: 'Documents', nameMask: metadata.name });
  const names = new Set([...available.matchAll(/(?:^|\n)\s*Документ\.([\p{L}\p{N}_]+)/gu)].map(match => match[1]));
  if (!names.has(metadata.name)) return { ...common, status: 'metadata_unavailable' };
  const structure = await call('get_metadata_structure', { metaType: 'Documents', name: metadata.name });
  if (!structure.includes(`Структура объекта Документ.${metadata.name}:`) || !structureHasFields(structure)) return { ...common, status: 'metadata_unavailable' };

  // Only letters/digits enter LIKE patterns; punctuation cannot become wildcard
  // operators or query syntax. Generic words such as «на складе» are ignored.
  const lookup = 'ВЫБРАТЬ ПЕРВЫЕ 10 Склады.Наименование ИЗ Справочник.Склады КАК Склады ГДЕ НЕ Склады.ПометкаУдаления И ' + words.map(word => `Склады.Наименование ПОДОБНО ${sqlString('%' + word + '%')}`).join(' И ') + ' УПОРЯДОЧИТЬ ПО Склады.Наименование';
  const warehouses = queryRows(await call('execute_query', { query: lookup }));
  const choices = warehouses.map(row => row.Наименование);
  if (choices.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  if (!choices.length) return { ...common, status: 'warehouse_not_found' };
  const normalized = (name: string) => name.normalize('NFC').toLocaleLowerCase('ru-RU').trim().replace(/\s+/g, ' ');
  const exact = choices.filter(name => normalized(name as string) === normalized(input.warehouseText));
  const candidates = exact.length === 1 ? exact : choices;
  if (candidates.length !== 1) return { ...common, status: 'choose_warehouse', warehouses: candidates as string[], moreMatches: choices.length >= 10 };
  const warehouse = candidates[0] as string;
  const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Док.Ссылка, Док.Номер, Док.Дата, Док.Проведен ИЗ Документ.${metadata.name} КАК Док ГДЕ НЕ Док.ПометкаУдаления И Док.Проведен И Док.Склад.Наименование = ${sqlString(warehouse)}` +
    (start ? ` И Док.Дата >= ${dateLiteral(start)}` : '') + (endExclusive ? ` И Док.Дата < ${dateLiteral(endExclusive)}` : '') + ' УПОРЯДОЧИТЬ ПО Док.Дата УБЫВ, Док.Номер УБЫВ';
  const rows = queryRows(await call('execute_query', { query }));
  if (rows.length > 1) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  if (!rows.length) return { ...common, status: 'not_found', warehouse, documentLabel: metadata.label };
  const row = rows[0];
  if (typeof row.Номер !== 'string' || row.Номер.length > 100 || typeof row.Дата !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(row.Дата) || row.Проведен !== true) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
  const ref=row.Ссылка===undefined?null:onecReferenceValue(row.Ссылка,baseKey);
  if(row.Ссылка!==undefined&&(!ref||ref.target.source!=='onec'||ref.target.metaType!=='Documents'||ref.target.name!==metadata.name))throw new OnecPersonalError('ONEC_PROTOCOL_ERROR',502);
  const reference=ref&&ref.target.source==='onec'?{_objectRef:true as const,metadata:`Документ.${metadata.name}`,guid:ref.target.guid,presentation:ref.label}:undefined;
  return { ...common, status: 'found', warehouse, documentLabel: metadata.label, document: { number: row.Номер, date: row.Дата, posted: true,...(reference?{reference}:{}) } };
}
