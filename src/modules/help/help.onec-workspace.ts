import prisma from '../../prisma/client';
import {readToolSchemas} from '../onec-personal/mcp';
import type {HelpOnecTools} from './help.onec-tools';

type Reference={baseKey:string;metaType:string;name:string};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const decoded=(v:unknown)=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return null;}};

/** Saved evidence supplies only selectors. Never replay historical data or rights.
 * Every restored structure is read again using the current personal connection. */
export function previousMetadataReferences(contexts:unknown[],bases:ReadonlyArray<{key:string}>):Reference[]{
  const allowed=new Set(bases.map(b=>b.key)),refs=new Map<string,Reference>();
  const add=(baseKey:unknown,metaType:unknown,name:unknown)=>{
    if(typeof baseKey!=='string'||!allowed.has(baseKey))return;
    const parsed=readToolSchemas.get_metadata_structure.safeParse({metaType,name});
    if(!parsed.success)return;
    const ref={baseKey,metaType:parsed.data.metaType,name:parsed.data.name};
    const key=JSON.stringify(ref);if(!refs.has(key)&&refs.size<32)refs.set(key,ref);
  };
  for(const context of contexts){
    if(!object(context)||!object(context.helpAnalysisEvidence))continue;
    const calls=context.helpAnalysisEvidence.calls;
    if(!Array.isArray(calls))continue;
    for(const call of [...calls].reverse()){
      if(!object(call)||call.status!=='returned'||call.errorCode||!object(call.args))continue;
      const args=call.args,body=object(call.result)?decoded(call.result.data):null;
      if(call.toolName==='onec_get_metadata_structure'&&object(args.arguments))add(args.baseKey,args.arguments.metaType,args.arguments.name);
      if(['onec_inspect_metadata','onec_recall_metadata'].includes(call.toolName)&&object(body)&&Array.isArray(body.objects))
        for(const item of body.objects)if(object(item))add(args.baseKey,item.metaType||body.metaType,item.name);
    }
  }
  return [...refs.values()];
}

export function withHelpOnecWorkspace(tools:HelpOnecTools,references:Reference[]):HelpOnecTools{
  const toolName='onec_recall_metadata';
  return {...tools,definitions:[...tools.definitions,{
    type:'function',name:toolName,strict:false,
    description:'Восстановить изученные в этом обращении структуры 1С одним вызовом. Сервер заново проверяет поля через текущее личное подключение. Используй при продолжении задачи вместо повторного поиска уже найденных объектов. Возвращает только метаданные; деловые строки нужно читать отдельно.',
    parameters:{type:'object',additionalProperties:false,required:['baseKey'],properties:{baseKey:{type:'string',enum:tools.bases.map(b=>b.key)},offset:{type:'integer',minimum:0,maximum:31}}},
  }],async call(name,args,signal){
    if(name!==toolName)return tools.call(name,args,signal);
    if(!object(args)||Object.keys(args).some(k=>!['baseKey','offset'].includes(k))||!tools.bases.some(b=>b.key===args.baseKey)||
      args.offset!==undefined&&(!Number.isInteger(args.offset)||args.offset<0||args.offset>31))return JSON.stringify({error:'ONEC_TOOL_ARGUMENTS'});
    const all=references.filter(ref=>ref.baseKey===args.baseKey),offset=args.offset||0;
    const objects:Array<Reference&{structure:string;structureTruncated:boolean}>=[],unavailable:Array<{name:string;error:string}>=[];
    let chars=0,visited=0;
    for(const ref of all.slice(offset,offset+8)){
      signal.throwIfAborted();
      const result=JSON.parse(await tools.call('onec_get_metadata_structure',{baseKey:ref.baseKey,arguments:{metaType:ref.metaType,name:ref.name}},signal));
      signal.throwIfAborted();visited++;
      if(result.error||typeof result.data!=='string'){unavailable.push({name:ref.name,error:result.error||'ONEC_PROTOCOL_ERROR'});continue;}
      const structure=result.data.slice(0,Math.min(8000,24000-chars));chars+=structure.length;
      objects.push({...ref,structure,structureTruncated:structure.length<result.data.length});
      if(chars>=24000)break;
    }
    await tools.validate();signal.throwIfAborted();
    return JSON.stringify({baseKey:args.baseKey,tool:toolName,data:JSON.stringify({objects,unavailable,refreshed:true,
      nextOffset:offset+visited<all.length?offset+visited:null,totalObjects:all.length})});
  }};
}

export async function helpOnecWorkspace(ticketId:number,ownerId:number,throughSequence:number,tools:HelpOnecTools,signal:AbortSignal){
  signal.throwIfAborted();
  const jobs=await prisma.helpAssistantJob.findMany({where:{ticketId,ownerId,provider:'openai',status:'COMPLETED',
    message:{sequence:{lt:throughSequence}}},orderBy:{createdAt:'desc'},take:8,select:{context:true}});
  signal.throwIfAborted();
  const refs=previousMetadataReferences(jobs.map(j=>j.context),tools.bases);
  return {tools:refs.length?withHelpOnecWorkspace(tools,refs):tools,
    context:refs.length?{previousMetadataAvailable:true,note:'В этом обращении уже изучались структуры 1С. onec_recall_metadata восстанавливает их актуальные поля одним вызовом под текущими личными правами. Это не результат чтения деловых данных.'}:undefined};
}
