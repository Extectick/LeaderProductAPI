jest.mock('../src/modules/help/help.onec-warehouse', () => ({ latestWarehouseDocument: jest.fn() }));
jest.mock('../src/modules/onec-personal/config', () => ({
  ...jest.requireActual('../src/modules/onec-personal/config'),
  onecBases: jest.fn(() => [{ key: 'qa', label: 'Fixture', rpcUrl: 'https://fixture.invalid/mcp/rpc' }]),
}));
jest.mock('../src/modules/onec-personal/service', () => ({ userMcpCall: jest.fn(), validateOnecProofs: jest.fn() }));
import { helpOnecTools } from '../src/modules/help/help.onec-tools';
import { userMcpCall } from '../src/modules/onec-personal/service';
import { readArguments } from '../src/modules/onec-personal/mcp';
const signal = new AbortController().signal;
beforeEach(() => {
  jest.clearAllMocks();
  (userMcpCall as jest.Mock).mockImplementation(async (_user, _base, tool, args) => {
    readArguments(tool, args); // The real server business restrictions still apply.
    return { text: 'fixture', proof: { baseKey: 'qa', revision: 1, binding: 'fixture' } };
  });
});
test('all provider schemas use explicit supported types and portable patterns', () => {
  const definitions = helpOnecTools(7)!.definitions as any[];
  expect(definitions.map(tool => tool.name)).toEqual(['onec_list_metadata_objects', 'onec_get_metadata_structure', 'onec_get_access_rights', 'onec_get_object', 'onec_get_navigation_link', 'onec_get_object_history', 'onec_get_event_log', 'onec_execute_query', 'onec_list_tools', 'onec_inspect_metadata', 'onec_find_latest_purchase', 'onec_find_latest_receipt', 'onec_find_latest_order']);
  function check(schema: any) {
    expect(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']).toContain(schema.type);
    expect(schema.$schema).toBeUndefined(); expect(schema.propertyNames).toBeUndefined(); expect(schema.format).toBeUndefined();
    if (schema.pattern) { expect(schema.pattern).not.toMatch(/\\p\{/); expect(() => new RegExp(schema.pattern)).not.toThrow(); }
    if (schema.type === 'object') {
      expect(schema.additionalProperties).toBe(false);
      for (const child of Object.values(schema.properties)) check(child);
      expect(schema.required.every((key: string) => key in schema.properties)).toBe(true);
    }
  }
  for (const definition of definitions) { expect(definition.strict).toBe(false); check(definition.parameters); }
  const query = definitions.find(tool => tool.name === 'onec_execute_query').parameters.properties.arguments.properties;
  expect(query.parameters).toBeUndefined(); expect(query.parametersJson.type).toBe('string');
});
test('provider arguments translate a JSON parameter object without changing server query limits', async () => {
  const tools = helpOnecTools(7)!;
  const query = 'ВЫБРАТЬ ПЕРВЫЕ 3 Ссылка ИЗ Справочник.Товары';
  const parameters = { Наименование: 'Товар', Количество: 3, Флаг: true, Пусто: null, Ссылка: { type: 'СправочникСсылка.Товары', value: 'fixture' }, Список: ['a', 'b'] };
  await tools.call('onec_execute_query', { baseKey: 'qa', arguments: { query, parametersJson: JSON.stringify(parameters) } }, signal);
  expect(userMcpCall).toHaveBeenCalledWith(7, 'qa', 'execute_query', { query, parameters }, signal);
  expect(readArguments('execute_query', { query, parameters })).toMatchObject({ maxRows: 3, includeColumnTypes: false });
});
test('existing direct parameter-object callers and optional nameMask remain compatible', async () => {
  const tools = helpOnecTools(7)!;
  await tools.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t', parameters: { code: '123' } } }, signal);
  await tools.call('onec_list_metadata_objects', { baseKey: 'qa', arguments: { metaType: 'Catalogs' } }, signal);
  expect(userMcpCall).toHaveBeenCalledTimes(2);
});
test.each(['{bad', 'null', '[]', '"str"', '3', 'x'.repeat(12001)])('malformed parameter JSON is rejected without calling 1C', async parametersJson => {
  const output = await helpOnecTools(7)!.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t', parametersJson } }, signal);
  expect(JSON.parse(output)).toEqual({ error: 'ONEC_TOOL_ARGUMENTS' }); expect(userMcpCall).not.toHaveBeenCalled();
});
test('ambiguous query parameter encodings and non-Unicode metadata identifiers remain rejected', async () => {
  const tools = helpOnecTools(7)!;
  await tools.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t', parametersJson: '{}', parameters: {} } }, signal);
  await tools.call('onec_get_metadata_structure', { baseKey: 'qa', arguments: { metaType: 'Catalogs', name: 'Bad;Name' } }, signal);
  expect(userMcpCall).not.toHaveBeenCalled();
});
test('server accepts valid Cyrillic names and still rejects writes, excess limits and extra fields', async () => {
  const tools = helpOnecTools(7)!;
  await tools.call('onec_get_metadata_structure', { baseKey: 'qa', arguments: { metaType: 'Catalogs', name: 'Номенклатура' } }, signal);
  expect(userMcpCall).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await tools.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'DELETE FROM t' } }, signal))).toMatchObject({ error: 'ONEC_QUERY_FORBIDDEN', retryable: false });
  expect(JSON.parse(await tools.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1001 code FROM t' } }, signal))).toMatchObject({ error: 'ONEC_QUERY_FORBIDDEN', retryable: false });
  expect(JSON.parse(await tools.call('onec_get_metadata_structure', { baseKey: 'qa', arguments: { metaType: 'Catalogs', name: 'Товары', privilegedMode: true } }, signal))).toEqual({ error: 'ONEC_TOOL_ARGUMENTS' });
});

