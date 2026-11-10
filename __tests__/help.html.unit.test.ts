import {createHelpHtmlArtifact,helpHtmlFile,validateHelpHtmlFile,helpHtmlTools,sanitizeHelpHtmlCss,ensureHelpEntityCard,HELP_HTML_MAX_FILES,validateHelpHtmlFiles} from '../src/modules/help/help.html';
import {helpEntityLinks} from '../src/modules/help/help.entity-links';
import {guardHelpGeneratedAnswer} from '../src/modules/help/help.answer-guard';
const compact={html:'<section><h2>Условный пример</h2><div style="display:flex;gap:8px">120 шт.</div></section>',css:'.bar { display:grid; grid-template-columns: 1fr 2fr; color: #7350da } @media (max-width: 400px) { .bar { gap: 8px } }'};
const input={title:'Остатки',description:'Условные данные: всего 120, резерв 35, свободно 85.',compact};
test('real compact/full file roundtrips exactly and has stable sanitized styles',()=>{
 const artifact=createHelpHtmlArtifact({...input,full:{html:'<p>Подробный пример</p>',css:'p{color:var(--fg,#222)}'}});
 const file=helpHtmlFile(artifact);expect(validateHelpHtmlFile(file)).toEqual(file);
 expect(artifact.compact!.html).toContain('style="display:flex;gap:8px"');expect(file.bytes.length).toBeGreaterThan(100);
});
test('ordinary child combinators are allowed in CSS',()=>expect(sanitizeHelpHtmlCss('.steps > div{display:flex}')).toBe('.steps>div{display:flex}'));
test.each([{}, {...input,compact:undefined}, {...input,compact:{html:'x',css:'@import "https://evil/";'}}, {...input,compact:{html:'<script>x</script>',css:''}}, {...input,description:''}])('reject invalid or empty artifacts %#',value=>expect(()=>createHelpHtmlArtifact(value)).toThrow());
test.each(['a{background:url(https://evil/)}','a{background:u\\72l(https://evil/)}','@font-face{font-family:x;src:url(file:///secret)}','a{background:image-set("https://evil" 1x)}','a{background:expression(alert(1))}','</style><img src=x>','a{color:red; bad syntax}','@unknown{x:1}'])('rejects network/unsafe/unknown CSS: %s',css=>expect(()=>sanitizeHelpHtmlCss(css)).toThrow());
test('removes active HTML/resources/events while preserving explicit browser anchors',()=>{
 const artifact=createHelpHtmlArtifact({...input,compact:{html:'<p onclick="x()">Hello</p><script>evil()</script><iframe src="x">bad</iframe><svg><script>x()</script></svg><img src="https://evil/"><form action="https://evil"><input value="x"></form><a href="https://evil">link</a><a href="#part">section</a>',css:''}});
 expect(artifact.compact!.html).toBe('<p>Hello</p><a href="https://evil/">link</a><a href="#part">section</a>');
});
test.each(['javascript:alert(1)','data:text/html,attack','file:///etc/passwd','//evil.invalid/','https://user:password@evil.invalid/','leaderproduct://entity/v1/user/1','https://evil.invalid\\@company.invalid/'])('website anchors never allow unsafe capabilities: %s',href=>{
 const artifact=createHelpHtmlArtifact({...input,full:{html:`<a href="${href}">Ссылка</a>`,css:''}});
 expect(artifact.full!.html).toBe('<a>Ссылка</a>');
});
test('website links retain a normal query and fragment without enabling resource loads',()=>{
 const artifact=createHelpHtmlArtifact({...input,full:{html:'<a href="https://tass.ru/path?x=1#part" target="_blank" onclick="attack()">Новости</a><img src="https://tass.ru/pixel">',css:''}});
 expect(artifact.full!.html).toBe('<a href="https://tass.ru/path?x=1#part">Новости</a>');
 expect(validateHelpHtmlFile(helpHtmlFile(artifact))).toEqual(helpHtmlFile(artifact));
});
test('fails closed on CSS hidden inside inline attributes',()=>expect(()=>createHelpHtmlArtifact({...input,compact:{html:'<p style="background:u&#114;l(https://evil)">bad</p>',css:''}})).toThrow());
test('publication revalidates bytes instead of trusting rendered-file claims',()=>{
 const file=helpHtmlFile(createHelpHtmlArtifact(input));expect(()=>validateHelpHtmlFile({...file,name:'other.help-html.json'})).toThrow();
 const value=JSON.parse(file.bytes.toString());value.compact.html='<script>attack()</script><p>x</p>';
 expect(()=>validateHelpHtmlFile({...file,bytes:Buffer.from(JSON.stringify(value))})).toThrow();
});
test('tool is idempotent, exposes only valid full links, has bounded count and honors abort',async()=>{
 const tools=helpHtmlTools(),signal=new AbortController().signal;
 const first=JSON.parse(await tools.call('help_create_html',input,signal));expect(first.created).toBe(true);expect(first.url).toBeUndefined();
 expect(JSON.parse(await tools.call('help_create_html',input,signal)).id).toBe(first.id);expect(tools.files).toHaveLength(1);
 const second=JSON.parse(await tools.call('help_create_html',{...input,full:compact},signal));expect(second.url).toBe('leaderproduct://help-html/'+second.id);
 for(let index=2;index<HELP_HTML_MAX_FILES;index++)expect(JSON.parse(await tools.call('help_create_html',{...input,title:'Материал '+index},signal)).created).toBe(true);
 expect(JSON.parse(await tools.call('help_create_html',{...input,title:'Too many'},signal)).error).toBe('HELP_HTML_LIMIT');
 expect(JSON.parse(await tools.call('help_create_html',input,signal)).id).toBe(first.id);expect(tools.files).toHaveLength(HELP_HTML_MAX_FILES);
 await expect(tools.call('help_create_html',input,AbortSignal.abort())).rejects.toThrow();
});
test('invented artifact links remain inert; only tool-proven IDs survive',()=>{
 const links=helpEntityLinks(),artifact=createHelpHtmlArtifact(input),url='leaderproduct://help-html/'+artifact.id;
 links.rememberAssistantText(`[demo](${url})`);expect(links.sanitize(`[demo](${url})`)).toBe('demo');
 links.registerHtml(artifact.id);expect(links.sanitize(`[demo](${url})`)).toBe(`[demo](${url})`);
});
test.each(['Отклю<span>чите</span> антивирус.','Отключите анти<span>вирус</span>.','Отключите &#1072;нтивирус.'])('screens decoded rendered advice across inline tags: %s',html=>{
 const file=helpHtmlFile(createHelpHtmlArtifact({...input,full:{html:'<p>'+html+'</p>',css:''}}));
 const result=guardHelpGeneratedAnswer({decision:'answer',text:'Пример',sources:[],htmlFiles:[file],responseId:'r',model:'fixture',usage:null},[{role:'user',text:'Не работает приложение'}]);
 expect(result.decision).toBe('handoff');expect(result.htmlFiles).toEqual([]);
});

