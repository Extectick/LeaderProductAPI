import { GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {Readable} from 'node:stream';
import prisma from '../../prisma/client';
import {entityProductMirrorMatches} from './entity.stock-source';
import {assertAppStockAccess} from './entity.stock-access';
import { buildStoragePrefix, s3 } from '../../storage/minio';
import { onecBase } from '../onec-personal/config';
import { userMcpCall, validateOnecProofs } from '../onec-personal/service';
import { normalizeEntityTarget, type EntityTarget } from './entity.contract';
import { entityCardFromOnec, EntityResolveError } from './entity.service';

export type EntityPreview = {target:EntityTarget;title:string;imageDataUrl?:string};
const MAX_IMAGE_BYTES=2*1024*1024,MAX_THUMB_BYTES=180*1024;
const profileSelect={id:true,isActive:true,deletedAt:true,profileStatus:true,currentProfileType:true,avatarUrl:true,
  firstName:true,lastName:true,middleName:true,role:{select:{name:true}},
  employeeProfile:{select:{id:true,avatarUrl:true}},clientProfile:{select:{avatarUrl:true}},supplierProfile:{select:{avatarUrl:true}},departmentRoles:{select:{id:true},take:1}} as const;
/** Same employee/self policy as GET /users/:userId/profile, with a fresh actor read. */
async function profileAccess(actorId:number,targetId:number) {
  const [actor,target]=await Promise.all([prisma.user.findUnique({where:{id:actorId},select:profileSelect}),prisma.user.findUnique({where:{id:targetId},select:profileSelect})]);
  if(!actor?.isActive||actor.deletedAt||actor.profileStatus==='BLOCKED')throw new EntityResolveError('ENTITY_SESSION_REQUIRED',401);
  const role=String(actor.role?.name||'').trim().toLowerCase().replace(/[\s_-]+/g,'');
  if(actorId!==targetId&&!(['admin','administrator','employee','departmentmanager'].includes(role)||actor.employeeProfile||actor.departmentRoles.length||actor.currentProfileType==='EMPLOYEE'))throw new EntityResolveError('ENTITY_ACCESS_DENIED',403);
  if(!target?.isActive||target.deletedAt||target.profileStatus==='BLOCKED')throw new EntityResolveError('ENTITY_NOT_FOUND',404);
  const avatar=target.currentProfileType==='CLIENT'?target.clientProfile?.avatarUrl:target.currentProfileType==='SUPPLIER'?target.supplierProfile?.avatarUrl:target.currentProfileType==='EMPLOYEE'?target.employeeProfile?.avatarUrl:target.avatarUrl;
  return {title:[target.lastName,target.firstName,target.middleName].filter(Boolean).join(' ').trim()||'Сотрудник',avatar};
}
/** Only configured first-party storage paths are interpreted as keys. Never fetch a stored URL. */
export function entityAvatarStorageKey(value:string|null|undefined):string|null {
  if(!value)return null;
  let key=value;
  // Existing imported profiles retain the historical avatars/ object namespace.
  const avatarKey=(candidate:string)=>candidate.startsWith(buildStoragePrefix('avatars')+'/')||candidate.startsWith('avatars/');
  if(/^https?:/i.test(value)){
    try {
      const url=new URL(value);
      if(url.username||url.password||url.hash)return null;
      const candidates=[process.env.S3_ENDPOINT,process.env.S3_PUBLIC_BASE,process.env.FILES_BASE_URL,process.env.DOMEN_URL].filter(Boolean) as string[];
      let matched=false;
      for(const candidate of candidates){
        const configured=new URL(candidate);
        if(url.origin!==configured.origin)continue;
        const basePath=configured.pathname.replace(/\/+$/,'');
        const prefixes=[basePath+'/',basePath+'/files/'];
        for(const prefix of prefixes)if(url.pathname.startsWith(prefix)){
          let rest=decodeURIComponent(url.pathname.slice(prefix.length));
          if(process.env.S3_BUCKET&&rest.startsWith(process.env.S3_BUCKET+'/'))rest=rest.slice(process.env.S3_BUCKET.length+1);
          if(avatarKey(rest)){key=rest;matched=true;break;}
        }
        if(matched)break;
      }
      if(!matched)return null;
    }catch{return null;}
  }
  return avatarKey(key)&&!/[\\\x00-\x20]/.test(key)&&!key.split('/').some(part=>part==='.'||part==='..')?key:null;
}
/** Synced rows restored into the configured bucket can retain their original
 * dev/prod object namespace. Accept only the exact product's image directory;
 * callers still validate stock/personal access and re-read the same synced row. */
export function entityProductImageStorageKey(value:unknown,guid:string):string|null {
  if(typeof value!=='string'||value.length>2048||!value||/[\\\u0000-\u0020?#]/u.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))return null;
  const roots=new Set([buildStoragePrefix('images'),'dev/images','prod/images']);
  for(const root of roots){
    const prefix=root+'/client-orders/products/'+guid+'/';
    if(value.startsWith(prefix)&&value.length>prefix.length)return value;
  }
  return null;
}
/** The global image mirror has no base key. An equal GUID is insufficient across publications. */
export {entityProductMirrorMatches} from './entity.stock-source';

async function thumbnail(key:string|null,signal:AbortSignal):Promise<string|undefined>{
  if(!key)return;
  try{
    signal.throwIfAborted();
    const storageSignal=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
    const response=await s3.send(new GetObjectCommand({Bucket:process.env.S3_BUCKET!,Key:key,Range:`bytes=0-${MAX_IMAGE_BYTES}`}),{abortSignal:storageSignal});
    const body=response.Body;
    if(!(body instanceof Readable))return;
    const rangeTotal=response.ContentRange?.match(/^bytes [0-9]+-[0-9]+\/([0-9]+)$/)?.[1];
    if(Number(response.ContentLength)>MAX_IMAGE_BYTES||response.ContentRange&&(!rangeTotal||Number(rangeTotal)>MAX_IMAGE_BYTES)){body.destroy();return;}
    const parts:Buffer[]=[];let length=0;
    try{for await(const chunk of body){signal.throwIfAborted();length+=chunk.length;if(length>MAX_IMAGE_BYTES)return;parts.push(Buffer.from(chunk));}}
    finally{body.destroy();}
    const bytes=Buffer.concat(parts),image=sharp(bytes,{limitInputPixels:25_000_000,animated:false});
    const metadata=await image.metadata();
    if(!['jpeg','png','webp'].includes(metadata.format||''))return;
    const result=await image.rotate().resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).webp({quality:78}).toBuffer();
    signal.throwIfAborted();
    if(result.length>MAX_THUMB_BYTES)return;
    return 'data:image/webp;base64,'+result.toString('base64');
  }catch{signal.throwIfAborted();return;}
}
export async function resolveEntityPreview(actorId:number,input:unknown,signal:AbortSignal):Promise<EntityPreview>{
  const target=normalizeEntityTarget(input);
  if(!target)throw new EntityResolveError('ENTITY_INVALID_TARGET',400);
  signal.throwIfAborted();
  if(target.source==='app'&&target.kind==='product'){
    await assertAppStockAccess(actorId);signal.throwIfAborted();
    const product=await prisma.product.findFirst({where:{guid:target.guid,stocks:{some:{}}},select:{guid:true,name:true}});
    if(!product)throw new EntityResolveError('ENTITY_NOT_FOUND',404);
    const row=await prisma.productImage.findFirst({where:{productGuid:target.guid,deletedAt:null,syncState:'SYNCED'},orderBy:[{isMain:'desc'},{syncedAt:'desc'}],select:{id:true,s3KeyThumb:true}});
    const imageKey=entityProductImageStorageKey(row?.s3KeyThumb,target.guid);
    let imageDataUrl=imageKey?await thumbnail(imageKey,signal):undefined;
    if(imageDataUrl&&!await prisma.productImage.findFirst({where:{id:row!.id,productGuid:target.guid,deletedAt:null,syncState:'SYNCED',s3KeyThumb:row!.s3KeyThumb},select:{id:true}}))imageDataUrl=undefined;
    await assertAppStockAccess(actorId);signal.throwIfAborted();
    if(!await prisma.product.findFirst({where:{guid:target.guid,stocks:{some:{}}},select:{guid:true}}))throw new EntityResolveError('ENTITY_NOT_FOUND',404);
    return {target,title:product.name,...(imageDataUrl?{imageDataUrl}:{})};
  }
  if(target.source==='app'){
    const before=await profileAccess(actorId,Number(target.id));signal.throwIfAborted();
    const imageDataUrl=await thumbnail(entityAvatarStorageKey(before.avatar),signal);
    const current=await profileAccess(actorId,Number(target.id));signal.throwIfAborted();
    return {target,title:current.title,...(imageDataUrl&&current.avatar===before.avatar?{imageDataUrl}:{})};
  }
  if(target.metaType!=='Catalogs'||target.name!=='Номенклатура')throw new EntityResolveError('ENTITY_PREVIEW_UNSUPPORTED',400);
  const base=onecBase(target.baseKey);
  const result=await userMcpCall(actorId,target.baseKey,'get_object',{metaType:target.metaType,name:target.name,guid:target.guid,includeTabularSections:false},signal);
  signal.throwIfAborted();
  let payload:unknown;try{payload=JSON.parse(result.text||'');}catch{throw new EntityResolveError('ENTITY_RESPONSE_UNSUPPORTED',502);}
  const card=entityCardFromOnec(target,payload);
  let imageDataUrl:string|undefined;
  if(entityProductMirrorMatches(base.rpcUrl)){
    const row=await prisma.productImage.findFirst({where:{productGuid:target.guid,deletedAt:null,syncState:'SYNCED'},orderBy:[{isMain:'desc'},{syncedAt:'desc'}],select:{id:true,s3KeyThumb:true}});
    const imageKey=entityProductImageStorageKey(row?.s3KeyThumb,target.guid);
    if(row&&imageKey){
      imageDataUrl=await thumbnail(imageKey,signal);
      if(imageDataUrl&&!await prisma.productImage.findFirst({where:{id:row.id,productGuid:target.guid,deletedAt:null,syncState:'SYNCED',s3KeyThumb:row.s3KeyThumb},select:{id:true}}))imageDataUrl=undefined;
    }
  }
  await validateOnecProofs(actorId,[result.proof]);signal.throwIfAborted();
  return {target,title:card.title,...(imageDataUrl?{imageDataUrl}:{})};
}
