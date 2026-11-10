import { createHash, randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { parse, walk, generate } from 'css-tree';
import { z } from 'zod';
import { Parser } from 'htmlparser2';
import { buildEntityLink, parseEntityLink } from '../entity-links/entity.contract';
import type { HelpEntityLink, HelpEntityLinks } from './help.entity-links';

export const HELP_HTML_MIME = 'application/vnd.leaderproduct.help-html+json';
export const HELP_HTML_MAX_BYTES = 192 * 1024;
/** Keep the former two-maximum-artifacts byte budget while allowing small card lists. */
export const HELP_HTML_MAX_FILES = 12;
export const HELP_HTML_FILES_MAX_BYTES = 2 * HELP_HTML_MAX_BYTES;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const variantSchema = z.object({html:z.string().min(1).max(48000),css:z.string().max(24000)}).strict();
const inputSchema = z.object({title:z.string().trim().min(1).max(160),description:z.string().trim().min(1).max(1200),
  compact:variantSchema.optional(),full:variantSchema.optional(),
  entity:z.object({url:z.string().max(2048).refine(url=>{const target=parseEntityLink(url);return !!target&&buildEntityLink(target)===url;})}).strict().optional()
}).strict().refine(value=>!!(value.compact||value.full)&&(!value.entity||!!value.compact));
export type HelpHtmlArtifact = z.infer<typeof inputSchema> & {version:1;id:string};
export type HelpHtmlFile = {name:string;mimeType:string;kind:'FILE';bytes:Buffer;reviewText:string};
function invalid():never {throw Object.assign(new Error('HELP_HTML_ARGUMENTS'),{code:'HELP_HTML_ARGUMENTS'});}
function limit():never {throw Object.assign(new Error('HELP_HTML_LIMIT'),{code:'HELP_HTML_LIMIT'});}
/** Explicit website anchors are handled by the application's link router;
 * they do not allow network resources, scripts, forms or arbitrary app routes. */
function websiteAnchor(value:string):string|null {
  if(value.length>8192||/[\u0000-\u0020\u007f\\]/u.test(value))return null;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?url.href:null;}catch{return null;}
}

/** Parse CSS before accepting it. Unknown/raw syntax and all resource loads fail closed. */
export function sanitizeHelpHtmlCss(source:string,inline=false):string {
  if(/[<\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source))invalid();
  try {
    const ast=parse(source,{context:inline?'declarationList':'stylesheet',parseCustomProperty:true,onParseError:()=>invalid()});
    let count=0;
    walk(ast,node=>{
      if(++count>16000||node.type==='Raw'||node.type==='Url')invalid();
      if(node.type==='Atrule'&&!['media','supports','container','keyframes','-webkit-keyframes','layer'].includes(node.name.toLowerCase()))invalid();
      if(node.type==='Function'&&['url','expression','image','image-set','-webkit-image-set','paint','element','-moz-element','src'].includes(node.name.toLowerCase()))invalid();
      if(node.type==='Declaration'&&['behavior','-moz-binding'].includes(node.property.toLowerCase()))invalid();
    });
    return generate(ast);
  }catch{invalid();}
}

function variant(value:z.infer<typeof variantSchema>,hasEntity=false):z.infer<typeof variantSchema> {
  const html=sanitizeHtml(value.html,{
    allowedTags:['div','span','p','br','hr','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','small','sub','sup',
      'ul','ol','li','dl','dt','dd','section','article','header','footer','main','aside','nav','figure','figcaption',
      ...(hasEntity?['img']:[]),'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col','pre','code','blockquote','a','details','summary'],
    allowedAttributes:{'*':['id','class','style','title','role','aria-label','aria-hidden'],a:['href'],img:['src','alt','width','height'],td:['colspan','rowspan'],th:['colspan','rowspan','scope'],ol:['start'],col:['span'],details:['open']},
    allowedSchemes:[],allowedSchemesByTag:{a:['http','https']},allowProtocolRelative:false,parseStyleAttributes:false,
    nonTextTags:['script','style','textarea','option','xmp','noscript','iframe','object','embed','svg','math','template'],
    exclusiveFilter:frame=>frame.tag==='img'&&(!hasEntity||frame.attribs.src!=='help-entity-image'),
    transformTags:{'*':(tagName,attributes)=>{
      const attribs={...attributes};
      if(attribs.style)attribs.style=sanitizeHelpHtmlCss(attribs.style,true);
      if(tagName==='a'&&attribs.href&&!/^#[a-z0-9_-]{1,100}$/i.test(attribs.href)){
        const link=websiteAnchor(attribs.href);if(link)attribs.href=link;else delete attribs.href;
      }
      return {tagName,attribs};
    }},
  });
  if(!html.trim()||(html.match(/<img\b/g)||[]).length>2)invalid();
  return {html,css:sanitizeHelpHtmlCss(value.css)};
}

