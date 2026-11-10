import type {HelpHtmlArtifact} from './help.html';
type HelpHtmlVariant={html:string;css:string};
const HELP_HTML_COMPACT_HEIGHT_MIN=48,HELP_HTML_COMPACT_HEIGHT_MAX=1200;
/** Fixed CSS sizing is deliberately narrow: one outer element and simple root
 * selectors only, never child/media sizing, DOM measurements or JavaScript. */
export function helpHtmlCompactHeight(value:HelpHtmlVariant|undefined):number|undefined {
 if(!value)return;
 const bounded=(height:number)=>Number.isFinite(height)&&height>=HELP_HTML_COMPACT_HEIGHT_MIN&&height<=HELP_HTML_COMPACT_HEIGHT_MAX?height:undefined;
 const html=value.html.trim();
 const root=html.match(/^<([a-z][a-z0-9]*)\b([^>]*)>/i);
 if(!root||/\b(?:img|br|hr|col)\b/i.test(root[1]))return;
 // Balance passive tags so adjacent siblings cannot borrow the first child's height.
 const stack:string[]=[];let complete=-1;
 const tags=/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;let tag:RegExpExecArray|null;
 while((tag=tags.exec(html))){
  const name=tag[1].toLowerCase();
  if(tag[0].startsWith('</')){if(stack.pop()!==name)return;}
  else if(!['br','hr','img','col'].includes(name)&&!tag[0].endsWith('/>'))stack.push(name);
  if(!stack.length){complete=tags.lastIndex;break;}
 }
 if(complete<0||html.slice(complete).trim())return;
 const declaration=(style:string):{present:boolean;height?:number;important?:boolean}=>{
  let result:{present:boolean;height?:number;important?:boolean}={present:false};
  for(const item of style.split(';')){
   const match=item.match(/^\s*height\s*:\s*(.*?)\s*$/i);if(!match)continue;
   const fixed=match[1].match(/^(\d+(?:\.\d+)?)px(?:\s*!important)?$/i);
   const important=/!important$/i.test(match[1]);
   if(result.important&&!important)continue;
   result={present:true,important,...(fixed?{height:bounded(Number(fixed[1]))}:{})};
  }
  return result;
 };
 const attrs=root[2],inline=attrs.match(/(?:^|\s)style\s*=\s*(["'])(.*?)\1/is);
 const inlineHeight=inline?declaration(inline[2]):undefined;
 const css=value.css.replace(/\/\*[\s\S]*?\*\//g,'');
 // Conditional/cascade layers need a browser's layout engine: retain legacy fallback.
 if(/[@{}]/.test(css.replace(/[^{}]*\{[^{}]*\}/g,''))||css.includes('@'))return inlineHeight?.important?inlineHeight.height:undefined;
 const id=attrs.match(/(?:^|\s)id\s*=\s*(["'])(.*?)\1/is)?.[2];
 const classes=attrs.match(/(?:^|\s)class\s*=\s*(["'])(.*?)\1/is)?.[2].split(/\s+/)||[];
 const selectors=new Set([root[1].toLowerCase(),...(id&&/^[a-z_][\w-]*$/i.test(id)?['#'+id]:[]),...classes.filter(name=>/^[a-z_][\w-]*$/i.test(name)).map(name=>'.'+name)]);
 let height:number|undefined,specificity=-1,important=false;
 const rules=/([^{}]+)\{([^{}]*)\}/g;let rule:RegExpExecArray|null;
 while((rule=rules.exec(css))){
  const matches=rule[1].split(',').map(selector=>selector.trim()).filter(selector=>selectors.has(selector));
  if(!matches.length)continue;
  const result=declaration(rule[2]);if(!result.present)continue;
  const score=Math.max(...matches.map(selector=>selector.startsWith('#')?100:selector.startsWith('.')?10:1));
  const nextImportant=result.important===true;
  if((important&&!nextImportant)||important===nextImportant&&score<specificity)continue;
  height=result.height;specificity=score;important=nextImportant;
 }
 if(inlineHeight?.present&&(inlineHeight.important||!important))return inlineHeight.height;
 return height;
}

/** Geometry is persisted with the attachment before it becomes visible. */
export function helpHtmlAttachmentGeometry(artifact:HelpHtmlArtifact):{width:number|null;height:number}{
 if(!artifact.compact)return {width:null,height:48};
 const height=helpHtmlCompactHeight(artifact.compact);
 // Attachment dimensions are Prisma Int. Round up so fractional CSS pixels
 // cannot clip the content or reject the final publication transaction.
 return height===undefined?{width:1,height:1}:{width:null,height:Math.ceil(height)};
}