test('metadata masks normalize outer glob characters at the common server boundary', () => {
  expect(readArguments('list_metadata_objects', { metaType: 'Documents', nameMask: '*Приобрет*' })).toMatchObject({ nameMask: 'Приобрет', maxItems: 100 });
  expect(readArguments('list_metadata_objects', { metaType: 'Documents', nameMask: '%Поступ%' })).toMatchObject({ nameMask: 'Поступ' });
});

test('a rejected query is distinguishable from an outage and never leaks upstream details', async () => {
  const { OnecPersonalError } = require('../src/modules/onec-personal/config');
  (userMcpCall as jest.Mock).mockRejectedValue(new OnecPersonalError('ONEC_TOOL_FAILED', 422));
  expect(JSON.parse(await helpOnecTools(7)!.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t' } }, signal))).toMatchObject({ error: 'ONEC_TOOL_FAILED', category: 'request', retryable: false });
  (userMcpCall as jest.Mock).mockRejectedValue(new OnecPersonalError('ONEC_TIMEOUT', 503));
  expect(JSON.parse(await helpOnecTools(7)!.call('onec_execute_query', { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t' } }, signal))).toMatchObject({ error: 'ONEC_TIMEOUT', category: 'availability', retryable: true });
});

test('query repair gets safe numeric diagnostics while actual data permission denial does not request new credentials', async () => {
  const { OnecPersonalError } = require('../src/modules/onec-personal/config');
  (userMcpCall as jest.Mock).mockRejectedValue(new OnecPersonalError('ONEC_QUERY_EXPECTED_IDENTIFIER', 422, { line: 1, column: 176 }));
  const args = { baseKey: 'qa', arguments: { query: 'SELECT TOP 1 code FROM t' } };
  expect(JSON.parse(await helpOnecTools(7)!.call('onec_execute_query', args, signal))).toMatchObject({ error: 'ONEC_QUERY_EXPECTED_IDENTIFIER', category: 'request', diagnostic: { line: 1, column: 176 } });
  (userMcpCall as jest.Mock).mockRejectedValue(new OnecPersonalError('ONEC_QUERY_ACCESS_DENIED', 422));
  expect(JSON.parse(await helpOnecTools(7)!.call('onec_execute_query', args, signal))).toMatchObject({ error: 'ONEC_QUERY_ACCESS_DENIED', category: 'access', retryable: false });
});

test('latest warehouse operations are server-side personal reads with isolated proofs', async () => {
 const { latestWarehouseDocument } = require('../src/modules/help/help.onec-warehouse');
 latestWarehouseDocument.mockResolvedValue({status:'not_found',proofs:[{baseKey:'qa',revision:1,binding:'fixture'}]});
 const tools=helpOnecTools(7)!;
 const out=JSON.parse(await tools.call('onec_find_latest_purchase',{baseKey:'qa',arguments:{warehouseText:'Тестовый склад',startDate:'2026-05-04',endDate:'2026-11-04'}},signal));
 expect(latestWarehouseDocument).toHaveBeenCalledWith(7,'qa',{kind:'purchase',warehouseText:'Тестовый склад',startDate:'2026-05-04',endDate:'2026-11-04'},signal);
 expect(JSON.parse(out.data).status).toBe('not_found');expect(out.data).not.toContain('proofs');expect(tools.proofs).toHaveLength(1);
});

test('metadata inspection batches only actual matching objects under one personal binding', async () => {
  (userMcpCall as jest.Mock).mockImplementation(async (_user, baseKey, tool, args) => {
    readArguments(tool, args);
    return { text: tool === 'list_metadata_objects'
      ? 'Документ.Приобретение (Приобретение товаров)\nДокумент.Поступление (Поступление)\nДокумент.Приобретение (Дубль)\nСправочник.Склады (Не тот тип)\nПодсказка: Документ.Выдуманный'
      : `Структура объекта Документ.${args.name}:\nСклад - Справочник.Склады`,
      proof: { baseKey, revision: 1, binding: 'fixture' } };
  });
  const tools = helpOnecTools(7)!;
  const output = JSON.parse(await tools.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents', nameMask: 'При' } }, signal));
  const data = JSON.parse(output.data);
  expect(data).toMatchObject({ metaType: 'Documents', names: ['Приобретение', 'Поступление'], moreMatches: false });
  expect(data.objects).toEqual([
    { name: 'Приобретение', qualifiedName: 'Документ.Приобретение', structure: 'Структура объекта Документ.Приобретение:\nСклад - Справочник.Склады', structureTruncated: false },
    { name: 'Поступление', qualifiedName: 'Документ.Поступление', structure: 'Структура объекта Документ.Поступление:\nСклад - Справочник.Склады', structureTruncated: false },
  ]);
  expect(userMcpCall).toHaveBeenNthCalledWith(1, 7, 'qa', 'list_metadata_objects', { metaType: 'Documents', nameMask: 'При' }, signal);
  expect(userMcpCall).toHaveBeenNthCalledWith(2, 7, 'qa', 'get_metadata_structure', { metaType: 'Documents', name: 'Приобретение' }, signal);
  expect(userMcpCall).toHaveBeenNthCalledWith(3, 7, 'qa', 'get_metadata_structure', { metaType: 'Documents', name: 'Поступление' }, signal);
  expect(tools.proofs).toEqual([{ baseKey: 'qa', revision: 1, binding: 'fixture' }]);
  expect(output.data).not.toContain('binding');
});

test.each([
  ['Catalogs', 'Справочник'], ['Documents', 'Документ'], ['InformationRegisters', 'РегистрСведений'],
  ['AccumulationRegisters', 'РегистрНакопления'], ['Reports', 'Отчёт'], ['Enums', 'Перечисление'],
])('metadata inspection supports %s without guessing technical names', async (metaType, prefix) => {
  (userMcpCall as jest.Mock).mockImplementation(async (_user, baseKey, tool, args) => {
    readArguments(tool, args);
    return { text: tool === 'list_metadata_objects' ? `${prefix}.РеальныйОбъект (Название)` : 'Поля реального объекта', proof: { baseKey, revision: 1, binding: 'fixture' } };
  });
  const output = JSON.parse(await helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType } }, signal));
  expect(JSON.parse(output.data)).toMatchObject({ names: ['РеальныйОбъект'], objects: [{ name: 'РеальныйОбъект', structure: 'Поля реального объекта' }], moreMatches: false });
  expect(userMcpCall).toHaveBeenLastCalledWith(7, 'qa', 'get_metadata_structure', { metaType, name: 'РеальныйОбъект' }, signal);
});

test('metadata inspection bounds ambiguous results and marks truncated structures', async () => {
  (userMcpCall as jest.Mock).mockImplementation(async (_user, baseKey, tool, args) => {
    readArguments(tool, args);
    return { text: tool === 'list_metadata_objects'
      ? Array.from({ length: 8 }, (_, i) => `Документ.Объект${i} (Название)`).join('\n')
      : 'Реквизит - Строка\n'.repeat(1000), proof: { baseKey, revision: 1, binding: 'fixture' } };
  });
  const output = JSON.parse(await helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal));
  const data = JSON.parse(output.data);
  expect(data.moreMatches).toBe(true);
  expect(data.names).toHaveLength(8);
  expect(data.objects.map((o: any) => o.name)).toEqual(['Объект0', 'Объект1', 'Объект2']);
  expect(data.objects.every((o: any) => o.structureTruncated && o.structure.length === 6000)).toBe(true);
  expect(output.data.length).toBeLessThan(24000);
  expect(userMcpCall).toHaveBeenCalledTimes(4);
});

test('metadata inspection does not invent an object after an empty search', async () => {
  (userMcpCall as jest.Mock).mockResolvedValue({ text: 'Объекты не найдены.', proof: { baseKey: 'qa', revision: 1, binding: 'fixture' } });
  const output = JSON.parse(await helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Catalogs', nameMask: 'НетТакого' } }, signal));
  expect(JSON.parse(output.data)).toEqual({ metaType: 'Catalogs', names: [], objects: [], moreMatches: false });
  expect(userMcpCall).toHaveBeenCalledTimes(1);
});

test.each(['revision', 'binding'])('metadata inspection stops when %s changes inside its batch', async field => {
  const { HelpOnecConnectionRequired } = require('../src/modules/help/help.onec-tools');
  (userMcpCall as jest.Mock).mockResolvedValueOnce({ text: 'Документ.Реальный', proof: { baseKey: 'qa', revision: 1, binding: 'fixture' } })
    .mockResolvedValueOnce({ text: 'private result must not be returned', proof: { baseKey: 'qa', revision: 1, binding: 'fixture', [field]: field === 'revision' ? 2 : 'changed' } });
  await expect(helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal)).rejects.toBeInstanceOf(HelpOnecConnectionRequired);
  expect(userMcpCall).toHaveBeenCalledTimes(2);
});

test('metadata inspection fences against an earlier same-base read', async () => {
  const { HelpOnecConnectionRequired } = require('../src/modules/help/help.onec-tools');
  const tools = helpOnecTools(7)!;
  await tools.call('onec_list_metadata_objects', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal);
  (userMcpCall as jest.Mock).mockResolvedValueOnce({ text: 'Документ.Реальный', proof: { baseKey: 'qa', revision: 2, binding: 'fixture' } });
  await expect(tools.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal)).rejects.toBeInstanceOf(HelpOnecConnectionRequired);
  expect(userMcpCall).toHaveBeenCalledTimes(2);
});

test('metadata inspection uses protected connection action for auth errors and hides other upstream errors', async () => {
  const { OnecPersonalError } = require('../src/modules/onec-personal/config');
  const { HelpOnecConnectionRequired } = require('../src/modules/help/help.onec-tools');
  (userMcpCall as jest.Mock).mockRejectedValueOnce(new OnecPersonalError('ONEC_ACCESS_DENIED', 422));
  await expect(helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal)).rejects.toBeInstanceOf(HelpOnecConnectionRequired);
  (userMcpCall as jest.Mock).mockRejectedValueOnce(new Error('PRIVATE_DIAGNOSTIC'));
  const output = await helpOnecTools(7)!.call('onec_inspect_metadata', { baseKey: 'qa', arguments: { metaType: 'Documents' } }, signal);
  expect(JSON.parse(output)).toMatchObject({ error: 'ONEC_UNKNOWN', retryable: false });
  expect(output).not.toContain('PRIVATE_DIAGNOSTIC');
});

test('metadata inspection lists upstream-only metadata categories without calling unsupported structure reads',async()=>{
 (userMcpCall as jest.Mock).mockResolvedValue({text:'ОбщийМодуль.РеальныйМодуль (Модуль)',proof:{baseKey:'qa',revision:1,binding:'fixture'}});
 const result=JSON.parse(await helpOnecTools(7)!.call('onec_inspect_metadata',{baseKey:'qa',arguments:{metaType:'CommonModules',maxItems:1000}},signal));
 expect(JSON.parse(result.data)).toMatchObject({metaType:'CommonModules',names:['РеальныйМодуль'],objects:[],structuresAvailable:false});
 expect(userMcpCall).toHaveBeenCalledTimes(1);
});
