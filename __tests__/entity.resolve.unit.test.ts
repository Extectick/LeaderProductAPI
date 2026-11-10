jest.mock('../src/modules/onec-personal/service',()=>({userMcpCall:jest.fn(),validateOnecProofs:jest.fn()}));
jest.mock('../src/modules/onec-personal/config',()=>({...jest.requireActual('../src/modules/onec-personal/config'),onecBase:jest.fn(()=>({key:'qa',label:'Личная база'}))}));
import {userMcpCall,validateOnecProofs} from '../src/modules/onec-personal/service';
import {onecBase} from '../src/modules/onec-personal/config';
import {entityCardFromOnec,resolveEntityTarget,ENTITY_TABLE_ROWS} from '../src/modules/entity-links/entity.service';
import type {OnecEntityTarget} from '../src/modules/entity-links/entity.contract';
const guid='aaaa1111-bbbb-4111-8111-ccccdddd0001';
const productGuid='aaaa1111-bbbb-4111-8111-ccccdddd0002';
const target:OnecEntityTarget={v:1,source:'onec',baseKey:'qa',metaType:'Documents',name:'ЗаказКлиента',guid};
const reference=(metadata:string,id:string,presentation='Объект')=>({_objectRef:true,metadata,type:'Человеческое название',guid:id,presentation,navigationLink:'e1cib/data/ignored'});
const payload=()=>({success:true,data:{reference:reference('Документ.ЗаказКлиента',guid,'Заказ клиента № пример'),fields:{Номер:'пример',Проведен:true,Менеджер:reference('Справочник.Пользователи',productGuid,'Сотрудник'),ОбъектРасчетов:reference('Справочник.ОбъектыРасчетов','00000000-0000-0000-0000-000000000000',''),Комментарий:'<script>это текст</script>'},tabularSections:{Товары:[{Номенклатура:reference('Справочник.Номенклатура',productGuid,'Товар'),Количество:2,Цена:123.45,Отменено:false}],Пустая:[]}}});
const signal=()=>new AbortController().signal;
beforeEach(()=>{jest.clearAllMocks();(validateOnecProofs as jest.Mock).mockResolvedValue(undefined);(userMcpCall as jest.Mock).mockResolvedValue({text:JSON.stringify(payload()),proof:{baseKey:'qa',revision:7,binding:'binding'}})});
test('live MCP shape produces a read-only order, typed cells and links preserving the base',()=>{
 const card=entityCardFromOnec(target,payload(),'База');
 expect(card).toMatchObject({target,view:'client-order',title:'Заказ клиента № пример',subtitle:'База',truncated:false});
 expect(card.fields.find(x=>x.key==='Проведен')?.value).toBe(true);
 expect(card.fields.find(x=>x.key==='ОбъектРасчетов')?.value).toBeNull();
 expect(card.tables[0].rows[0]).toMatchObject({Количество:2,Цена:123.45,Отменено:false,Номенклатура:{label:'Товар',target:{...target,metaType:'Catalogs',name:'Номенклатура',guid:productGuid}}});
 expect(card.tables[1].rows).toEqual([]);
 expect(JSON.stringify(card)).not.toContain('e1cib');
});
test('arbitrary supported 1C object kinds have generic rendering instead of guessing an application id',()=>{
 const t={...target,metaType:'BusinessProcesses',name:'Процесс'} as OnecEntityTarget;
 expect(entityCardFromOnec(t,{success:true,data:{fields:{Наименование:'Процесс',Число:1},tabularSections:{}}}).view).toBe('generic');
});
test('credential fields are omitted at every nested level and do not leak via JSON fallback',()=>{
 const value={success:true,data:{fields:{Наименование:'Карточка',Пароль:'secret',Password:'secret',Вложенное:{token:'business-token',accessToken:'secret',secret:'secret',Nested:{RefreshToken:'secret',Поле:'value'}}},tabularSections:{Таблица:[{Товар:'Товар',Password:'secret'}],Секрет:[]}}};
 const text=JSON.stringify(entityCardFromOnec({...target,metaType:'Catalogs',name:'Номенклатура'},value));
 expect(text).not.toContain('secret');expect(text).not.toContain('Password');expect(text).not.toContain('accessToken');expect(text).toContain('value');
});
test('a bounded representation is always marked partial',()=>{
 const p=payload();p.data.tabularSections.Товары=Array.from({length:ENTITY_TABLE_ROWS},()=>p.data.tabularSections.Товары[0]);
 const c=entityCardFromOnec(target,p);expect(c.truncated).toBe(true);expect(c.tables[0].truncated).toBe(true);
 const long=payload();long.data.fields.Комментарий='x'.repeat(9000);expect(entityCardFromOnec(target,long).truncated).toBe(true);
});
test.each([null,{},{success:false},{success:true,data:null},{success:true,data:{}},{success:true,data:{fields:{}}},{success:true,data:{fields:{},tabularSections:[]}}, {success:true,data:{fields:{},tabularSections:{Товары:[null]}}}])('unknown or failed upstream data is never an empty successful card: %p',value=>{
 expect(()=>entityCardFromOnec(target,value)).toThrow('ENTITY_RESPONSE_UNSUPPORTED');
});
test('not-found and a different returned identity are explicit errors',()=>{
 expect(()=>entityCardFromOnec(target,{success:false,error:{code:'OBJECT_NOT_FOUND'}})).toThrow('ENTITY_NOT_FOUND');
 const p=payload();p.data.reference.guid=productGuid;expect(()=>entityCardFromOnec(target,p)).toThrow('ENTITY_RESPONSE_MISMATCH');
});
test('resolving uses the requesting employee own connection and revalidates its revision before disclosure',async()=>{
 const abort=signal();const c=await resolveEntityTarget(77,target,abort);
 expect(userMcpCall).toHaveBeenCalledWith(77,'qa','get_object',{metaType:'Documents',name:'ЗаказКлиента',guid,includeTabularSections:true,maxTabularRows:100},abort);
 expect(validateOnecProofs).toHaveBeenCalledWith(77,[{baseKey:'qa',revision:7,binding:'binding'}]);expect(c.view).toBe('client-order');
});
test('a revoked personal connection prevents returning a card already read',async()=>{
 (validateOnecProofs as jest.Mock).mockRejectedValue(new Error('ONEC_AUTH_REQUIRED'));
 await expect(resolveEntityTarget(77,target,signal())).rejects.toThrow('ONEC_AUTH_REQUIRED');
});
test('larger views preserve partial flags against their own requested row bound',async()=>{
 const p=payload();p.data.tabularSections.Товары=Array.from({length:250},()=>p.data.tabularSections.Товары[0]);
 expect(entityCardFromOnec(target,p,undefined,250).tables[0].truncated).toBe(true);
 expect(entityCardFromOnec(target,p,undefined,1000).tables[0].truncated).toBe(false);
 (userMcpCall as jest.Mock).mockResolvedValue({text:JSON.stringify(p),proof:{baseKey:'qa',revision:7,binding:'binding'}});
 const c=await resolveEntityTarget(77,target,signal(),1000);expect(c.tables[0].rows).toHaveLength(250);
 expect(userMcpCall).toHaveBeenCalledWith(77,'qa','get_object',expect.objectContaining({maxTabularRows:1000}),expect.any(AbortSignal));
});
test('aborted or invalid requests never read 1C',async()=>{
 const a=new AbortController();a.abort();await expect(resolveEntityTarget(77,target,a.signal)).rejects.toThrow();
 await expect(resolveEntityTarget(77,{...target,baseKey:'bad/base'},signal())).rejects.toThrow('ENTITY_INVALID_TARGET');
 await expect(resolveEntityTarget(77,{v:1,source:'app',kind:'user',id:'77'},signal())).rejects.toThrow('ENTITY_PROFILE_USE_EXISTING');
 expect(userMcpCall).not.toHaveBeenCalled();expect(onecBase).not.toHaveBeenCalled();
});
