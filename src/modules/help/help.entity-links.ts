import { buildEntityLink, normalizeEntityTarget, parseEntityLink, type EntityTarget } from '../entity-links/entity.contract';
import { onecReferenceValue } from '../entity-links/entity.reference';

export type HelpEntityLink = { label: string; url: string; target: EntityTarget };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const tokenUrls = /leaderproduct:\/\/[^\s<>"')\]]+/giu;
const inlineLinks = /(?<!!)\[((?:\\.|[^\]\\\r\n])*)\]\(\s*<?(leaderproduct:[^\s)>]*)>?(?:\s+["'][^\r\n]*?["'])?\s*\)/giu;

/** A request-local provenance catalogue. An identity is not an authorization grant:
 * opening any saved link always performs the normal current-user read again. */
export function helpEntityLinks(userId?:number) {
  const allowed = new Set<string>();
  const freshCards = new Map<string,HelpEntityLink>();
  const htmlAllowed = new Set<string>();
  let appLinks:{allows:(url:string)=>boolean}|undefined;
  const bindAppLinks=(links:{allows:(url:string)=>boolean})=>{appLinks=links;};
  function registerHtml(id:string) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return;
    htmlAllowed.add('leaderproduct://help-html/'+id);
  }
  function register(target: EntityTarget, label: string): HelpEntityLink {
    const url = buildEntityLink(target);
    allowed.add(url);
    const link={label:label.slice(0,500),url,target};
    freshCards.set(url,link);
    return link;
  }
  function rememberAssistantText(text: string) {
    for (const token of text.match(tokenUrls) || []) {
      const target = parseEntityLink(token.replace(/[.,;!?]+$/u, ''));
      if (target) allowed.add(buildEntityLink(target));
    }
  }
  function sanitize(text: string) {
    const checked = (url: string) => {
      if(htmlAllowed.has(url)||appLinks?.allows(url))return url;
      const target = parseEntityLink(url);
      const canonical = target && buildEntityLink(target);
      return canonical && allowed.has(canonical) ? canonical : null;
    };
    // Keep ordinary label text if a candidate URL was invented by the model.
    // Other Markdown, HTTPS/mail links and code formatting remain unchanged.
    return text.replace(inlineLinks, (_whole, label: string, url: string) => {
      const canonical = checked(url);
      return canonical ? `[${label}](${canonical})` : label;
    }).replace(tokenUrls, token => {
      const trimmed = token.replace(/[.,;!?]+$/u, '');
      const canonical = checked(trimmed);
      return canonical ? canonical + token.slice(trimmed.length) : '';
    });
  }
  function rememberHistoryOutput(output: string) {
    let data: unknown;
    try { data = JSON.parse(output); } catch { return; }
    if (!object(data) || data.error) return;
    const rows = Array.isArray(data.messages) ? data.messages : Array.isArray(data.results) ? data.results : [];
    for (const row of rows) if (object(row) && row.role === 'assistant') {
      const text = row.text ?? row.snippet;
      if (typeof text === 'string') rememberAssistantText(text);
    }
  }
  function rememberOnecOutput(output: string, tool: string, args: unknown) {
    let wrapper: unknown, data: unknown;
    try { wrapper = JSON.parse(output); } catch { return output; }
    if (!object(wrapper) || wrapper.error || typeof wrapper.baseKey !== 'string' || typeof wrapper.data !== 'string') return output;
    const baseKey = wrapper.baseKey;
    if (object(args) && typeof args.baseKey === 'string' && args.baseKey !== baseKey) return output;
    try { data = JSON.parse(wrapper.data); } catch { return output; }
    if(!object(data))return output;
    if(tool.startsWith('onec_find_latest_')&&data.status==='found'&&object(data.document)){
      const reference=onecReferenceValue(data.document.reference,wrapper.baseKey);
      return reference?JSON.stringify({...wrapper,entityLinks:[register(reference.target,reference.label)],entityLinksTruncated:false}):output;
    }
    if (data.success !== true || !data.data || typeof data.data !== 'object') return output;
    const links = new Map<string, HelpEntityLink>();
    let seen = 0, truncated = false;
    function add(link: {label: string; target: EntityTarget}) {
      const url = buildEntityLink(link.target);
      if (links.has(url)) return;
      if (links.size >= 50) { truncated = true; return; }
      links.set(url, register(link.target, link.label));
    }
    function walk(value: unknown, depth: number) {
      if (++seen > 6000 || depth > 16) { truncated = true; return; }
      const reference = onecReferenceValue(value, baseKey);
      if (reference) { add(reference); return; }
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); }
      else if (object(value)) for (const child of Object.values(value)) walk(child, depth + 1);
    }
    if (tool === 'onec_get_object' && object(args) && object(args.arguments) && object(data.data) && Object.keys(data.data).length) {
      const target = normalizeEntityTarget({v:1,source:'onec',baseKey:wrapper.baseKey,metaType:args.arguments.metaType,name:args.arguments.name,guid:args.arguments.guid});
      if (target) {
        const actual = onecReferenceValue(data.data.reference ?? data.data, baseKey);
        // A contradictory returned identity cannot confirm the requested object.
        if (!actual || buildEntityLink(actual.target) === buildEntityLink(target)) {
          const label = [actual?.label,data.data.presentation, data.data.Представление, data.data.Наименование, data.data.name].find(item=>typeof item==='string'&&item.trim());
          add({target,label:typeof label==='string'?label:target.source==='onec'?target.name:'Объект'});
        }
      }
    }
    walk(data.data, 0);
    return links.size || truncated ? JSON.stringify({...wrapper,entityLinks:[...links.values()],entityLinksTruncated:truncated}) : output;
  }
  async function promoteAppProducts(output:string,signal:AbortSignal){
    if(!userId)return output;
    let data:unknown;try{data=JSON.parse(output);}catch{return output;}
    if(!object(data)||!Array.isArray(data.entityLinks))return output;
    const candidates=data.entityLinks.filter((link):link is HelpEntityLink=>{
      if(!object(link)||typeof link.url!=='string')return false;
      const server=freshCards.get(link.url),target=normalizeEntityTarget(link.target);
      return !!server&&!!target&&buildEntityLink(target)===link.url&&target.source==='onec'&&target.metaType==='Catalogs'&&target.name==='Номенклатура';
    });
    if(!candidates.length)return output;
    const {assertAppStockAccess}=await import('../entity-links/entity.stock-access');
    const {stockProductBaseAllowed}=await import('../entity-links/entity.stock-source');
    const {default:db}=await import('../../prisma/client');
    try{
      await assertAppStockAccess(userId);signal.throwIfAborted();
      const approved=candidates.filter(link=>link.target.source==='onec'&&stockProductBaseAllowed(link.target.baseKey));
      if(!approved.length)return output;
      const rows=await db.product.findMany({where:{guid:{in:approved.map(link=>(link.target as Extract<EntityTarget,{source:'onec'}>).guid)},stocks:{some:{}}},select:{guid:true,name:true},take:50});
      signal.throwIfAborted();await assertAppStockAccess(userId);signal.throwIfAborted();
      const mapped=new Map<string,HelpEntityLink>();
      for(const link of approved){const row=rows.find(row=>link.target.source==='onec'&&row.guid===link.target.guid);if(row)mapped.set(link.url,register({v:1,source:'app',kind:'product',guid:row.guid},row.name));}
      return JSON.stringify({...data,entityLinks:data.entityLinks.map(link=>object(link)&&typeof link.url==='string'?mapped.get(link.url)||link:link)});
    }catch{signal.throwIfAborted();return output;}
  }
  function isConfirmed(url:string):boolean {
    const target=parseEntityLink(url);
    return !!target && buildEntityLink(target)===url && allowed.has(url);
  }
  function singleCardLink(text:string):HelpEntityLink|null {
    const found=new Map<string,HelpEntityLink>();
    for(const token of text.match(tokenUrls)||[]){
      const url=token.replace(/[.,;!?]+$/u,''),link=freshCards.get(url);
      if(link)found.set(url,link);
    }
    const link=found.size===1?[...found.values()][0]:null;
    return link&&(link.target.source==='app'||link.target.metaType==='Catalogs'&&link.target.name==='Номенклатура')?link:null;
  }
  return {bindAppLinks,register,registerHtml,rememberAssistantText,rememberHistoryOutput,rememberOnecOutput,promoteAppProducts,sanitize,isConfirmed,singleCardLink};
}
export type HelpEntityLinks = ReturnType<typeof helpEntityLinks>;

export const helpEntityLinkInstructions = 'Внутренние ссылки на карточки приложения берутся только из серверного requester.profile, entityLinks успешных результатов инструментов или подтверждённых ссылок прежних ответов этого обращения. Используй Markdown [наименование продукции](url), [заказ](url), [имя сотрудника](url) с точным готовым url. Подпись должна соответствовать объекту и быть короткой, до 44 символов; полное наименование видно в карточке. Если сервер вернул ссылку source=app kind=product, используй её для карточки приложения вместо сырой ссылки 1С. Не придумывай GUID, базу, APP id или маршрут, не превращай номер документа в ссылку. Если готовой ссылки нет, обычный текст допустим. Ссылки на карточки не разрешают запись в 1С и не подтверждают свежесть прежних данных. Для поиска профиля сотрудника используй app_search_people, если этот инструмент предоставлен; GUID 1С сотрудника не равен APP user id.';
