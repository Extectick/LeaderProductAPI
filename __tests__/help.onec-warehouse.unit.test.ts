jest.mock('../src/modules/onec-personal/service', () => ({ userMcpCall: jest.fn() }));
import { latestWarehouseDocument, type LatestWarehouseDocumentInput, type WarehouseDocumentKind } from '../src/modules/help/help.onec-warehouse';
import { OnecPersonalError } from '../src/modules/onec-personal/config';
import { readArguments } from '../src/modules/onec-personal/mcp';
const names = { purchase: 'ПриобретениеТоваровУслуг', receipt: 'ПоступлениеТоваровНаСклад', order: 'ПриходныйОрдерНаТовары' };
const input: LatestWarehouseDocumentInput = { kind: 'purchase', warehouseText: 'Город Северный', startDate: '2026-05-04', endDate: '2026-11-04' };
const structure = (name: string) => `Структура объекта Документ.${name}:\n\tНомер - Строка - ""\n\tДата - Дата - ""\n\tПроведен - Булево - ""\n\tПометкаУдаления - Булево - ""\n\tСклад - Справочник.Склады - "Склад"`;
const rows = (data: Array<Record<string, unknown>>, extra = {}) => JSON.stringify({ success: true, rowCount: data.length, truncated: false, data, ...extra });
const doc = { Номер: 'FIXTURE-1', Дата: '2026-06-01T12:34:56', Проведен: true };
function executor(kind: WarehouseDocumentKind = 'purchase', warehouses = [{ Наименование: 'Город Северный' }], documents:Array<Record<string,unknown>> = [doc]) {
  const values = [`Документ.${names[kind]} (Название)`, structure(names[kind]), rows(warehouses), rows(documents)];
  let index = 0;
  return jest.fn(async (_user: number, baseKey: string, tool: string, args: unknown) => {
    // The same validator used by the live personal MCP adapter accepts every
    // generated call; no test transport can bypass the query/read allowlist.
    readArguments(tool, args);
    return { text: values[index++], proof: { baseKey, revision: 3, binding: 'fixture-binding' } };
  });
}

