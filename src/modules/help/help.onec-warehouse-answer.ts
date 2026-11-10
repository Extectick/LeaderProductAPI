import { z } from 'zod';
import type { HelpAIQuestion } from './help.questions';
import {buildEntityLink} from '../entity-links/entity.contract';
import {onecReferenceValue} from '../entity-links/entity.reference';
const period = z.object({startDate:z.string().optional(),endDate:z.string().optional()});
const common = {kind:z.enum(['purchase','receipt','order']),period};
const resultSchema=z.discriminatedUnion('status',[
 z.object({...common,status:z.literal('found'),warehouse:z.string().min(1).max(200),document:z.object({number:z.string().max(100),date:z.string().regex(/^\d{4}-\d{2}-\d{2}T/),posted:z.literal(true),reference:z.unknown().optional()})}),
 z.object({...common,status:z.literal('not_found'),warehouse:z.string().min(1).max(200)}),
 z.object({...common,status:z.literal('choose_warehouse'),warehouses:z.array(z.string().min(1).max(200)).min(2).max(10),moreMatches:z.boolean()}),
 z.object({...common,status:z.literal('warehouse_not_found')}),
 z.object({...common,status:z.literal('metadata_unavailable')}),
]);
const date=(value:string)=>value.slice(0,10).split('-').reverse().join('.');
/** Factual business replies come from the validated personal result, never a second guess by the model. */
export function warehouseDocumentAnswer(value:unknown,baseKey?:string): {decision:'answer'|'clarify'|'handoff';text:string;questions:HelpAIQuestion[];suggestions:string[]}|undefined {
 const parsed=resultSchema.safeParse(value);if(!parsed.success)return;
 const r=parsed.data,kind=r.kind==='purchase'?'приобретение':r.kind==='receipt'?'поступление':'приходный ордер';
 const intro=r.kind==='order'?'Последний доступный проведённый приходный ордер':`Последнее доступное проведённое ${kind}`;
 const plural=r.kind==='purchase'?'приобретений':r.kind==='receipt'?'поступлений':'приходных ордеров';
 const range=r.period.startDate&&r.period.endDate?` за период ${date(r.period.startDate)}–${date(r.period.endDate)} включительно`:r.period.startDate?` с ${date(r.period.startDate)}`:r.period.endDate?` по ${date(r.period.endDate)} включительно`:'';
 if(r.status==='metadata_unavailable')return {decision:'handoff',text:'Не удалось подтвердить подходящий вид документа и его поля в доступных метаданных 1С. Для продолжения нужна помощь IT.',questions:[],suggestions:[]};
 if(r.status==='found'){
  const label=`№ ${r.document.number} от ${date(r.document.date)}`;
  const ref=baseKey?onecReferenceValue(r.document.reference,baseKey):null;
  const document=ref?`[${label.replace(/[\\[\]]/g,'\\$&')}](${buildEntityLink(ref.target)})`:label;
  return {decision:'answer',text:`**${intro}${range}**\nДокумент: ${document}.\nСклад: «${r.warehouse}».`,questions:[],suggestions:[]};
 }
 if(r.status==='not_found')return {decision:'answer',text:`По складу «${r.warehouse}»${range} доступных проведённых ${plural} не найдено. Проверка выполнена успешно.`,questions:[],suggestions:[]};
 if(r.status==='warehouse_not_found')return {decision:'clarify',text:'Склад с таким названием в доступных данных не найден. Как он называется в 1С?',questions:[{id:'warehouse',header:'Склад',question:'Укажите название или другой фрагмент названия склада.',options:[],multiSelect:false}],suggestions:[]};
 const options=r.warehouses.filter(n=>n.length<=120).slice(0,4).map(label=>({label,description:''}));
 return {decision:'clarify',text:`Найдено несколько подходящих складов. Выберите склад для поиска документа${range}:\n`+r.warehouses.map(n=>'• '+n).join('\n')+(r.moreMatches?'\nЕсть и другие совпадения — можно уточнить название.':''),questions:[{id:'warehouse',header:'Выбор склада',question:`На каком складе искать ${r.kind==='order'?'последний приходный ордер':'последнее '+kind}?`,options,multiSelect:false}],suggestions:[]};
}

/** Convert accidental form-field markers to readable fallback text, without touching ordinary answers. */
export function readableClarification(text:string, questions:HelpAIQuestion[] = []) {
 if(questions.length && /(?:_HEADER:|Question:|Options:|multiSelect:|"label"\s*:)/iu.test(text)) return 'Ответьте, пожалуйста, на вопросы:\n\n'+questions.map((q,i)=>`${i+1}. ${q.question}`+(q.options.length?'\n'+q.options.map(o=>'• '+o.label).join('\n'):'')+(q.multiSelect?'\nМожно выбрать несколько вариантов.':'')).join('\n\n');
 return text.replace(/^[ \t]*Options:\s*\[\s*\]\s*,?\s*multiSelect:\s*false[ \t]*$/gim,'Ответьте своими словами.')
  .replace(/^[ \t]*Options:\s*/gim,'Варианты: ')
  .replace(/multiSelect:\s*true\b/gi,'Можно выбрать несколько вариантов.')
  .replace(/multiSelect:\s*false\b/gi,'Выберите один вариант.');
}
