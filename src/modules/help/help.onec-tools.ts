import { z } from 'zod';
import { helpOnecFailure } from './help.onec-errors';
import { latestWarehouseDocument } from './help.onec-warehouse';
import { connectionAction, onecBases, OnecPersonalError } from '../onec-personal/config';
import { readToolSchemas, onecListMetadataTypes, onecStructureMetadataTypes, onecObjectTypes, onecMetadataSections } from '../onec-personal/mcp';
import { OnecProof, userMcpCall, userMcpListTools, validateOnecProofs } from '../onec-personal/service';

export class HelpOnecConnectionRequired extends Error {
  constructor(public baseKey: string) { super('ONEC_AUTH_REQUIRED'); }
}
export type HelpOnecTools = {
  bases: Array<{ key: string; label: string }>;
  definitions: unknown[];
  call: (name: string, args: unknown, signal: AbortSignal) => Promise<string>;
  proofs: OnecProof[];
  validate: () => Promise<void>;
};
// The provider accepts a smaller JSON Schema dialect than the server validator.
// Keep Unicode validation in readToolSchemas; never send its \p{} regexes or
// z.unknown() record schemas to OpenAI. Explicitly typed schemas work for every tool.
const metaType = { type: 'string', enum: [...onecListMetadataTypes] };
const structureMetaType = { type: 'string', enum: [...onecStructureMetadataTypes] };
const nameProperty = { type: 'string', minLength: 1, maxLength: 100, description: 'Точное короткое имя из метаданных без префикса Документ. или Справочник.; не угадывай.' };
const objectSelectorProperties = {
  metaType: { type: 'string', enum: [...onecObjectTypes] }, name: nameProperty,
  guid: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Проверенный GUID объекта; не угадывай.' },
};
const readDescriptions: Record<string, string> = {
  list_metadata_objects:'Поиск доступных объектов метаданных по типу и простой подстроке имени. Пустой поиск не исключает другой смысловой вариант.',
  get_metadata_structure:'Реальные поля, типы и табличные части выбранного объекта. Для товаров используй sections=[tabular_sections] и ограниченный execute_query по подтверждённой ТЧ. Изучи перед построением запроса, включая поля связанных справочников и регистров.',
  get_access_rights:'Права сотрудника только на указанный объект. Не подтверждает роль или доступ к другим объектам.',
  get_object:'Чтение конкретного доступного объекта по точному GUID из результата запроса. Для состава товаров можно включить ограниченные табличные части через includeTabularSections=true и maxTabularRows; не выдавай ограниченную выборку за полный состав.',
  get_navigation_link:'Получить штатную навигационную ссылку 1С для проверенного объекта. Это ссылка 1С e1cib, а не ссылка на карточку приложения; для карточек приложения используй отдельные entity-инструменты.',
  get_object_history:'История версий объекта, авторы, сохранённые снимки и изменения соседних версий. includeState=true проверяет ПометкаУдаления, Проведен и дополнительный field. Для продолжения используй beforeVersion. Автор версии без снимка не доказывает изменение конкретного поля.',
  get_event_log:'Чтение журнала регистрации 1С по объекту, периоду и фильтрам. Различай успешное действие и ошибку/попытку: событие с ошибкой не доказывает успешное изменение. Пустой журнал относится только к проверенным условиям и сохранённому периоду.',
  execute_query:'Запрос чтения на языке 1С по изученным метаданным. Inline ПЕРВЫЕ/TOP необязателен; maxRows ограничивает только порцию ответа (до 1000), COUNT/SUM считают все строки по условиям и личным правам. Для полного списка используй устойчивый порядок и продолжение по ключу; truncated=true означает неполную порцию. Значения передавай через parametersJson. Пустой результат относится только к условиям запроса.',
};
const providerArguments: Record<keyof typeof readToolSchemas, { properties: Record<string, unknown>; required: string[] }> = {
  list_metadata_objects: { properties: { metaType, nameMask: { type: 'string', maxLength: 100, description: 'Подстрока имени без * и %. Для повторного поиска попробуй другой корень слова.' }, maxItems: { type: 'integer', minimum: 1, maximum: 1000, description: 'Размер порции метаданных; по умолчанию 100. При усечении уточни маску поиска.' } }, required: ['metaType'] },
  get_metadata_structure: { properties: { metaType: structureMetaType, name: nameProperty, sections: { type: 'array', items: { type: 'string', enum: [...onecMetadataSections] }, minItems: 1, maxItems: 6, description: 'Для состава товаров документа запроси tabular_sections. При усечённом inspect_metadata запроси нужную секцию отдельно.' }, maxTypesInComposite: { type: 'integer', minimum: 0, maximum: 1000, description: 'Число типов составного реквизита; 0 — все типы. Полезно при усечённом списке типов.' } }, required: ['metaType', 'name'] },
  get_access_rights: { properties: { metadata: { type: 'string', minLength: 3, maxLength: 201, description: 'Тип.Имя объекта метаданных, например Справочник.Товары.' } }, required: ['metadata'] },
  get_object: { properties: { metaType: { type: 'string', enum: [...onecObjectTypes] }, name: nameProperty,
    guid: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', description: 'Точный GUID найденного документа из результата запроса; не угадывай.' },
    includeTabularSections: { type: 'boolean', description: 'Для состава товаров включи ограниченное чтение табличных частей. По умолчанию false.' },
    maxTabularRows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Размер порции каждой табличной части при includeTabularSections=true. По умолчанию 20, максимум 1000; усечение не означает полный состав. Для продолжения читай строки запросом по устойчивому ключу.' } }, required: ['metaType', 'name', 'guid'] },
  get_navigation_link: { properties: objectSelectorProperties, required: ['metaType', 'name', 'guid'] },
  get_object_history: { properties: { ...objectSelectorProperties,
    maxRows: { type: 'integer', minimum: 1, maximum: 100, description: 'Версий в порции: до 100 без снимков, до 20 при includeState=true (по умолчанию true). При продолжении передавай beforeVersion.' },
    beforeVersion: { type: 'integer', minimum: 1, description: 'Версии строго старше этого номера; продолжение предыдущей порции.' },
    includeState: { type: 'boolean', description: 'По умолчанию true: читать сохранённые снимки и сравнивать значения; false возвращает только авторов и даты.' },
    field: { type: 'string', minLength: 1, maxLength: 100, description: 'Дополнительный реквизит шапки для сравнения, например Статус. ПометкаУдаления и Проведен проверяются автоматически.' },
  }, required: ['metaType', 'name', 'guid'] },
  get_event_log: { properties: {
    object: { type: 'object', additionalProperties: false, properties: objectSelectorProperties, required: ['metaType', 'name', 'guid'], description: 'Отбор по одному проверенному объекту.' },
    startDate: { type: 'string', description: 'Начало периода ISO 8601; по умолчанию последние 24 часа. Для истории укажи нужный период явно.' },
    endDate: { type: 'string', description: 'Конец периода ISO 8601; по умолчанию текущий момент.' },
    levels: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['Information', 'Warning', 'Error', 'Note'] } },
    events: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Имена событий журнала; не угадывай их, если можно прочитать журнал объекта без этого фильтра.' },
    metadata: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 201 }, description: 'Полные имена объектов метаданных.' },
    comment: { type: 'string', maxLength: 1000, description: 'Подстрока комментария журнала.' },
    maxRows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Размер порции (по умолчанию 200). Усечённый результат не доказывает отсутствие события; сузь период/условия.' },
  }, required: [] },
  execute_query: { properties: { query: { type: 'string', minLength: 1, maxLength: 6000 }, maxRows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Размер порции ответа, по умолчанию 100 или inline TOP. Это не ограничение исходных записей для COUNT/SUM. Для всех строк используй устойчивый порядок и постраничный запрос по ключу, проверяй truncated.' },
    parametersJson: { type: 'string', maxLength: 12000, description: 'Необязательно: параметры запроса как строка JSON-объекта. Например {"Код":"123"}. Не строка массива и не выражение 1С. Ссылки передавай объектом ссылки из результата execute_query (с metadata/guid/_objectRef), не строкой GUID/представлением. Если параметров нет, не передавай это поле.' } }, required: ['query'] },
};
function providerQueryInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const outer = input as Record<string, unknown>, args = outer.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.prototype.hasOwnProperty.call(args, 'parametersJson')) return input;
  const { parametersJson, ...rest } = args as Record<string, unknown>;
  if (typeof parametersJson !== 'string' || parametersJson.length > 12000 || Object.prototype.hasOwnProperty.call(rest, 'parameters')) return null;
  try {
    const parameters: unknown = JSON.parse(parametersJson);
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
    return { ...outer, arguments: { ...rest, parameters } };
  } catch { return null; }
}
const warehouseKinds = { onec_find_latest_purchase: 'purchase', onec_find_latest_receipt: 'receipt', onec_find_latest_order: 'order' } as const;
const warehouseArguments = z.object({ warehouseText: z.string().trim().min(2).max(160), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const warehouseProperties = {
  warehouseText: { type: 'string', minLength: 2, maxLength: 160, description: 'Передавай именно слова склада из запроса сотрудника, не подставляй полное название из знаний и не добавляй Ответхранение или Склад от себя. Сервер сам проверяет точное совпадение и неоднозначность.' },
  startDate: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Начало явно заданного периода YYYY-MM-DD; для последнего документа без периода не передавать.' },
  endDate: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Последний день явно заданного периода включительно. Сохраняй подтверждённые сотрудником даты.' },
};
const metadataPrefixes = {
  Catalogs: 'Справочник', Documents: 'Документ', InformationRegisters: 'РегистрСведений',
  AccumulationRegisters: 'РегистрНакопления', AccountingRegisters: 'РегистрБухгалтерии', CalculationRegisters: 'РегистрРасчета',
  Reports: 'Отчет', DataProcessors: 'Обработка', Enums: 'Перечисление',
  ChartsOfCharacteristicTypes: 'ПланВидовХарактеристик', ChartsOfAccounts: 'ПланСчетов', ChartsOfCalculationTypes: 'ПланВидовРасчета',
  BusinessProcesses: 'БизнесПроцесс', Tasks: 'Задача', ExchangePlans: 'ПланОбмена',
} as const;
const MAX_INSPECTED_OBJECTS = 3;
const MAX_METADATA_NAMES = 1000;
const MAX_STRUCTURE_CHARS = 6000;
/** Only exact identifiers returned in metadata list entries may be inspected. */
function listedMetadataNames(text: string, type: typeof onecListMetadataTypes[number]) {
  const prefix = (metadataPrefixes as Record<string, string>)[type];
  const names = new Set<string>();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:[-•]\s*)?([\p{L}]+)\.([\p{L}_][\p{L}\p{N}_]{0,99})(?=\s|\(|$)/gu)) {
    if (prefix && match[1].replace(/ё/g, 'е') !== prefix) continue;
    names.add(match[2]);
    if (names.size > MAX_METADATA_NAMES) break;
  }
  return [...names];
}
export function helpOnecTools(userId: number): HelpOnecTools | undefined {
  const bases = onecBases(); if (!bases.length) return;
  const proofs: OnecProof[] = [];
  const catalogSchema = z.object({ baseKey: z.enum(bases.map(b => b.key) as [string, ...string[]]), arguments: z.object({}).strict().optional() }).strict();
  const warehouseSchema = z.object({ baseKey: z.enum(bases.map(b => b.key) as [string, ...string[]]), arguments: warehouseArguments }).strict();
  const inspectSchema = z.object({ baseKey: z.enum(bases.map(b => b.key) as [string, ...string[]]), arguments: readToolSchemas.list_metadata_objects }).strict();
  function retainInspectionProof(proof: OnecProof, baseKey: string) {
    if (!proof || proof.baseKey !== baseKey || !Number.isSafeInteger(proof.revision) || proof.revision < 0 ||
        typeof proof.binding !== 'string' || !proof.binding || proof.binding.length > 200) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
    const previous = proofs.filter(p => p.baseKey === baseKey);
    if (previous.some(p => p.revision !== proof.revision || p.binding !== proof.binding)) throw new OnecPersonalError('ONEC_AUTH_REQUIRED', 422);
    if (!previous.length) proofs.push({ baseKey, revision: proof.revision, binding: proof.binding });
  }
  const schemas = Object.fromEntries(Object.entries(readToolSchemas).map(([name, schema]) => [
    'onec_' + name, z.object({ baseKey: z.enum(bases.map(b => b.key) as [string, ...string[]]), arguments: schema }).strict(),
  ]));
  return {
    bases: bases.map(({ key, label }) => ({ key, label })), proofs,
    async validate() {
      for (const proof of proofs) {
        try { await validateOnecProofs(userId, [proof]); }
        catch (e) {
          if (e instanceof OnecPersonalError && e.code === 'ONEC_AUTH_REQUIRED') throw new HelpOnecConnectionRequired(proof.baseKey);
          throw e;
        }
      }
    },
    definitions: [...Object.entries(providerArguments).map(([tool, argumentsSchema]) => ({
      type: 'function', name: 'onec_' + tool,
      description: readDescriptions[tool],
      parameters: { type: 'object', additionalProperties: false, properties: {
        baseKey: { type: 'string', enum: bases.map(base => base.key) },
        arguments: { type: 'object', additionalProperties: false, ...argumentsSchema },
      }, required: ['baseKey', 'arguments'] }, strict: false,
    })), {
      type: 'function', name: 'onec_list_tools', strict: false,
      description: 'Получить актуальный каталог MCP выбранной базы под личным подключением. Показывает реальные инструменты сервера, подключённые операции чтения и причины недоступности остальных. Проверяй каталог перед выводом, что нужного инструмента нет; старые ответы и знания могут устареть. Каталог не подтверждает доступ ко всем записям.',
      parameters: { type: 'object', additionalProperties: false, properties: { baseKey: { type: 'string', enum: bases.map(base => base.key) } }, required: ['baseKey'] },
    }, {
      type: 'function', name: 'onec_inspect_metadata', strict: false,
      description: 'Поиск метаданных и чтение полей до трёх найденных объектов за один шаг под личными правами. Предпочитай перед построением запроса вместо отдельных list/structure вызовов. Возвращает только найденные имена, структуры и moreMatches; при усечённой структуре нужные поля проверь отдельно.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        baseKey: { type: 'string', enum: bases.map(base => base.key) },
        arguments: { type: 'object', additionalProperties: false, ...providerArguments.list_metadata_objects },
      }, required: ['baseKey', 'arguments'] },
    }, ...Object.keys(warehouseKinds).map(name => ({
      type: 'function', name, strict: false,
      description: 'Полная безопасная проверка последнего документа по складу: сервер сам проверяет метаданные, ищет склад и читает последний проведённый документ без пометки удаления под личными правами. Используй, когда вид уже установлен: приобретение (purchase), складское поступление (receipt) или приходный ордер (order). found/not_found относится только к этому виду и условиям. Для общего понятия сначала изучи метаданные. warehouse_not_found — уточни поиск по фрагменту; choose_warehouse — предложи реальные варианты. Не требуй повторного согласия.',
      parameters: { type: 'object', additionalProperties: false, required: ['baseKey','arguments'], properties: {
        baseKey: { type: 'string', enum: bases.map(b => b.key) },
        arguments: { type: 'object', additionalProperties: false, required: ['warehouseText'], properties: warehouseProperties },
      } },
    }))],
    async call(name, input, signal) {
      const warehouseKind = Object.prototype.hasOwnProperty.call(warehouseKinds, name) ? warehouseKinds[name as keyof typeof warehouseKinds] : undefined;
      const schema = name === 'onec_list_tools' ? catalogSchema : name === 'onec_inspect_metadata' ? inspectSchema : warehouseKind ? warehouseSchema : Object.prototype.hasOwnProperty.call(schemas, name) ? schemas[name] : null;
      const parsed = schema?.safeParse(name === 'onec_execute_query' ? providerQueryInput(input) : input);
      if (!parsed?.success) return JSON.stringify({ error: 'ONEC_TOOL_ARGUMENTS' });
      try {
        if (name === 'onec_list_tools') {
          signal.throwIfAborted();
          const result = await userMcpListTools(userId, parsed.data.baseKey, signal);
          signal.throwIfAborted();
          retainInspectionProof(result.proof, parsed.data.baseKey);
          const writes = new Set(['execute_code', 'save_object', 'post_document', 'undo_post_document', 'set_deletion_mark']);
          const tools = result.tools.map(tool => {
            const supported = Object.prototype.hasOwnProperty.call(readToolSchemas, tool.name);
            return { name: tool.name, available: supported, ...(supported
              ? { callableName: 'onec_' + tool.name, description: readDescriptions[tool.name], arguments: providerArguments[tool.name as keyof typeof readToolSchemas] }
              : { reason: writes.has(tool.name) ? 'write_or_code_execution_forbidden' : 'adapter_not_connected' }) };
          });
          return JSON.stringify({ baseKey: parsed.data.baseKey, tool: name, data: JSON.stringify({ tools, complete: result.complete, truncated: !result.complete,
            note: 'Каталог подтверждает наличие инструментов сервера, не наличие данных и не права на все объекты. Описания из базы знаний не ограничивают задачи. Используй доступные чтения и проверяй фактический результат.',
          }) });
        }
        if (name === 'onec_inspect_metadata') {
          const args = readToolSchemas.list_metadata_objects.parse(parsed.data.arguments), baseKey = parsed.data.baseKey;
          async function inspectCall(tool: 'list_metadata_objects' | 'get_metadata_structure', arguments_: unknown) {
            signal.throwIfAborted();
            const result = await userMcpCall(userId, baseKey, tool, arguments_, signal);
            signal.throwIfAborted();
            retainInspectionProof(result.proof, baseKey);
            if (typeof result.text !== 'string') throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
            if (result.text.length > 40000) throw new OnecPersonalError('ONEC_RESPONSE_TOO_LARGE', 502);
            return result.text;
          }
          const listed = await inspectCall('list_metadata_objects', args);
          const names = listedMetadataNames(listed, args.metaType);
          const objects: Array<{ name: string; qualifiedName: string; structure: string; structureTruncated: boolean }> = [];
          const structureType = (onecStructureMetadataTypes as readonly string[]).includes(args.metaType) ? args.metaType as typeof onecStructureMetadataTypes[number] : undefined;
          for (const objectName of structureType ? names.slice(0, MAX_INSPECTED_OBJECTS) : []) {
            const structure = await inspectCall('get_metadata_structure', { metaType: structureType!, name: objectName });
            objects.push({ name: objectName, qualifiedName: `${metadataPrefixes[structureType!]}.${objectName}`,
              structure: structure.slice(0, MAX_STRUCTURE_CHARS), structureTruncated: structure.length > MAX_STRUCTURE_CHARS });
          }
          return JSON.stringify({ baseKey, tool: name, data: JSON.stringify({ metaType: args.metaType,
            names: names.slice(0, MAX_METADATA_NAMES), objects, ...(!structureType ? { structuresAvailable: false } : {}), moreMatches: structureType ? names.length > MAX_INSPECTED_OBJECTS : names.length >= (args.maxItems ?? 100) }) });
        }
        if (warehouseKind) {
          const args = warehouseArguments.parse(parsed.data.arguments);
          const result = await latestWarehouseDocument(userId, parsed.data.baseKey, { ...args, kind: warehouseKind }, signal);
          for (const proof of result.proofs) if (!proofs.some(p => p.baseKey === proof.baseKey && p.revision === proof.revision)) proofs.push(proof);
          const { proofs: _proofs, ...data } = result;
          return JSON.stringify({ baseKey: parsed.data.baseKey, tool: name, data: JSON.stringify(data) });
        }
        const result = await userMcpCall(userId, parsed.data.baseKey, name.slice(5), parsed.data.arguments, signal);
        if (!proofs.some(p => p.baseKey === result.proof.baseKey && p.revision === result.proof.revision)) proofs.push(result.proof);
        let text = result.text || '';
        if (name === 'onec_get_object_history' || name === 'onec_get_event_log') {
          let data: Record<string, unknown>;
          try { data = JSON.parse(text); } catch { throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502); }
          if (!data || data.success !== true || !Array.isArray(data.data) || data.rowCount !== data.data.length) throw new OnecPersonalError('ONEC_PROTOCOL_ERROR', 502);
          const snapshotsIncomplete = name === 'onec_get_object_history' && data.data.some(row => row && typeof row === 'object' && (row.snapshot === 'notStored' || typeof row.stateError === 'string' && row.stateError.length > 0));
          text = JSON.stringify({ ...data, completeness: data.truncated === true || snapshotsIncomplete ? 'partial' : data.truncated === false ? 'complete' : 'unknown',
            ...(snapshotsIncomplete ? { snapshotsIncomplete: true, partial: true } : {}),
            ...(name === 'onec_get_event_log' && typeof data.truncated !== 'boolean' ? { completenessReason: 'server_does_not_report_truncation' } : {}),
          });
        }
        return JSON.stringify({ baseKey: parsed.data.baseKey, tool: name, data: text });
      } catch (e) {
        if (e instanceof OnecPersonalError && ['ONEC_AUTH_REQUIRED', 'ONEC_CREDENTIALS_INVALID', 'ONEC_ACCESS_DENIED'].includes(e.code)) throw new HelpOnecConnectionRequired(parsed.data.baseKey);
        // No raw error texts, URLs or credentials in the model context.
        const { label: _label, ...failure } = helpOnecFailure(e instanceof OnecPersonalError ? e.code : 'ONEC_UNKNOWN', e instanceof OnecPersonalError ? e.diagnostic : undefined);
        return JSON.stringify(failure);
      }
    },
  };
}
export function onecConnectAnswer(baseKey: string) {
  return { mode: 'openai' as const, sources: [], action: connectionAction(baseKey),
    text: 'Чтобы проверить данные в 1С, подключите свою учётную запись. Откройте форму ниже: если учётная запись уже сопоставлена, логин будет заполнен. Пароль вводится только в форме.' };
}