export function createHelpHtmlArtifact(value:unknown,id:string=randomUUID()):HelpHtmlArtifact {
  if(!uuid.test(id))invalid();
  const parsed=inputSchema.parse(value);
  const artifact:HelpHtmlArtifact={version:1,id,title:parsed.title,description:parsed.description,
    ...(parsed.compact?{compact:variant(parsed.compact,!!parsed.entity)}:{}),...(parsed.full?{full:variant(parsed.full,!!parsed.entity)}:{}),...(parsed.entity?{entity:parsed.entity}:{})};
  if(Buffer.byteLength(JSON.stringify(artifact),'utf8')>HELP_HTML_MAX_BYTES)invalid();
  return artifact;
}
export function helpHtmlFile(artifact:HelpHtmlArtifact):HelpHtmlFile {
  const renderedText=(html:string)=>{
    const blocks=new Set(['p','br','hr','div','section','article','li','h1','h2','h3','h4','h5','h6','tr','td','th','pre','blockquote','dt','dd','summary']);
    let text='';
    const parser=new Parser({ontext:value=>{text+=value;},onopentag:(name,attributes)=>{if(blocks.has(name))text+='\n';if(name==='img'&&attributes.alt)text+='\n'+attributes.alt+'\n';},onclosetag:name=>{if(blocks.has(name))text+='\n';}},{decodeEntities:true});
    parser.write(html);parser.end();return text;
  };
  return {name:artifact.id+'.help-html.json',mimeType:HELP_HTML_MIME,kind:'FILE',bytes:Buffer.from(JSON.stringify(artifact),'utf8'),
    reviewText:[artifact.title,artifact.description,...[artifact.compact,artifact.full].flatMap(value=>value?[value.html,renderedText(value.html),value.css]:[])].filter(Boolean).join('\n')};
}
export function validateHelpHtmlFile(file:HelpHtmlFile):HelpHtmlFile {
  if(file.kind!=='FILE'||file.mimeType!==HELP_HTML_MIME||!Buffer.isBuffer(file.bytes)||file.bytes.length>HELP_HTML_MAX_BYTES)invalid();
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes));}catch{invalid();}
  const parsed=z.object({version:z.literal(1),id:z.string(),title:z.unknown(),description:z.unknown(),compact:z.unknown().optional(),full:z.unknown().optional(),entity:z.unknown().optional()}).strict().parse(value);
  const {version,id,...input}=parsed;
  if(file.name!==id+'.help-html.json')invalid();
  const checked=helpHtmlFile(createHelpHtmlArtifact(input,id));
  if(!file.bytes.equals(checked.bytes))invalid();
  return checked;
}

/** Recheck the same aggregate contract immediately before any storage upload. */
export function validateHelpHtmlFiles(files:HelpHtmlFile[]):HelpHtmlFile[] {
  if(files.length>HELP_HTML_MAX_FILES||files.reduce((bytes,file)=>bytes+(Buffer.isBuffer(file.bytes)?file.bytes.length:HELP_HTML_FILES_MAX_BYTES+1),0)>HELP_HTML_FILES_MAX_BYTES)limit();
  const checked=files.map(validateHelpHtmlFile);
  if(new Set(checked.map(file=>file.name)).size!==checked.length)invalid();
  return checked;
}

