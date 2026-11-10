import {Prisma} from '@prisma/client';
import prisma from '../../prisma/client';
import {KnowledgeError,knowledgeConfig,SOURCE_FRESH_MS} from '../knowledge/knowledge.config';
import {knowledgeActor,type KnowledgeActor} from '../knowledge/knowledge.service';

type Reader=Prisma.TransactionClient;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)&&!(item instanceof Date)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const changed=()=>new KnowledgeError(409,'HELP_KNOWLEDGE_CHANGED','Материалы или доступ изменились во время подготовки ответа');
const sourceSelect={id:true,key:true,configFingerprint:true,enabled:true,lastErrorCode:true,lastSuccessAt:true} as const;
const documentSelect={id:true,sourceId:true,remoteId:true,path:true,title:true,section:true,etag:true,size:true,mimeType:true,currentRevision:true,publishedRevision:true,publishedAt:true,
  allEmployees:true,allowedUserIds:true,allowedDepartmentIds:true,deletedAt:true,updatedAt:true} as const;
const versionSelect={id:true,documentId:true,revision:true,etag:true,path:true,status:true,sha256:true,errorCode:true,extractor:true,extractedAt:true} as const;
type Source=Prisma.KnowledgeSourceGetPayload<{select:typeof sourceSelect}>;
type Document=Prisma.KnowledgeDocumentGetPayload<{select:typeof documentSelect}>;
type Version=Prisma.KnowledgeVersionGetPayload<{select:typeof versionSelect}>;
type Facts={ids:Set<string>;documents:Map<string,Record<string,unknown>>;versions:Map<string,Record<string,unknown>>};
type Receipt={key:string;configFingerprint:string;actor:string;sourceStates:string;documentIds:string[];documents:string;versionIds:string[];versions:string;published:boolean};
function actorState(actor:KnowledgeActor){return stable({...actor,departmentIds:[...actor.departmentIds].sort((a,b)=>a-b)});}
function sourceStates(sources:Source[]){return stable(sources.map(({lastSuccessAt,...source})=>({...source,fresh:!!lastSuccessAt&&lastSuccessAt.getTime()>Date.now()-SOURCE_FRESH_MS})).sort((a,b)=>a.id.localeCompare(b.id)));}
function documentStates(documents:Document[]){return stable(documents.map(document=>({...document,size:document.size.toString()})).sort((a,b)=>a.id.localeCompare(b.id)));}
function versionStates(versions:Version[]){return stable([...versions].sort((a,b)=>a.id.localeCompare(b.id)));}
/** Only identity/revision/ACL facts are retained, never document text/excerpts. */
function exposedFacts(raw:unknown,pathId?:string):Facts{
  const facts:Facts={ids:new Set(),documents:new Map(),versions:new Map()};let visited=0;
  function walk(value:unknown,parentId?:string,depth=0){
    if(++visited>15000||depth>16)throw changed();
    if(Array.isArray(value)){for(const item of value)walk(item,parentId,depth+1);return;}
    if(!record(value))return;
    let documentId=typeof value.documentId==='string'&&uuid.test(value.documentId)?value.documentId:parentId;
    if(typeof value.id==='string'&&uuid.test(value.id)&&Number.isInteger(value.currentRevision)){
      documentId=value.id;facts.ids.add(documentId);
      const fields=['currentRevision','publishedRevision','section','deletedAt','path','title','allEmployees','allowedUserIds','allowedDepartmentIds','updatedAt'];
      facts.documents.set(documentId,Object.fromEntries(fields.filter(key=>Object.prototype.hasOwnProperty.call(value,key)).map(key=>[key,value[key]])));
    }
    if(typeof value.documentId==='string'&&uuid.test(value.documentId))facts.ids.add(value.documentId);
    const versionId=typeof value.versionId==='string'&&uuid.test(value.versionId)?value.versionId:
      typeof value.id==='string'&&uuid.test(value.id)&&Number.isInteger(value.revision)&&typeof value.status==='string'?value.id:undefined;
    if(versionId){
      const fields=['revision','status','sha256','etag','path','extractedAt'];
      facts.versions.set(versionId,{...(documentId?{documentId}:{}),...Object.fromEntries(fields.filter(key=>Object.prototype.hasOwnProperty.call(value,key)).map(key=>[key,value[key]]))});
    }
    for(const [key,item]of Object.entries(value))if(!['text','excerpt','description','detail'].includes(key))walk(item,documentId,depth+1);
  }
  if(record(raw)&&(raw.error||raw.success===false||raw.ok===false||typeof raw.code==='string'&&typeof raw.message==='string'))return facts;
  const pathContext=pathId&&(Array.isArray(raw)||record(raw)&&['document','versions','version','documentId','currentRevision'].some(key=>Object.prototype.hasOwnProperty.call(raw,key)))?pathId:undefined;
  if(pathContext)facts.ids.add(pathContext);
  walk(raw,pathContext);
  if(facts.ids.size>100||facts.versions.size>400)throw changed();
  return facts;
}
async function lockSources(db:Reader,key:string){await db.$queryRaw`SELECT "id" FROM "KnowledgeSource" WHERE "key"=${key} ORDER BY "id" FOR SHARE`;}
async function lockDocuments(db:Reader,ids:string[]){if(ids.length)await db.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;}
async function lockVersions(db:Reader,ids:string[]){if(ids.length)await db.$queryRaw`SELECT "id" FROM "KnowledgeVersion" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;}
function compareFacts(facts:Facts,documents:Document[],versions:Version[]){
  for(const [id,fields]of facts.documents){const document=documents.find(row=>row.id===id);if(!document||Object.entries(fields).some(([key,value])=>stable(value)!==stable((document as unknown as Record<string,unknown>)[key])))throw changed();}
  for(const [id,fields]of facts.versions){const version=versions.find(row=>row.id===id);if(!version||Object.entries(fields).some(([key,value])=>stable(value)!==stable((version as unknown as Record<string,unknown>)[key])))throw changed();}
}
function publishedValid(documents:Document[],versions:Version[],sources:Source[],fingerprint:string){
  return documents.every(document=>!document.deletedAt&&document.section==='COMPANY'&&document.publishedRevision===document.currentRevision&&
    versions.some(version=>version.documentId===document.id&&version.revision===document.currentRevision&&version.status==='READY')&&
    sources.some(source=>source.id===document.sourceId&&source.enabled&&source.configFingerprint===fingerprint&&source.lastErrorCode===null&&source.lastSuccessAt&&source.lastSuccessAt.getTime()>Date.now()-SOURCE_FRESH_MS));
}
/** Generic knowledge API reads use their normal manager/employee policy. Draft
 * access is not silently reduced to all-employees published company documents. */
export function helpAppApiKnowledgeFence(userId:number){
  const receipts:Receipt[]=[];
  return {
    async capture(path:string,readCallback:()=>Promise<unknown>):Promise<unknown>{
      const pathname=new URL(path,'http://application.invalid').pathname;
      if(!pathname.startsWith('/knowledge/'))return readCallback();
      let config:ReturnType<typeof knowledgeConfig>;
      try{config=knowledgeConfig();}catch(error){if(error instanceof KnowledgeError)return readCallback();throw error;}
      const pathId=/^\/knowledge\/documents\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1]?.toLowerCase();
      const published=pathname==='/knowledge/search'||/^\/knowledge\/documents\/[0-9a-f-]{36}\/published$/i.test(pathname);
      return prisma.$transaction(async db=>{
        // Writers use lockKnowledgeSource(FOR UPDATE) before changing any
        // document/publication. The API callback only performs GET reads.
        await lockSources(db,config.key);
        const sources=await db.knowledgeSource.findMany({where:{key:config.key},select:sourceSelect});
        const raw=await readCallback(),facts=exposedFacts(raw,pathId);
        if(!facts.ids.size)return {raw};
        const actor=await knowledgeActor(userId),ids=[...facts.ids].sort();
        await lockDocuments(db,ids);
        const documents=await db.knowledgeDocument.findMany({where:{id:{in:ids},source:{key:config.key}},select:documentSelect});
        if(documents.length!==ids.length)throw changed();
        const versionFilters:Prisma.KnowledgeVersionWhereInput[]=[...documents.map(document=>({documentId:document.id,revision:{in:[...new Set([document.currentRevision,...(document.publishedRevision===null?[]:[document.publishedRevision])])]}}))];
        if(facts.versions.size)versionFilters.push({id:{in:[...facts.versions.keys()]}});
        const where={documentId:{in:ids},OR:versionFilters};
        const initial=await db.knowledgeVersion.findMany({where,select:versionSelect});
        const versionIds=initial.map(version=>version.id).sort();
        await lockVersions(db,versionIds);
        const versions=await db.knowledgeVersion.findMany({where:{id:{in:versionIds}},select:versionSelect});
        compareFacts(facts,documents,versions);
        if(published&&!publishedValid(documents,versions,sources,config.fingerprint))throw changed();
        const currentActor=await knowledgeActor(userId);if(actorState(actor)!==actorState(currentActor))throw changed();
        const receipt:Receipt={key:config.key,configFingerprint:config.fingerprint,actor:actorState(actor),sourceStates:sourceStates(sources),documentIds:ids,documents:documentStates(documents),versionIds,versions:versionStates(versions),published};
        // Do not retain a receipt if the transaction itself fails to commit.
        return {raw,receipt};
      },{maxWait:5000,timeout:30000}).then(({raw,receipt})=>{
        if(receipt)receipts.push(receipt);
        return raw;
      });
    },
    async validate(db?:Reader):Promise<void>{
      if(!receipts.length)return;
      const verify=async(tx:Reader)=>{
        const config=knowledgeConfig(),actor=actorState(await knowledgeActor(userId));
        for(const receipt of receipts){
          if(config.key!==receipt.key||config.fingerprint!==receipt.configFingerprint||actor!==receipt.actor)throw changed();
          await lockSources(tx,receipt.key);await lockDocuments(tx,receipt.documentIds);await lockVersions(tx,receipt.versionIds);
          const sources=await tx.knowledgeSource.findMany({where:{key:receipt.key},select:sourceSelect});
          const documents=await tx.knowledgeDocument.findMany({where:{id:{in:receipt.documentIds}},select:documentSelect});
          const versions=await tx.knowledgeVersion.findMany({where:{id:{in:receipt.versionIds}},select:versionSelect});
          if(sourceStates(sources)!==receipt.sourceStates||documentStates(documents)!==receipt.documents||versionStates(versions)!==receipt.versions||receipt.published&&!publishedValid(documents,versions,sources,config.fingerprint))throw changed();
        }
      };
      try{if(db)await verify(db);else await prisma.$transaction(verify,{maxWait:5000,timeout:15000});}
      catch(error){if(error instanceof KnowledgeError)throw changed();throw error;}
    },
  };
}
