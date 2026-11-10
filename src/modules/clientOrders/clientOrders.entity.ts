import { userMcpCall, validateOnecProofs, type OnecProof } from '../onec-personal/service';
import { onecReferenceValue } from '../entity-links/entity.reference';
import { EntityResolveError } from '../entity-links/entity.service';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const PAGE = 10;
export const LINKED_ORDER_MAX_ITEMS = 250;
const headerFields: Record<string, string> = { Номер:'number1c', Дата:'date1c', Проведен:'posted', ПометкаУдаления:'deleted', Контрагент:'counterparty', Партнер:'partner', Организация:'organization', Соглашение:'agreement', Валюта:'currency', СуммаДокумента:'totalAmount', Склад:'warehouse', Статус:'status', Комментарий:'comment', Договор:'contract', ДатаОтгрузки:'deliveryDate', АдресДоставки:'deliveryAddress', ФормаОплаты:'paymentForm', СпособДоставки:'deliveryMethod' };
const itemFields: Record<string, string> = { Номенклатура:'product', Упаковка:'package', КоличествоУпаковок:'packageQuantity', Количество:'quantity', Цена:'price', Сумма:'lineAmount', ПроцентРучнойСкидки:'discountPercent', Отменено:'cancelled' };
const number = (value:unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value:unknown): string | null => typeof value === 'string' ? value.slice(0,2000) : object(value) && typeof value.presentation === 'string' ? value.presentation.slice(0,500) : null;
function rows(result: {text?:string}, paged = false) {
  let payload:unknown;try{payload=JSON.parse(result.text||'')}catch{throw new EntityResolveError('CLIENT_ORDER_RESPONSE_UNSUPPORTED',502)}
  if(!object(payload)||payload.success!==true||!Array.isArray(payload.data)||payload.data.some(row=>!object(row))||payload.truncated===true&&!paged)throw new EntityResolveError('CLIENT_ORDER_RESPONSE_UNSUPPORTED',502);
  return payload.data as Record<string,unknown>[];
}
/** The current MCP metadata contract is tab-indented text. Only server-whitelisted
 * property names ever enter queries; unrecognized formats fail closed. */
function structure(raw:string) {
  const fields=new Set<string>(),goods=new Set<string>();let section='',table='';
  for(const line of raw.split(/\r?\n/)){
    if(['Стандартные реквизиты:','Реквизиты:','Табличные части:'].includes(line.trim())){section=line.trim();continue}
    const tab=/^\tТЧ "([\p{L}_][\p{L}\p{N}_]*)" - /u.exec(line);if(tab){table=tab[1];continue}
    const field=/^\t([\p{L}_][\p{L}\p{N}_]*) - /u.exec(line);
    if(field&&section!=='Табличные части:')fields.add(field[1]);
    const column=/^\t\t([\p{L}_][\p{L}\p{N}_]*) - /u.exec(line);if(column&&section==='Табличные части:'&&table==='Товары')goods.add(column[1]);
  }
  if(!['Ссылка','Номер','Дата'].every(k=>fields.has(k))||!['Номенклатура','Количество','Цена','Сумма'].every(k=>goods.has(k)))throw new EntityResolveError('CLIENT_ORDER_METADATA_UNSUPPORTED',502);
  return {fields,goods};
}

/** A base-qualified link always reads that employee's saved connection in that
 * exact base. It never falls back to the application's other 1C publication. */