test('entity cards accept only run-confirmed canonical actions and require compact',async()=>{
 const links=helpEntityLinks(),tools=helpHtmlTools(links),signal=new AbortController().signal;
 const url='leaderproduct://entity/v1/user/121';
 const card={...input,entity:{url},compact:{html:'<figure><img src="help-entity-image" alt="Фото"><span>ИИ</span></figure>',css:'img{width:100%;height:100%;object-fit:cover}'}};
 expect(JSON.parse(await tools.call('help_create_html',card,signal)).error).toBe('HELP_HTML_ARGUMENTS');
 links.register({v:1,source:'app',kind:'user',id:'121'},'Имя');
 expect(JSON.parse(await tools.call('help_create_html',card,signal)).created).toBe(true);
 const file=tools.files[0],artifact=JSON.parse(file.bytes.toString());
 expect(artifact.entity).toEqual({url});expect(artifact.compact.html).toContain('src="help-entity-image"');
 expect(validateHelpHtmlFile(file)).toEqual(file);
 expect(()=>createHelpHtmlArtifact({...card,compact:undefined,full:compact})).toThrow();
 expect(()=>createHelpHtmlArtifact({...card,entity:{url:url+'?token=x'}})).toThrow();
});
test('image slots never allow network, embedded payloads, srcset or events',()=>{
 const artifact=createHelpHtmlArtifact({...input,entity:{url:'leaderproduct://entity/v1/user/121'},compact:{html:'<img src="help-entity-image" srcset="https://evil 2x" onerror="x()"><img src="https://evil"><img src="data:image/svg+xml;base64,evil">',css:''}});
 expect(artifact.compact!.html).toBe('<img src="help-entity-image" />');
 expect(validateHelpHtmlFile(helpHtmlFile(artifact))).toBeTruthy();
});
test('a typed product reference confirms a card action without inventing a target',async()=>{
 const links=helpEntityLinks(),tools=helpHtmlTools(links),signal=new AbortController().signal;
 const target={v:1 as const,source:'onec' as const,baseKey:'torg2026',metaType:'Catalogs' as const,name:'Номенклатура',guid:'12345678-1234-4234-8234-123456789012'};
 const url=links.register(target,'Товар').url;
 expect(JSON.parse(await tools.call('help_create_html',{...input,entity:{url}},signal)).created).toBe(true);
 expect(JSON.parse(tools.files[0].bytes.toString()).entity.url).toBe(url);
 const unknown=url.replace('123456789012','123456789013');
 expect(JSON.parse(await tools.call('help_create_html',{...input,entity:{url:unknown}},signal)).error).toBe('HELP_HTML_ARGUMENTS');
});