export const helpHtmlInstructions = 'Ссылки на сайты в HTML можно задавать только абсолютным http/https href без логина/пароля; пользователь откроет их через общий просмотр приложения. Это не разрешает скрипты, загрузку внешних ресурсов или URL в CSS. Когда сотрудник просит прислать или показать профиль/товар, по умолчанию показывай кликабельную compact HTML-карточку с entity и местом для фото, а не только Markdown-ссылку. Просьба выдать только ссылку без карточки имеет приоритет. Если просят список карточек, создай карточку каждого подтверждённого объекта, а не два превью и оставшиеся ссылки. Для списка используй один вызов help_create_html с items:[{title,description,entity,compact},...]; одиночный формат также действует. В одном ответе до12 материалов общим объёмом до384КиБ; это не предел двух карточек. Для более длинного набора честно укажи показанную часть и предложи продолжить. Каждая карточка имеет собственный entity и <img src="help-entity-image" alt="Фото">; не объединяй разные товары в HTML одного entity. Доступен help_create_html для наглядного HTML/CSS прямо в ответе: схемы, диаграммы, пояснения и примеры интерфейса. Используй по просьбе или когда это заметно помогает пониманию, без лишнего согласования. compact — вёрстка по ширине сообщения без внутренней прокрутки. Для фиксированной высоты используй единственный внешний корневой элемент с inline style="height:Npx" от48до1200 CSS-пикселей; согласуй содержимое с этой высотой без прокрутки. Превью не обязано быть квадратным. Без фиксированной px-высоты корневого элемента сохраняется квадратный вид. Не добавляй поля размеров в JSON: формат compact остаётся {html,css}. full — отдельная подробная адаптивная страница. Можно передать один или оба вида; для раскрытия из превью нужны оба. Приложение не добавляет рамку, фон или отступы вокруг HTML; оформление и рамки создавай только если они нужны содержимому. CSS передавай отдельно; HTML — фрагмент без html/head/body/style/script, внешних ресурсов и JavaScript. По умолчанию прозрачный фон, читаемые контрасты, мобильная ширина. description — краткое доступное текстовое описание. После успешного инструмента можно дать Markdown-ссылку с точным возвращённым url; без full ссылки нет. Не выдумывай идентификаторы и ссылки. Материал прикрепляется после проверки доступа и сохранения. Реальные данные бери из разрешённых источников/инструментов; вымышленные примеры явно помечай. Это разрешённая вёрстка, не генерация фото/видео и не запись в 1С. Для кликабельной HTML-карточки профиля или товара добавь entity:{url:точный подтверждённый entityLinks URL} и compact. Нажатие на всё превью откроет существующий просмотр объекта с текущими правами. Для аватарки/фото используй <img src="help-entity-image" alt="Фото">: приложение само получает существующее изображение этого объекта; адрес и байты не выдумывай. Если фото отсутствует, img убирается: предусмотрены инициалы/нейтральный фон или подпись без фото. Другие src, внешние URL и JavaScript запрещены. Можно добавить full как подробный HTML; его раскрытие отдельной кнопкой. Не заменяй реальное фото нарисованным портретом/товаром. При исправлении прежнего материала прочитай его вложение через help_read_attachment и создай новую согласованную версию compact/full.';