export async function getLinkedClientOrder(userId:number,baseKey:string,guid:string,signal:AbortSignal) {
  const proofs:OnecProof[]=[];
  const call=async(tool:string,args:unknown)=>{signal.throwIfAborted();const r=await userMcpCall(userId,baseKey,tool,args,signal);proofs.push(r.proof);signal.throwIfAborted();return r};
  const metadata=await call('get_metadata_structure',{metaType:'Documents',name:'ЗаказКлиента',sections:['fields','tabular_sections'],maxTypesInComposite:0});
  const schema=structure(metadata.text||'');
  const reference={_objectRef:true,metadata:'Документ.ЗаказКлиента',guid};
  const parameters={Документ:reference};
  const projection=(fields:Record<string,string>,available:Set<string>,alias:string)=>Object.entries(fields).filter(([key])=>available.has(key)).map(([key,label])=>`${key==='Комментарий'?`ПОДСТРОКА(${alias}.${key},1,2000)`:`${alias}.${key}`} КАК ${label}`);
  const headers=rows(await call('execute_query',{query:`ВЫБРАТЬ ПЕРВЫЕ 1 Д.Ссылка КАК reference, ${projection(headerFields,schema.fields,'Д').join(', ')} ИЗ Документ.ЗаказКлиента КАК Д ГДЕ Д.Ссылка = &Документ`,parameters,maxRows:1}));
  if(!headers.length)throw new EntityResolveError('ENTITY_NOT_FOUND',404);
  const header=headers[0],identity=onecReferenceValue(header.reference,baseKey);
  if(headers.length!==1||identity?.target.source!=='onec'||identity.target.metaType!=='Documents'||identity.target.name!=='ЗаказКлиента'||identity.target.guid!==guid)throw new EntityResolveError('ENTITY_RESPONSE_MISMATCH',502);
  const countRows=rows(await call('execute_query',{query:'ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК count ИЗ Документ.ЗаказКлиента.Товары КАК Т ГДЕ Т.Ссылка = &Документ',parameters,maxRows:1}));
  const count=number(countRows[0]?.count);
  if(countRows.length!==1||count===null||!Number.isSafeInteger(count)||count<0)throw new EntityResolveError('CLIENT_ORDER_RESPONSE_UNSUPPORTED',502);
  const rawItems:Record<string,unknown>[]=[];let after=0;
  while(rawItems.length<Math.min(count,LINKED_ORDER_MAX_ITEMS)){
    const page=rows(await call('execute_query',{query:`ВЫБРАТЬ ПЕРВЫЕ ${PAGE} Т.НомерСтроки КАК lineNumber, ${projection(itemFields,schema.goods,'Т').join(', ')} ИЗ Документ.ЗаказКлиента.Товары КАК Т ГДЕ Т.Ссылка = &Документ И Т.НомерСтроки > &ПослеСтроки УПОРЯДОЧИТЬ ПО Т.НомерСтроки`,parameters:{...parameters,ПослеСтроки:after},maxRows:PAGE}),true);
    if(!page.length||page.length>PAGE)throw new EntityResolveError('CLIENT_ORDER_CHANGED',409);
    for(const row of page){const index=number(row.lineNumber);if(index===null||!Number.isSafeInteger(index)||index<=after)throw new EntityResolveError('CLIENT_ORDER_CHANGED',409);after=index;rawItems.push(row)}
    if(rawItems.length>count)throw new EntityResolveError('CLIENT_ORDER_CHANGED',409);
  }
  const ref=(value:unknown,expected?:string)=>{
    const r=onecReferenceValue(value,baseKey);
    if(!r)return null;
    if(r.target.source!=='onec'||r.target.metaType!=='Catalogs'||expected&&r.target.name!==expected)throw new EntityResolveError('ENTITY_RESPONSE_MISMATCH',502);
    return {guid:r.target.guid,name:r.label};
  };
  const items=rawItems.map(row=>{
    const product=ref(row.product,'Номенклатура'),pack=ref(row.package),qty=number(row.quantity),packQty=number(row.packageQuantity),price=number(row.price),amount=number(row.lineAmount);
    if(!product||qty===null||price===null||amount===null)throw new EntityResolveError('CLIENT_ORDER_RESPONSE_UNSUPPORTED',502);
    return {lineGuid:null,product,package:pack?{...pack,multiplier:packQty&&packQty>0?qty/packQty:null}:null,quantity:pack&&packQty!==null?packQty:qty,quantityBase:qty,price,lineAmount:amount,discountPercent:number(row.discountPercent),isCancelled:row.cancelled===true};
  });
  const contract=ref(header.contract),counterparty=ref(header.counterparty,'Контрагенты'),partner=ref(header.partner),address=text(header.deliveryAddress),truncated=count>items.length,comment=text(header.comment),commentTruncated=!!comment&&comment.length>=2000;
  const result={guid,documentGuid:guid,appGuid:null,sourceBaseKey:baseKey,source:'ONEC',origin:'onec',readOnly:true,readOnlyReason:truncated?`Показаны первые ${items.length} из ${count} позиций. Заказ открыт для просмотра.`:'Заказ открыт из личной базы 1С только для просмотра.',revision:0,syncState:'SYNCED',status:'READ_ONLY',number1c:text(header.number1c),date1c:text(header.date1c),status1c:text(header.status),isPostedIn1c:header.posted===true,deletionMarked:header.deleted===true,organization:ref(header.organization,'Организации'),counterparty:counterparty||partner,agreement:ref(header.agreement),contract:contract?{...contract,number:contract.name}:null,warehouse:ref(header.warehouse,'Склады'),currency:text(header.currency),totalAmount:number(header.totalAmount),comment,commentTruncated,deliveryDate:text(header.deliveryDate),deliveryAddress:address?{guid:null,fullAddress:address,counterpartyId:counterparty?.guid||''}:null,paymentForm:text(header.paymentForm),deliveryMethod:text(header.deliveryMethod),itemsCount:count,itemsTruncated:truncated,sourceTruncated:truncated||commentTruncated,items,events:[]};
  await validateOnecProofs(userId,proofs);signal.throwIfAborted();return result;
}