test('bounds image slots and screens decoded image alternative text',()=>{
 const entity={url:'leaderproduct://entity/v1/user/121'};
 expect(()=>createHelpHtmlArtifact({...input,entity,compact:{html:'<img src="help-entity-image">'.repeat(3),css:''}})).toThrow();
 const file=helpHtmlFile(createHelpHtmlArtifact({...input,entity,compact:{html:'<img src="help-entity-image" alt="Отключите &#1072;нтивирус.">',css:''}}));
 expect(file.reviewText).toContain('Отключите антивирус.');
});

test('short profile replies become real cards using current confirmed names',async()=>{
 const links=helpEntityLinks(),tools=helpHtmlTools(links),signal=new AbortController().signal;
 const link=links.register({v:1,source:'app',kind:'user',id:'7'},'Петров Иван');
 expect(await ensureHelpEntityCard(tools,links,'Ваш профиль: [Другое имя]('+link.url+').','Пришли мой профиль',signal)).toBe(true);
 const card=JSON.parse(tools.files[0].bytes.toString());expect(card.entity).toEqual({url:link.url});expect(card.compact.html).toContain('Петров Иван');expect(card.compact.html).not.toContain('Другое имя');
 expect(validateHelpHtmlFile(tools.files[0])).toBeTruthy();
 expect(await ensureHelpEntityCard(tools,links,'[Профиль]('+link.url+')','Покажи профиль',signal)).toBe(false);expect(tools.files).toHaveLength(1);
});
test('link-only requests, historical identities, ambiguous and long answers stay unchanged',async()=>{
 const signal=new AbortController().signal;
 for(const request of ['Только ссылку на профиль','Просто ссылку','Без карточки, пришли профиль','only a link']){
  const links=helpEntityLinks(),tools=helpHtmlTools(links),link=links.register({v:1,source:'app',kind:'user',id:'7'},'Имя');
  expect(await ensureHelpEntityCard(tools,links,'[Профиль]('+link.url+')',request,signal)).toBe(false);
 }
 const links=helpEntityLinks(),tools=helpHtmlTools(links),url='leaderproduct://entity/v1/user/7';links.rememberAssistantText('[Имя]('+url+')');
 expect(await ensureHelpEntityCard(tools,links,'[Имя]('+url+')','Пришли мой профиль',signal)).toBe(false);
 links.register({v:1,source:'app',kind:'user',id:'7'},'Имя');
 expect(await ensureHelpEntityCard(tools,links,'x'.repeat(601)+' '+url,'Покажи профиль',signal)).toBe(false);
 const other=links.register({v:1,source:'app',kind:'user',id:'8'},'Другой');
 expect(await ensureHelpEntityCard(tools,links,'[Имя]('+url+'), [Другой]('+other.url+')','Покажи профили',signal)).toBe(false);
 expect(tools.files).toHaveLength(0);
});