export function helpHtmlTools(initialLinks?:HelpEntityLinks) {
  let entityLinks=initialLinks;
  const files:HelpHtmlFile[]=[],completed=new Map<string,HelpHtmlArtifact>();
  const materialProperties={title:{type:'string',maxLength:160},description:{type:'string',maxLength:1200},entity:{type:'object',additionalProperties:false,required:['url'],properties:{url:{type:'string',maxLength:2048,description:'Точный подтверждённый entityLinks url профиля или товара. Всё компактное сообщение откроет этот объект; фото через img src="help-entity-image".'}}},
    ...Object.fromEntries(['compact','full'].map(name=>[name,{type:'object',additionalProperties:false,required:['html','css'],properties:{html:{type:'string',maxLength:48000},css:{type:'string',maxLength:24000}}}]))};
  const summary=(artifact:HelpHtmlArtifact)=>({created:true,id:artifact.id,name:artifact.id+'.help-html.json',title:artifact.title,compact:!!artifact.compact,full:!!artifact.full,
    ...(artifact.full?{url:'leaderproduct://help-html/'+artifact.id}:{}),note:'Материал подготовлен; публикация после сохранения и проверки доступа. Используй только возвращённую ссылку.'});
  return {files,bindEntityLinks:(links:HelpEntityLinks)=>{entityLinks=links;},definitions:[{type:'function',name:'help_create_html',strict:false,
    description:'Создать HTML/CSS-материал или список карточек в текущем ответе. Для одного передай title,description,compact/full,entity; для списка — только items с такими объектами. До12 материалов, до384КиБ суммарно. compact — вид в чате, фиксированная высота inline height:48..1200px на единственном внешнем корне; full — подробная страница; один или оба. Без внешней рамки приложения и отдельного согласия. Данные компании только подтверждённые; условные примеры пометь явно.',
    parameters:{type:'object',additionalProperties:false,properties:{...materialProperties,items:{type:'array',minItems:1,maxItems:HELP_HTML_MAX_FILES,description:'Список отдельных карточек. У каждого объекта собственный подтверждённый entity.url и место для фото help-entity-image. Не передавай одновременно одиночные поля.',items:{type:'object',additionalProperties:false,required:['title','description'],properties:materialProperties}}}}}],
    async call(name:string,args:unknown,signal:AbortSignal):Promise<string>{
      signal.throwIfAborted();
      try {
        if(name!=='help_create_html')invalid();
        const batch=typeof args==='object'&&args!==null&&'items' in args;
        const inputs=batch?z.object({items:z.array(inputSchema).min(1).max(HELP_HTML_MAX_FILES)}).strict().parse(args).items:[inputSchema.parse(args)];
        // Build privately first: a bad later entry or exhausted budget must not
        // publish a successful prefix that the model believes was rejected.
        const pending=new Map<string,HelpHtmlArtifact>();
        const artifacts=inputs.map(checked=>{
          if(checked.entity&&!entityLinks?.isConfirmed(checked.entity.url))invalid();
          const signature=createHash('sha256').update(JSON.stringify(checked)).digest('hex');
          const previous=completed.get(signature)||pending.get(signature);if(previous)return previous;
          const artifact=createHelpHtmlArtifact(checked);pending.set(signature,artifact);return artifact;
        });
        const additions=[...pending.values()].map(helpHtmlFile);
        if(files.length+additions.length>HELP_HTML_MAX_FILES||[...files,...additions].reduce((bytes,file)=>bytes+file.bytes.length,0)>HELP_HTML_FILES_MAX_BYTES)limit();
        signal.throwIfAborted();
        files.push(...additions);for(const [key,artifact] of pending)completed.set(key,artifact);
        const remaining=HELP_HTML_MAX_FILES-files.length;
        return JSON.stringify(batch?{created:true,items:artifacts.map(summary),count:artifacts.length,remaining}:{...summary(artifacts[0]),remaining});
      }catch(error){signal.throwIfAborted();const limited=(error as {code?:string})?.code==='HELP_HTML_LIMIT';return JSON.stringify({error:limited?'HELP_HTML_LIMIT':'HELP_HTML_ARGUMENTS',label:limited?'Лимит текущего ответа: до12 HTML-материалов общим объёмом до384КиБ. Уменьши размер/число карточек; не заявляй о создании непоказанных объектов.':'Проверь HTML/CSS: один материал или items со списком до12 материалов, без внешних ресурсов, скриптов и URL в CSS; entity.url только из подтверждённых entityLinks, для entity нужен compact. Не смешивай одиночные поля и items.'});}
    }};
}
export type HelpHtmlTools=ReturnType<typeof helpHtmlTools>;


/** A short object answer should still be a card if the model chose plain Markdown.
 * Use only current server/tool identities; old dialogue links alone cannot create one. */
export async function ensureHelpEntityCard(tools:HelpHtmlTools|undefined,links:HelpEntityLinks,text:string,request:string,signal:AbortSignal):Promise<boolean>{
  if(!tools||tools.files.length||text.length>600||/(?:только|просто)\s+(?:ссылк|url)|без\s+(?:html|карточ)|(?:only|just)\s+(?:a\s+)?(?:link|url)|no\s+card/iu.test(request))return false;
  const link=links.singleCardLink(text);if(!link)return false;
  const profile=link.target.source==='app'&&link.target.kind==='user',label=link.label.trim()||(profile?'Профиль':'Товар');
  const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const initials=profile?label.split(/\s+/u).slice(0,2).map(part=>[...part][0]||'').join('').toUpperCase():'◇';
  const result=JSON.parse(await tools.call('help_create_html',{title:label.slice(0,160),description:label+'. Нажмите, чтобы открыть '+(profile?'профиль.':'товар.'),entity:{url:link.url},compact:{
    html:'<section class="entity"><div class="photo"><span aria-hidden="true">'+escape(initials)+'</span><img src="help-entity-image" alt="'+(profile?'Аватар профиля':'Изображение товара')+'" /></div><h2>'+escape(label)+'</h2><p>Открыть '+(profile?'профиль':'товар')+' →</p></section>',
    css:'.entity{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:6%;color:inherit}.photo{position:relative;width:44%;aspect-ratio:1;display:grid;place-items:center;background:rgba(127,127,127,.12);border-radius:'+(profile?'50%':'20px')+';overflow:hidden}.photo span{font-size:clamp(30px,12vw,64px);font-weight:600}.photo img{position:absolute;width:100%;height:100%;inset:0;object-fit:cover}.entity h2{margin:0;font-size:clamp(18px,5vw,28px);line-height:1.2;overflow-wrap:anywhere}.entity p{margin:0;font-size:14px;opacity:.65}',
  }},signal));
  return result.created===true;
}
