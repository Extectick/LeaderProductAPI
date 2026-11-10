jest.mock('../src/modules/onec-personal/service',()=>({userMcpCall:jest.fn(),validateOnecProofs:jest.fn()}));
import {userMcpCall,validateOnecProofs} from '../src/modules/onec-personal/service';
import {getLinkedClientOrder,LINKED_ORDER_MAX_ITEMS} from '../src/modules/clientOrders/clientOrders.entity';
const guid='b8b8cb5c-d9b9-11f1-9d3e-f6ac37589664';
const other='1a2f2010-c882-4f51-9b5b-3dd5dfb418d5';
const reference=(name:string,id=other)=>({_objectRef:true,metadata:name,guid:id,presentation:'Объект'});
const metadata='Стандартные реквизиты:\n\tСсылка - Документ.ЗаказКлиента - ""\n\tНомер - Строка - ""\n\tДата - Дата - ""\nРеквизиты:\n\tСуммаДокумента - Число - ""\n\tКомментарий - Строка - ""\nТабличные части:\n\tТЧ "Товары" - "Товары":\n\t\tНоменклатура - Справочник.Номенклатура - ""\n\t\tКоличество - Число - ""\n\t\tЦена - Число - ""\n\t\tСумма - Число - ""';
const proof={baseKey:'company',revision:4,binding:'private-binding'};
const response=(data:unknown,truncated=false)=>({text:JSON.stringify({success:true,data,truncated}),proof});
function fixture(count=11){
 jest.mocked(userMcpCall).mockImplementation(async(_user,_base,tool,args:any)=>{
  if(tool==='get_metadata_structure')return {text:metadata,proof};
  if(args.query.includes('КОЛИЧЕСТВО(*)'))return response([{count}]);
  if(args.query.includes('Д.Ссылка КАК reference'))return response([{reference:reference('Документ.ЗаказКлиента',guid),number1c:'TEST-1',date1c:'2026-11-06T00:00:00',totalAmount:110,comment:'Тест'}]);
  const after=args.parameters.ПослеСтроки;
  return response(Array.from({length:Math.min(10,count-after)},(_,i)=>({lineNumber:after+i+1,product:reference('Справочник.Номенклатура'),quantity:2,price:5,lineAmount:10})),true);
 });
}
beforeEach(()=>{jest.clearAllMocks();fixture()});
test('reads all 11 lines in bounded pages from one personal base and fences every proof',async()=>{
 const result=await getLinkedClientOrder(7,'company',guid,new AbortController().signal);
 expect(result).toMatchObject({guid,sourceBaseKey:'company',readOnly:true,itemsCount:11,itemsTruncated:false,sourceTruncated:false});
 expect(result.items).toHaveLength(11);
 expect(userMcpCall).toHaveBeenCalledTimes(5);
 expect(jest.mocked(userMcpCall).mock.calls.every(c=>c[0]===7&&c[1]==='company'&&c[2]!=='get_object')).toBe(true);
 expect(validateOnecProofs).toHaveBeenLastCalledWith(7,Array(5).fill(proof));
 const queries=jest.mocked(userMcpCall).mock.calls.filter(c=>c[2]==='execute_query');
 expect(queries.every(c=>(c[3] as any).parameters.Документ.guid===guid)).toBe(true);
});
test('reports a bounded partial order rather than pretending its rows are complete',async()=>{
 fixture(300);const result=await getLinkedClientOrder(7,'company',guid,new AbortController().signal);
 expect(result.items).toHaveLength(LINKED_ORDER_MAX_ITEMS);expect(result.itemsCount).toBe(300);expect(result.sourceTruncated).toBe(true);
 expect(result.readOnlyReason).toContain('250 из 300');
});
test('an inaccessible or deleted object is never an empty successful order',async()=>{
 const normal=jest.mocked(userMcpCall).getMockImplementation()!;
 jest.mocked(userMcpCall).mockImplementation(async(...args)=>args[2]==='execute_query'&&String((args[3] as any).query).includes('Д.Ссылка КАК reference')?response([]):normal(...args));
 await expect(getLinkedClientOrder(7,'company',guid,new AbortController().signal)).rejects.toMatchObject({code:'ENTITY_NOT_FOUND'});
});
test('rejects mismatched document identity before reading any lines',async()=>{
 const normal=jest.mocked(userMcpCall).getMockImplementation()!;
 jest.mocked(userMcpCall).mockImplementation(async(...args)=>args[2]==='execute_query'&&String((args[3] as any).query).includes('Д.Ссылка КАК reference')?response([{reference:reference('Документ.ЗаказКлиента',other)}]):normal(...args));
 await expect(getLinkedClientOrder(7,'company',guid,new AbortController().signal)).rejects.toMatchObject({code:'ENTITY_RESPONSE_MISMATCH'});
 expect(userMcpCall).toHaveBeenCalledTimes(2);
});
test('fails if the rows change/disappear during paging',async()=>{
 const normal=jest.mocked(userMcpCall).getMockImplementation()!;
 jest.mocked(userMcpCall).mockImplementation(async(...args)=>(args[3] as any).parameters?.ПослеСтроки===10?response([]):normal(...args));
 await expect(getLinkedClientOrder(7,'company',guid,new AbortController().signal)).rejects.toMatchObject({code:'CLIENT_ORDER_CHANGED'});
});
test('revocation at the final fence suppresses the complete response',async()=>{
 jest.mocked(validateOnecProofs).mockRejectedValueOnce(Object.assign(Error(),{code:'ONEC_AUTH_REQUIRED'}));
 await expect(getLinkedClientOrder(7,'company',guid,new AbortController().signal)).rejects.toMatchObject({code:'ONEC_AUTH_REQUIRED'});
});
test('cancellation does not open a personal connection',async()=>{
 const c=new AbortController();c.abort();await expect(getLinkedClientOrder(7,'company',guid,c.signal)).rejects.toThrow();expect(userMcpCall).not.toHaveBeenCalled();
});
