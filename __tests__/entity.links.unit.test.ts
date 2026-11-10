import { buildEntityLink, normalizeEntityTarget, parseEntityLink, type OnecEntityTarget } from '../src/modules/entity-links/entity.contract';
import { onecReferenceValue } from '../src/modules/entity-links/entity.reference';

const target: OnecEntityTarget = {v:1,source:'onec',baseKey:'torg2026',metaType:'Catalogs',name:'Номенклатура',guid:'aaaa1111-bbbb-4111-8111-ccccdddd0001'};
test('a complete source identity round-trips without relying on a cached APP product id', () => {
 const href=buildEntityLink(target);
 expect(href).toBe('leaderproduct://entity/v1/onec/torg2026/Catalogs/%D0%9D%D0%BE%D0%BC%D0%B5%D0%BD%D0%BA%D0%BB%D0%B0%D1%82%D1%83%D1%80%D0%B0/aaaa1111-bbbb-4111-8111-ccccdddd0001');
 expect(parseEntityLink(href)).toEqual(target);
 expect(buildEntityLink({...target,guid:target.guid.toUpperCase()})).toBe(href);
 expect(buildEntityLink({...target,baseKey:'test-2026'})).not.toBe(href);
});
test('APP user id is its own positive integer namespace',()=>{
 const t={v:1,source:'app',kind:'user',id:'121'} as const;
 expect(buildEntityLink(t)).toBe('leaderproduct://entity/v1/user/121');
 expect(parseEntityLink(buildEntityLink(t))).toEqual(t);
 for(const id of ['0','-1','001','1.0','2147483648',target.guid])expect(normalizeEntityTarget({...t,id})).toBeNull();
});
test.each([
 null, [], {v:2,source:'onec'}, {...target,baseKey:'production/../test'}, {...target,baseKey:'base_with_underscore'},
 {...target,metaType:'DataProcessors'}, {...target,name:'Номенклатура;Удалить'}, {...target,name:'Документ.ЗаказКлиента'},
 {...target,guid:'00000000-0000-0000-0000-000000000000'}, {...target,token:'capability'}, {...target,source:'http'},
])('untrusted target shape cannot inject a different route or privilege: %p',value=>expect(normalizeEntityTarget(value)).toBeNull());
test.each([
 'https://entity/v1/user/1','leaderproduct://attacker/v1/user/1','leaderproduct://user:password@entity/v1/user/1',
 'leaderproduct://entity:443/v1/user/1','leaderproduct://entity/v1/user/1?token=secret','leaderproduct://entity/v1/user/1#fragment',
 'leaderproduct://entity/v1/user/1/extra','leaderproduct://entity/v2/user/1','leaderproduct://entity/v1/user/%',
 'leaderproduct://entity/v1/onec/qa/Catalogs/%2e%2e/aaaa1111-bbbb-4111-8111-ccccdddd0001',
 'leaderproduct://entity/v1/user/1\n','leaderproduct://entity\\/v1/user/1',
])('invalid URI never becomes a navigation target: %s',href=>expect(parseEntityLink(href)).toBeNull());
test('references use actual metadata identity, ignoring human type and e1cib URLs',()=>{
 const raw={_objectRef:true,metadata:'Справочник.Номенклатура',type:'Номенклатура',guid:target.guid,presentation:'Товар',navigationLink:'e1cib/data/ignored'};
 expect(onecReferenceValue(raw,'torg2026')).toEqual({label:'Товар',target});
 expect(onecReferenceValue({type:'СправочникСсылка.Номенклатура',value:target.guid,presentation:'Товар'},'torg2026')).toEqual({label:'Товар',target});
 expect(onecReferenceValue({guid:target.guid,presentation:'Товар'},'torg2026')).toBeNull();
 expect(onecReferenceValue({...raw,metadata:'Перечисление.Номенклатура'},'torg2026')).toBeNull();
 expect(onecReferenceValue({...raw,guid:'00000000-0000-0000-0000-000000000000'},'torg2026')).toBeNull();
});

test('APP product GUID remains explicit and cannot be confused with a user id',()=>{
 const product={v:1 as const,source:'app' as const,kind:'product' as const,guid:target.guid};
 expect(buildEntityLink(product)).toBe('leaderproduct://entity/v1/product/'+target.guid);
 expect(parseEntityLink(buildEntityLink(product))).toEqual(product);
 expect(normalizeEntityTarget({...product,id:'121'})).toBeNull();
});
