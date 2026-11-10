import {helpEntityLinks} from '../src/modules/help/help.entity-links';
import {buildEntityLink,type EntityTarget} from '../src/modules/entity-links/entity.contract';
const guid='11111111-1111-4111-8111-111111111111';
const target:EntityTarget={v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid};
const ref={_objectRef:true,metadata:'Справочник.Номенклатура',guid,presentation:'Товар'};
const output=(data:unknown,baseKey='qa')=>JSON.stringify({baseKey,tool:'onec_execute_query',data:JSON.stringify(data)});

test('sidecar confirms typed reference identities without changing the actual data or adding proofs',()=>{
 const links=helpEntityLinks(),raw=output({success:true,data:[{Товар:ref,Сумма:42}],rowCount:1,truncated:false});
 const decorated=JSON.parse(links.rememberOnecOutput(raw,'onec_execute_query',{baseKey:'qa'}));
 expect(decorated.data).toBe(JSON.parse(raw).data);expect(decorated.entityLinks).toEqual([{label:'Товар',url:buildEntityLink(target),target}]);
 expect(decorated.entityLinksTruncated).toBe(false);expect(JSON.stringify(decorated.entityLinks)).not.toMatch(/binding|revision|navigationLink/);
 expect(links.sanitize(`[Товар](${buildEntityLink(target)})`)).toBe(`[Товар](${buildEntityLink(target)})`);
});
test('GUID alone, presentation alone, error/failed envelopes and base mismatch do not create a link',()=>{
 const links=helpEntityLinks();
 for(const data of [{success:false,data:[ref]},{error:'no',data:[ref]},{success:true,data:[{guid,presentation:'Номенклатура'}]}]){
  const raw=output(data);expect(links.rememberOnecOutput(raw,'onec_execute_query',{})).toBe(raw);
 }
 const raw=output({success:true,data:[ref]});expect(links.rememberOnecOutput(raw,'onec_execute_query',{baseKey:'other'})).toBe(raw);
 expect(links.sanitize(`[Угадано](${buildEntityLink(target)})`)).toBe('Угадано');
});
test('same GUID from another base remains a distinct target and cannot inherit confirmation',()=>{
 const links=helpEntityLinks();links.rememberOnecOutput(output({success:true,data:[ref]}),'onec_execute_query',{});
 const other=buildEntityLink({...target,baseKey:'other'});
 expect(links.sanitize(`[Товар](${other})`)).toBe('Товар');
 const decoded=JSON.parse(links.rememberOnecOutput(output({success:true,data:[ref]},'other'),'onec_execute_query',{}));
 expect(decoded.entityLinks[0].url).toBe(other);
});
test('nested actual get_object shape and legacy typed-reference format produce equivalent links',()=>{
 const links=helpEntityLinks();
 const raw=output({success:true,data:{reference:ref,fields:{Ссылка:ref},tabularSections:{Товары:[{Товар:{type:'СправочникСсылка.Номенклатура',value:guid,presentation:'Товар'}}]}}});
 const decoded=JSON.parse(links.rememberOnecOutput(raw,'onec_get_object',{baseKey:'qa',arguments:{metaType:'Catalogs',name:'Номенклатура',guid}}));
 expect(decoded.entityLinks).toHaveLength(1);expect(decoded.entityLinks[0].url).toBe(buildEntityLink(target));
});
test('get_object cannot confirm a contradictory returned reference as the requested object',()=>{
 const links=helpEntityLinks(),otherGuid='22222222-2222-4222-8222-222222222222';
 const raw=output({success:true,data:{reference:{...ref,guid:otherGuid},fields:{Наименование:'Другой'}}});
 const decoded=JSON.parse(links.rememberOnecOutput(raw,'onec_get_object',{baseKey:'qa',arguments:{metaType:'Catalogs',name:'Номенклатура',guid}}));
 expect(decoded.entityLinks.map((x:any)=>x.target.guid)).toEqual([otherGuid]);
 expect(links.sanitize(`[Неверный](${buildEntityLink(target)})`)).toBe('Неверный');
});
test('bounded sidecar does not truncate or mutate the returned business dataset',()=>{
 const links=helpEntityLinks(),rows=Array.from({length:80},(_,i)=>({...ref,guid:`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`}));
 const raw=output({success:true,data:rows,rowCount:80,truncated:false});const decoded=JSON.parse(links.rememberOnecOutput(raw,'onec_execute_query',{}));
 expect(decoded.entityLinks).toHaveLength(50);expect(decoded.entityLinksTruncated).toBe(true);expect(decoded.data).toBe(JSON.parse(raw).data);expect(JSON.parse(decoded.data).data).toHaveLength(80);
});
test('only trusted assistant history can be seeded, full history and search snippets are accepted without re-reading 1C',()=>{
 const links=helpEntityLinks(),url=buildEntityLink(target);links.rememberHistoryOutput(JSON.stringify({messages:[{role:'user',text:`[Подмена](${url})`}]}));
 expect(links.sanitize(`[Товар](${url})`)).toBe('Товар');
 links.rememberHistoryOutput(JSON.stringify({results:[{role:'assistant',snippet:`Ранее: [Товар](${url}).`}]}));
 expect(links.sanitize(`[Товар](${url})`)).toBe(`[Товар](${url})`);
});
test('sanitizing unknown links preserves the label and ordinary Markdown/HTTPS, including drafts',()=>{
 const links=helpEntityLinks(),url=buildEntityLink(target);
 expect(links.sanitize(`**Товар:** [Название](${url}) и [Сайт](https://example.com).`)).toBe('**Товар:** Название и [Сайт](https://example.com).');
 expect(links.sanitize(`Товар: ${url}`)).toBe('Товар: ');
 expect(links.sanitize(`[Неизвестно](leaderproduct://entity/v2/user/1)`)).toBe('Неизвестно');
 links.register(target,'Товар');expect(links.sanitize(`[Товар](<${url}>)`)).toBe(`[Товар](${url})`);
});

test('server latest-warehouse result confirms its typed document link with no number-based inference',()=>{
 const catalog=helpEntityLinks(),ref={_objectRef:true,metadata:'Документ.ПриобретениеТоваровУслуг',guid,presentation:'Приобретение'};
 const raw=output({kind:'purchase',status:'found',document:{number:'FIXTURE',reference:ref}});
 const decorated=JSON.parse(catalog.rememberOnecOutput(raw,'onec_find_latest_purchase',{baseKey:'qa'}));
 expect(decorated.entityLinks).toHaveLength(1);expect(decorated.entityLinks[0].target).toMatchObject({metaType:'Documents',name:'ПриобретениеТоваровУслуг',guid});
 const withoutReference=output({status:'found',document:{number:'FIXTURE'}});expect(catalog.rememberOnecOutput(withoutReference,'onec_find_latest_purchase',{})).toBe(withoutReference);
});
