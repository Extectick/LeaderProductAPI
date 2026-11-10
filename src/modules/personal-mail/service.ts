import {createHash,randomUUID} from 'node:crypto';
import {GetObjectCommand} from '@aws-sdk/client-s3';
import prisma from '../../prisma/client';
import {helpActor,requireHelpTicket} from '../help/help.service';
import {helpS3,helpBucket,helpStorageRequest} from '../help/help.storage';
import {draftSchema,mailProviders,PersonalMailError,type MailProvider,type MailDraftInput} from './contract';
import {sealMail,unsealMail} from './vault';
import {mailTransport} from './smtp';
type Connection={userId:number;provider:MailProvider;email:string;passwordCipher:string|null;verifiedAt:Date|null;revision:number;attempts:number;attemptWindow:Date};
type AttachmentProof={id:string;name:string;size:number;sha256:string;objectKey:string;mimeType:string};
type Draft={id:string;ownerId:number;ticketId:number;provider:MailProvider;connectionRevision:number;sender:string;payload:MailDraftInput&{attachmentProofs:AttachmentProof[]};contentHash:string;status:'DRAFT'|'SENDING'|'SENT'|'UNKNOWN'|'FAILED';createdAt:Date;attemptedAt:Date|null;sentAt:Date|null;messageId:string|null};
export async function mailActor(userId:number){const user=await prisma.user.findUnique({where:{id:userId},select:{isActive:true,deletedAt:true,profileStatus:true,employeeProfile:{select:{status:true}}}});if(!user?.isActive||user.deletedAt||user.profileStatus==='BLOCKED'||!user.employeeProfile||user.employeeProfile.status==='BLOCKED')throw new PersonalMailError('MAIL_FORBIDDEN',403);}
async function connection(userId:number,provider:MailProvider){const rows=await prisma.$queryRaw<Connection[]>`SELECT * FROM "PersonalMailConnection" WHERE "userId"=${userId} AND "provider"=${provider}`;return rows[0];}
function view(row:Connection){return {provider:row.provider,label:mailProviders[row.provider].label,email:row.email,connected:!!row.passwordCipher&&!!row.verifiedAt,verifiedAt:row.verifiedAt?.toISOString()||null};}
export async function listMailConnections(userId:number){await mailActor(userId);const rows=await prisma.$queryRaw<Connection[]>`SELECT * FROM "PersonalMailConnection" WHERE "userId"=${userId} AND "passwordCipher" IS NOT NULL ORDER BY "provider"`;return rows.map(view);}
export async function connectMail(userId:number,provider:MailProvider,email:string,password:string){
 await mailActor(userId);sealMail('',userId,provider); // Fail before authenticating if durable secret storage is unavailable.
 const reserved=await prisma.$transaction(async db=>{await db.$executeRaw`SELECT pg_advisory_xact_lock(190155,${userId}::int)`;await db.$executeRaw`INSERT INTO "PersonalMailConnection" ("userId","provider") VALUES (${userId},${provider}) ON CONFLICT DO NOTHING`;
 const [row]=await db.$queryRaw<Connection[]>`SELECT * FROM "PersonalMailConnection" WHERE "userId"=${userId} AND "provider"=${provider}`;
 const current=Date.now()-row.attemptWindow.getTime()<900000;if(current&&row.attempts>=5)throw new PersonalMailError('MAIL_RATE_LIMIT',429);
 await db.$executeRaw`UPDATE "PersonalMailConnection" SET "revision"="revision"+1,"attempts"=${current?row.attempts+1:1},"attemptWindow"=${current?row.attemptWindow:new Date()} WHERE "userId"=${userId} AND "provider"=${provider}`;return row.revision+1;});
 const transport=mailTransport(provider,email,password);
 try{await transport.verify();}catch(error){throw new PersonalMailError((error as {code?:string}).code==='EAUTH'?'MAIL_AUTH_FAILED':'MAIL_UNAVAILABLE',422);}finally{transport.close();}
 await mailActor(userId);const cipher=sealMail(password,userId,provider);
 const updated=await prisma.$executeRaw`UPDATE "PersonalMailConnection" SET "email"=${email},"passwordCipher"=${cipher},"verifiedAt"=now(),"revision"="revision"+1 WHERE "userId"=${userId} AND "provider"=${provider} AND "revision"=${reserved}`;
 if(updated!==1)throw new PersonalMailError('MAIL_CHANGED',409);return view((await connection(userId,provider))!);
}
export async function disconnectMail(userId:number,provider:MailProvider){await mailActor(userId);await prisma.$executeRaw`UPDATE "PersonalMailConnection" SET "passwordCipher"=NULL,"verifiedAt"=NULL,"revision"="revision"+1 WHERE "userId"=${userId} AND "provider"=${provider}`;return {provider,connected:false};}
async function ticketAccess(userId:number,ticketId:number){await mailActor(userId);const ticket=await requireHelpTicket(prisma,ticketId,await helpActor(userId));if(ticket.ownerId!==userId)throw new PersonalMailError('MAIL_FORBIDDEN',403);return ticket;}
async function attachments(userId:number,ticketId:number,ids:string[],load=false,proofs?:AttachmentProof[]){
 const rows=await prisma.helpAttachment.findMany({where:{id:{in:ids},message:{ticketId}},select:{id:true,name:true,mimeType:true,size:true,sha256:true,objectKey:true}});
 if(rows.length!==new Set(ids).size||rows.some(row=>row.size>10*1024*1024)||rows.reduce((sum,row)=>sum+row.size,0)>15*1024*1024)throw new PersonalMailError('MAIL_ATTACHMENT_UNAVAILABLE',409);
 const descriptors=rows.map(row=>({id:row.id,name:row.name,size:row.size,sha256:row.sha256,objectKey:row.objectKey,mimeType:row.mimeType})).sort((a,b)=>a.id.localeCompare(b.id));
 const canonical=(items:AttachmentProof[])=>JSON.stringify(items.map(item=>[item.id,item.name,item.size,item.sha256,item.objectKey,item.mimeType]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
 if(proofs&&canonical(descriptors)!==canonical(proofs))throw new PersonalMailError('MAIL_ATTACHMENT_UNAVAILABLE',409);
 if(!load)return descriptors;
 const files=[];for(const row of rows){await ticketAccess(userId,ticketId);const result=await helpStorageRequest(()=>helpS3.send(new GetObjectCommand({Bucket:helpBucket,Key:row.objectKey}),{abortSignal:AbortSignal.timeout(30000)}));if(!result.Body)throw new PersonalMailError('MAIL_ATTACHMENT_UNAVAILABLE',409);const chunks:Buffer[]=[];let size=0;for await(const part of result.Body as AsyncIterable<Uint8Array>){const chunk=Buffer.from(part);size+=chunk.length;if(size>row.size)throw new PersonalMailError('MAIL_ATTACHMENT_UNAVAILABLE',409);chunks.push(chunk);}const content=Buffer.concat(chunks);if(content.length!==row.size||createHash('sha256').update(content).digest('hex')!==row.sha256)throw new PersonalMailError('MAIL_ATTACHMENT_UNAVAILABLE',409);files.push({filename:row.name||'Вложение',content:Buffer.from(content),contentType:row.mimeType});}await attachments(userId,ticketId,ids,false,descriptors);return files;
}
export async function createMailDraft(userId:number,ticketId:number,input:unknown,requestKey:string){
 await ticketAccess(userId,ticketId);const payload=draftSchema.parse(input),row=await connection(userId,payload.provider);if(!row?.passwordCipher||!row.verifiedAt)throw new PersonalMailError('MAIL_NOT_CONNECTED',409);
 const attachmentProofs=await attachments(userId,ticketId,payload.attachmentIds) as AttachmentProof[];payload.to=[...new Set(payload.to)];payload.attachmentIds=[...new Set(payload.attachmentIds)];
 const storedPayload={...payload,attachmentProofs};
 const hash=createHash('sha256').update(JSON.stringify([requestKey,row.revision,row.email,storedPayload])).digest('hex'),id=randomUUID();
 const [saved]=await prisma.$queryRaw<Draft[]>`INSERT INTO "HelpMailDraft" ("id","ownerId","ticketId","provider","connectionRevision","sender","payload","contentHash") VALUES (${id}::uuid,${userId},${ticketId},${payload.provider},${row.revision},${row.email},${JSON.stringify(storedPayload)}::jsonb,${hash}) ON CONFLICT ("ownerId","ticketId","contentHash") DO UPDATE SET "contentHash"=EXCLUDED."contentHash" RETURNING *`;
 return {id:saved.id,status:saved.status,reviewLink:`leaderproduct://mail/draft/${saved.id}`,sent:saved.status==='SENT'};
}
async function getRow(userId:number,id:string){const [draft]=await prisma.$queryRaw<Draft[]>`SELECT * FROM "HelpMailDraft" WHERE "id"=${id}::uuid AND "ownerId"=${userId}`;if(!draft)throw new PersonalMailError('MAIL_DRAFT_NOT_FOUND',404);await ticketAccess(userId,draft.ticketId);return draft;}
export async function getMailDraft(userId:number,id:string){const row=await getRow(userId,id);return {id:row.id,ticketId:row.ticketId,provider:row.provider,from:row.sender,to:row.payload.to,subject:row.payload.subject,text:row.payload.text,attachments:((await attachments(userId,row.ticketId,row.payload.attachmentIds,false,row.payload.attachmentProofs)) as AttachmentProof[]).map(({id,name,size})=>({id,name,size})),contentHash:row.contentHash,status:row.status==='SENDING'&&row.attemptedAt&&Date.now()-row.attemptedAt.getTime()>120000?'UNKNOWN':row.status,sentAt:row.sentAt?.toISOString()||null};}
export async function sendMailDraft(userId:number,id:string,contentHash:string){
 const draft=await getRow(userId,id);if(contentHash!==draft.contentHash)throw new PersonalMailError('MAIL_CONFIRMATION_REQUIRED',409);
 if(draft.status!=='DRAFT')return getMailDraft(userId,id);
 const row=await connection(userId,draft.provider);if(!row?.passwordCipher||!row.verifiedAt||row.revision!==draft.connectionRevision||row.email!==draft.sender)throw new PersonalMailError('MAIL_CHANGED',409);
 const files=await attachments(userId,draft.ticketId,draft.payload.attachmentIds,true,draft.payload.attachmentProofs);
 const password=unsealMail(row.passwordCipher,userId,draft.provider);await ticketAccess(userId,draft.ticketId);
 // Claim the immutable reviewed draft before SMTP. Never automatically retry after uncertainty.
 const claimed=await prisma.$executeRaw`UPDATE "HelpMailDraft" SET "status"='SENDING',"attemptedAt"=now() WHERE "id"=${id}::uuid AND "ownerId"=${userId} AND "status"='DRAFT' AND EXISTS (SELECT 1 FROM "PersonalMailConnection" c WHERE c."userId"=${userId} AND c."provider"=${draft.provider} AND c."revision"=${row.revision} AND c."passwordCipher" IS NOT NULL)`;
 if(claimed!==1)return getMailDraft(userId,id);
 const messageId=`<${id}@leaderproduct.local>`,transport=mailTransport(draft.provider,row.email,password);
 try{
 const sent=await transport.sendMail({from:row.email,to:draft.payload.to,subject:draft.payload.subject,text:draft.payload.text,messageId,attachments:files as Array<{filename:string;content:Buffer;contentType:string}>,disableFileAccess:true,disableUrlAccess:true});
 const complete=sent.accepted?.length===draft.payload.to.length&&!(sent.rejected?.length);
 await prisma.$executeRaw`UPDATE "HelpMailDraft" SET "status"=${complete?'SENT':'UNKNOWN'},"sentAt"=${complete?new Date():null},"messageId"=${messageId} WHERE "id"=${id}::uuid AND "status"='SENDING'`;
 }catch(error){
 if((error as {code?:string})?.code==='EAUTH'){
  await prisma.$executeRaw`UPDATE "PersonalMailConnection" SET "passwordCipher"=NULL,"verifiedAt"=NULL,"revision"="revision"+1 WHERE "userId"=${userId} AND "provider"=${draft.provider} AND "revision"=${row.revision}`;
  await prisma.$executeRaw`UPDATE "HelpMailDraft" SET "status"='FAILED',"messageId"=${messageId} WHERE "id"=${id}::uuid AND "status"='SENDING'`;
 }else await prisma.$executeRaw`UPDATE "HelpMailDraft" SET "status"='UNKNOWN',"messageId"=${messageId} WHERE "id"=${id}::uuid AND "status"='SENDING'`;
 }finally{transport.close();}
 return getMailDraft(userId,id);
}