test('finds last posted document with exact inclusive employee dates in four personal calls', async () => {
  const execute = executor();
  const result = await latestWarehouseDocument(7, 'fixture', input, undefined, execute);
  expect(result).toMatchObject({ status: 'found', warehouse: 'Город Северный', period: { startDate: '2026-05-04', endDate: '2026-11-04' }, document: { number: 'FIXTURE-1', date: '2026-06-01T12:34:56', posted: true }, proofs: [{ baseKey: 'fixture', revision: 3, binding: 'fixture-binding' }] });
  expect(execute).toHaveBeenCalledTimes(4);
  expect(execute.mock.calls.every(call => call[0] === 7 && call[1] === 'fixture')).toBe(true);
  const args = execute.mock.calls[3][3] as { query: string };
  expect(args.query).toContain('ПЕРВЫЕ 1'); expect(args.query).toContain('НЕ Док.ПометкаУдаления И Док.Проведен');
  expect(args.query).toContain('Док.Дата >= ДАТАВРЕМЯ(2026,5,4)'); expect(args.query).toContain('Док.Дата < ДАТАВРЕМЯ(2026,11,5)');
  expect(args.query).toContain('УПОРЯДОЧИТЬ ПО Док.Дата УБЫВ, Док.Номер УБЫВ');
});
test.each(['purchase', 'receipt', 'order'] as const)('keeps %s metadata distinct and verifies actual fields before querying', async kind => {
  const execute = executor(kind);
  await latestWarehouseDocument(7, 'fixture', { kind, warehouseText: 'Город Северный' }, undefined, execute);
  expect(execute.mock.calls[1][3]).toEqual({ metaType: 'Documents', name: names[kind] });
  expect((execute.mock.calls[3][3] as { query: string }).query).toContain(`ИЗ Документ.${names[kind]} КАК Док`);
  expect((execute.mock.calls[3][3] as { query: string }).query).not.toContain('ДАТАВРЕМЯ');
});
test('does not choose a guessed or unavailable document or wrong warehouse field type', async () => {
  const missing = executor(); missing.mockResolvedValueOnce({ text: 'Документ.ДругойОбъект (Другой)', proof: { baseKey: 'fixture', revision: 3, binding: 'fixture-binding' } });
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, missing)).resolves.toMatchObject({ status: 'metadata_unavailable' });
  expect(missing).toHaveBeenCalledTimes(1);
  const wrongType = executor(); wrongType.mockImplementationOnce(async () => ({ text: `Документ.${names.purchase}`, proof: { baseKey: 'fixture', revision: 3, binding: 'fixture-binding' } }));
  wrongType.mockImplementationOnce(async () => ({ text: structure(names.purchase).replace('Справочник.Склады', 'Строка'), proof: { baseKey: 'fixture', revision: 3, binding: 'fixture-binding' } }));
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, wrongType)).resolves.toMatchObject({ status: 'metadata_unavailable' });
  expect(wrongType).toHaveBeenCalledTimes(2);
});
test('asks an ordinary warehouse choice on ambiguity and never reads documents', async () => {
  const execute = executor('purchase', [{ Наименование: 'Город Северный' }, { Наименование: 'Город Северный Резерв' }]);
  await expect(latestWarehouseDocument(7, 'fixture', { ...input, warehouseText: 'Северный' }, undefined, execute)).resolves.toMatchObject({ status: 'choose_warehouse', warehouses: ['Город Северный', 'Город Северный Резерв'], moreMatches: false });
  expect(execute).toHaveBeenCalledTimes(3);
});
test('successful empty results remain no-results and are not outages', async () => {
  const execute = executor('purchase', [{ Наименование: 'Город Северный' }], []);
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, execute)).resolves.toMatchObject({ status: 'not_found', warehouse: 'Город Северный', period: { startDate: '2026-05-04', endDate: '2026-11-04' } });
  const missingWarehouse = executor('purchase', []);
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, missingWarehouse)).resolves.toMatchObject({ status: 'warehouse_not_found' });
  expect(missingWarehouse).toHaveBeenCalledTimes(3);
});
test.each([{ startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '2026-11-05', endDate: '2026-05-04' }, { warehouseText: 'на складе' }])('rejects invalid input before network: %j', async patch => {
  const execute = executor();
  await expect(latestWarehouseDocument(7, 'fixture', { ...input, ...patch }, undefined, execute)).rejects.toMatchObject({ code: 'ONEC_TOOL_ARGUMENTS' });
  expect(execute).not.toHaveBeenCalled();
});
test('end-exclusive date rollover is UTC and neither an implicit period nor record is memorized', async () => {
  const execute = executor();
  await latestWarehouseDocument(8, 'different-base', { kind: 'purchase', warehouseText: 'на складе Город Северный', endDate: '2024-02-29' }, undefined, execute);
  expect((execute.mock.calls[3][3] as { query: string }).query).toContain('Док.Дата < ДАТАВРЕМЯ(2024,3,1)');
  expect((execute.mock.calls[3][3] as { query: string }).query).not.toContain('Док.Дата >=');
});
test('warehouse strings cannot inject query syntax, and returned names are quoted safely', async () => {
  const execute = executor('purchase', [{ Наименование: 'Город "Северный"' }]);
  await latestWarehouseDocument(7, 'fixture', { kind: 'purchase', warehouseText: 'Город %_ "Северный"' }, undefined, execute);
  const lookup = (execute.mock.calls[2][3] as { query: string }).query;
  expect(lookup).toContain('ПОДОБНО "%Северный%"');
  expect(lookup).not.toContain('%_');
  expect((execute.mock.calls[3][3] as { query: string }).query).toContain('= "Город ""Северный"""');
});
test('personal access revocation and revision changes stop the workflow without factual output', async () => {
  const denied = executor(); denied.mockRejectedValueOnce(new OnecPersonalError('ONEC_AUTH_REQUIRED'));
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, denied)).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  expect(denied).toHaveBeenCalledTimes(1);
  const changed = executor(); changed.mockImplementationOnce(async () => ({ text: `Документ.${names.purchase}`, proof: { baseKey: 'fixture', revision: 2, binding: 'fixture-binding' } }));
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, changed)).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  expect(changed).toHaveBeenCalledTimes(2);
});
test('tool failures or truncated payloads cannot masquerade as empty successful queries', async () => {
  const bad = executor();
  bad.mockImplementation(async (_user, baseKey, tool, args) => {
    readArguments(tool, args);
    const i = bad.mock.calls.length;
    return { text: i === 1 ? `Документ.${names.purchase}` : i === 2 ? structure(names.purchase) : JSON.stringify({ success: false, error: 'private upstream diagnostic' }), proof: { baseKey, revision: 3, binding: 'fixture-binding' } };
  });
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, bad)).rejects.toMatchObject({ code: 'ONEC_TOOL_FAILED' });
  const truncated = executor(); truncated.mockImplementation(async (_user, baseKey, _tool, _args) => {
    const i = truncated.mock.calls.length;
    return { text: i === 1 ? `Документ.${names.purchase}` : i === 2 ? structure(names.purchase) : rows([{ Наименование: 'Город Северный' }], { truncated: true }), proof: { baseKey, revision: 3, binding: 'fixture-binding' } };
  });
  await expect(latestWarehouseDocument(7, 'fixture', input, undefined, truncated)).rejects.toMatchObject({ code: 'ONEC_RESPONSE_TOO_LARGE' });
});

test('partial warehouse names require a real choice; an exact full name resolves that choice', async () => {
 const warehouses=[{Наименование:'Ответхранение Северный'},{Наименование:'Склад Северный'}];
 const ambiguous=await latestWarehouseDocument(7,'fixture',{kind:'purchase',warehouseText:'Северный'},undefined,executor('purchase',warehouses));
 expect(ambiguous).toMatchObject({status:'choose_warehouse',warehouses:['Ответхранение Северный','Склад Северный']});
 const exact=await latestWarehouseDocument(7,'fixture',{kind:'purchase',warehouseText:'склад северный'},undefined,executor('purchase',warehouses));
 expect(exact).toMatchObject({status:'found',warehouse:'Склад Северный'});
});

test('last-document query returns its actual typed reference without constructing an identity from the number',async()=>{
 const reference={_objectRef:true,metadata:'Документ.ПриобретениеТоваровУслуг',guid:'11111111-1111-4111-8111-111111111111',presentation:'Приобретение FIXTURE-1'};
 const execute=executor('purchase',undefined,[{...doc,Ссылка:reference}]);
 const result=await latestWarehouseDocument(7,'fixture',input,undefined,execute);
 expect((execute.mock.calls[3][3] as {query:string}).query).toContain('Док.Ссылка');
 expect(result).toMatchObject({status:'found',document:{reference}});
 const invalid=executor('purchase',undefined,[{...doc,Ссылка:{...reference,metadata:'Справочник.Номенклатура'}}]);
 await expect(latestWarehouseDocument(7,'fixture',input,undefined,invalid)).rejects.toMatchObject({code:'ONEC_PROTOCOL_ERROR'});
});