test('fixed compact sizing stays ordinary safe inline CSS without descriptor version changes',()=>{
 const artifact=createHelpHtmlArtifact({...input,compact:{html:'<section style="height:180px"><p>Card</p></section>',css:''}});
 expect(artifact.compact!.html).toContain('style="height:180px"');
 expect(Object.keys(artifact.compact!)).toEqual(['html','css']);
 expect(validateHelpHtmlFile(helpHtmlFile(artifact))).toBeTruthy();
 expect(()=>createHelpHtmlArtifact({...input,compact:{...compact,height:180}})).toThrow();
});

test('a requested list creates eight independently proven cards in one tool call and retries without duplication',async()=>{
 const links=helpEntityLinks(),tools=helpHtmlTools(links),signal=new AbortController().signal;
 const items=Array.from({length:8},(_,index)=>{const link=links.register({v:1,source:'app',kind:'user',id:String(index+1)},'Профиль '+index);return {...input,title:link.label,entity:{url:link.url},compact:{html:'<section style="height:112px"><img src="help-entity-image" alt="Фото"><p>'+link.label+'</p></section>',css:''}};});
 const first=JSON.parse(await tools.call('help_create_html',{items},signal));
 expect(first).toMatchObject({created:true,count:8,remaining:4});expect(first.items).toHaveLength(8);expect(tools.files).toHaveLength(8);
 expect(JSON.parse(await tools.call('help_create_html',{items},signal))).toEqual(first);expect(tools.files).toHaveLength(8);
 expect(validateHelpHtmlFiles(tools.files)).toHaveLength(8);
 tools.files.forEach((file,index)=>expect(JSON.parse(file.bytes.toString())).toMatchObject({entity:items[index].entity,compact:{html:expect.stringContaining('help-entity-image')}}));
});
test('batch creation is atomic when a later card is unconfirmed or invalid',async()=>{
 const links=helpEntityLinks(),tools=helpHtmlTools(links),signal=new AbortController().signal;
 const good=links.register({v:1,source:'app',kind:'user',id:'1'},'Профиль'),valid={...input,entity:{url:good.url}};
 for(const invalid of [{...input,entity:{url:'leaderproduct://entity/v1/user/999'}},{...input,compact:{html:'<script>invalid</script>',css:''}}]){
  expect(JSON.parse(await tools.call('help_create_html',{items:[valid,invalid]},signal)).error).toBe('HELP_HTML_ARGUMENTS');expect(tools.files).toHaveLength(0);
 }
 expect(JSON.parse(await tools.call('help_create_html',{...input,items:[valid]},signal)).error).toBe('HELP_HTML_ARGUMENTS');expect(tools.files).toHaveLength(0);
});
test('card lists retain the old aggregate byte budget at both creation and publication',async()=>{
 const tools=helpHtmlTools(),signal=new AbortController().signal;
 const large={title:'Большой пример',description:'Условные данные',compact:{html:'<p>'+'я'.repeat(47000)+'</p>',css:''},full:{html:'<p>'+'я'.repeat(47000)+'</p>',css:''}};
 const items=Array.from({length:3},(_,index)=>({...large,title:'Большой пример '+index}));
 expect(JSON.parse(await tools.call('help_create_html',{items},signal)).error).toBe('HELP_HTML_LIMIT');expect(tools.files).toHaveLength(0);
 const files=items.map(item=>helpHtmlFile(createHelpHtmlArtifact(item)));
 expect(()=>validateHelpHtmlFiles(files)).toThrow('HELP_HTML_LIMIT');
 expect(validateHelpHtmlFiles(files.slice(0,2))).toHaveLength(2);
 expect(()=>validateHelpHtmlFiles(Array.from({length:13},()=>helpHtmlFile(createHelpHtmlArtifact(input))))).toThrow('HELP_HTML_LIMIT');
});
