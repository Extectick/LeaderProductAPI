jest.mock('../src/modules/onec-personal/service', () => ({userMcpCall: jest.fn()}));
import {readScheduleStock, scheduleStockQuery} from '../src/modules/help/help.schedule-stock';
import {readArguments} from '../src/modules/onec-personal/mcp';

const proof = {baseKey:'torg2026',revision:3,binding:'fixture'};
const signal = new AbortController().signal;
const row = {Товар:'Товар 1',ИмяСклада:'Склад А',Количество:-2.5};
const response = (data: unknown[], extra = {}) => ({proof,text:JSON.stringify({success:true,data,rowCount:data.length,truncated:false,...extra})});

test.each(['inStock','available'] as const)('reads negative %s with a fixed parameterized personal query', async metric => {
  const warehouse = 'Склад "1"';
  const call=jest.fn().mockResolvedValueOnce(response([{Наименование:warehouse}])).mockResolvedValueOnce(response([row]));
  await expect(readScheduleStock(7,metric,warehouse,signal,call)).resolves.toEqual({
    proof,rows:[{product:'Товар 1',warehouse:'Склад А',quantity:-2.5}],truncated:false,
  });
  for (const [user,base,tool,args,passedSignal] of call.mock.calls) {
    expect([user,base,tool,passedSignal]).toEqual([7,'torg2026','execute_query',signal]);
    expect(readArguments(tool,args).parameters).toEqual({Склад:warehouse});
    expect(args.query).not.toContain(warehouse);
  }
  expect(scheduleStockQuery(metric,true).includes('РезервыМенеджеров')).toBe(metric==='available');
});

test('an empty successful response differs from a missing warehouse, a changed personal connection and an invalid upstream result', async () => {
  await expect(readScheduleStock(7,'inStock','all',signal,jest.fn().mockResolvedValue(response([])))).resolves.toMatchObject({rows:[],truncated:false});
  await expect(readScheduleStock(7,'inStock','А',signal,jest.fn().mockResolvedValue(response([])))).rejects.toThrow(/Склад/);
  const changed=jest.fn().mockResolvedValueOnce(response([{}])).mockResolvedValueOnce({...response([row]),proof:{...proof,revision:4}});
  await expect(readScheduleStock(7,'inStock','А',signal,changed)).rejects.toThrow('ONEC_AUTH_REQUIRED');
  for (const reply of [response([{...row,Количество:0}]),response([], {truncated:true}),response([], {success:false})]) {
    await expect(readScheduleStock(7,'inStock','all',signal,jest.fn().mockResolvedValue(reply))).rejects.toThrow('ONEC_PROTOCOL_ERROR');
  }
});

test('bounded reports mark omissions rather than claiming completeness', async () => {
  const full=await readScheduleStock(7,'inStock','all',signal,jest.fn().mockResolvedValue(response(Array(101).fill(row))));
  expect(full.rows).toHaveLength(100);expect(full.truncated).toBe(true);
  const resized=await readScheduleStock(7,'inStock','all',signal,jest.fn().mockResolvedValue(response([row],{responseSizeReduced:true,pageLimitApplied:1})));
  expect(resized.truncated).toBe(true);
});
