import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { authenticateToken, AuthRequest } from '../../middleware/auth';
import prisma from '../../prisma/client';
import { s3EnvPrefix } from '../../storage/minio';
import { helpS3, helpBucket, ensureHelpBucket, helpStorageRequest, HelpStorageError } from './help.storage';
export { helpBucket } from './help.storage';
import { detectHelpFile, HELP_MAX_ATTACHMENTS, HELP_MAX_FILE_BYTES } from './help.policy';
import { helpImageMetadata } from './help.image';
import * as service from './help.service';
import { publishHelpUpdates } from './help.socket';
import { helpDateQuery, helpHistoryQuery, helpSearchQuery, helpSyncQuery } from './help.history';

const router=express.Router();
const idSchema=z.coerce.number().int().positive();
const messageSchema=z.object({clientMessageId:z.string().min(8).max(100),text:z.string().max(20000).default(''),attachmentIds:z.array(z.string().uuid()).max(HELP_MAX_ATTACHMENTS).default([]).refine(a=>new Set(a).size===a.length),replyToId:idSchema.optional(),forwardedFromId:idSchema.optional(),rating:z.number().int().min(0).max(5).optional()}).strict();
const createSchema=messageSchema.extend({clientTicketId:z.string().min(8).max(100),sourceTicketId:idSchema.optional()});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:HELP_MAX_FILE_BYTES,files:HELP_MAX_ATTACHMENTS,fields:2,fieldSize:1024}}).array('files',HELP_MAX_ATTACHMENTS);
const activeUploads=new Set<number>();
const route=(fn:(req:Request,res:Response,actor:service.HelpActor)=>Promise<any>)=>(req:Request,res:Response,next:NextFunction)=>{
  Promise.resolve().then(async()=>fn(req,res,await service.helpActor((req as AuthRequest).user!.userId))).catch(next);
};
const ticketId=(req:Request)=>idSchema.parse(req.params.id);
async function detail(res:Response,id:number,actor:service.HelpActor) {
  // A transport outage must not turn an already committed message into an HTTP failure.
  void publishHelpUpdates(id).catch(error=>console.warn('[help] live delivery deferred',{code:error?.code}));
  res.json(await service.helpDetail(id,actor));
}
router.use(authenticateToken);
router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
router.get('/config',route(async(_req,res,actor)=>res.json({aiEnabled:false,canManage:actor.canManage,maxAttachments:HELP_MAX_ATTACHMENTS,maxFileBytes:HELP_MAX_FILE_BYTES})));
router.get('/tickets',route(async(req,res,actor)=>{
  const status=z.enum(['OPEN','CLOSED']).default('OPEN').parse(req.query.status);
  const scope=z.enum(['mine','queue']).default('mine').parse(req.query.scope);
  if(scope==='queue'&&!actor.canManage) throw new service.HelpError(403,'HELP_FORBIDDEN','Нет доступа к очереди IT');
  const q=z.string().trim().max(100).optional().parse(req.query.q);
  res.json(await service.listHelpTickets(actor,status,scope==='queue',req.query.cursor?idSchema.parse(req.query.cursor):undefined,q));
}));
router.post('/tickets',route(async(req,res,actor)=>detail(res,await service.createHelpTicket(actor,createSchema.parse(req.body)),actor)));
router.get('/tickets/:id',route(async(req,res,actor)=>res.json(await service.helpDetail(ticketId(req),actor))));
router.get('/tickets/:id/messages',route(async(req,res,actor)=>res.json(await service.helpMessages(ticketId(req),actor,helpHistoryQuery.parse(req.query)))));
router.get('/tickets/:id/search',route(async(req,res,actor)=>res.json(await service.searchHelpMessages(ticketId(req),actor,helpSearchQuery.parse(req.query)))));
router.get('/tickets/:id/date',route(async(req,res,actor)=>res.json(await service.findHelpMessageByDate(ticketId(req),actor,helpDateQuery.parse(req.query)))));
router.get('/tickets/:id/sync',route(async(req,res,actor)=>res.json(await service.syncHelpTicket(ticketId(req),actor,helpSyncQuery.parse(req.query)))));
router.post('/tickets/:id/messages',route(async(req,res,actor)=>{const id=ticketId(req);await service.sendHelpMessage(id,actor,messageSchema.parse(req.body));await detail(res,id,actor);}));
for(const action of ['close','reopen'] as const) router.post(`/tickets/:id/${action}`,route(async(req,res,actor)=>{const id=ticketId(req);await service.changeHelpStatus(id,actor,messageSchema.parse(req.body),action);await detail(res,id,actor);}));
for(const action of ['request-it','claim'] as const) router.post(`/tickets/:id/${action}`,route(async(req,res,actor)=>{const id=ticketId(req);await service.helpItAction(id,actor,action==='claim');await detail(res,id,actor);}));
router.post('/tickets/:id/read',route(async(req,res,actor)=>{
  const id=ticketId(req);
  const body=z.object({sequence:z.number().int().nonnegative().optional()}).strict().parse(req.body||{});
  if(await service.readHelpTicket(id,actor,body.sequence)) void publishHelpUpdates(id).catch(error=>console.warn('[help] live delivery deferred',{code:error?.code}));
  res.json(await service.helpDetail(id,actor));
}));
router.post('/read-all',route(async(_req,res,actor)=>{
  const changed=await service.readAllHelp(actor);
  void Promise.all(changed.map(id=>publishHelpUpdates(id))).catch(error=>console.warn('[help] live delivery deferred',{code:error?.code}));
  res.json({ok:true});
}));
router.patch('/messages/:id',route(async(req,res,actor)=>{const body=z.object({text:z.string().max(20000),rating:z.number().int().min(0).max(5).optional(),attachmentIds:z.array(z.string().uuid()).max(HELP_MAX_ATTACHMENTS).refine(ids=>new Set(ids).size===ids.length).optional()}).strict().parse(req.body);await detail(res,await service.editHelpMessage(ticketId(req),actor,body.text,body.rating,body.attachmentIds),actor);}));
router.put('/messages/:id/reactions/:emoji',route(async(req,res,actor)=>detail(res,await service.reactHelpMessage(ticketId(req),actor,String(req.params.emoji),false),actor)));
router.delete('/messages/:id/reactions/:emoji',route(async(req,res,actor)=>detail(res,await service.reactHelpMessage(ticketId(req),actor,String(req.params.emoji),true),actor)));
router.get('/events',route(async(req,res,actor)=>res.json(await service.replayHelp(actor,z.coerce.number().int().nonnegative().default(0).parse(req.query.after)))));
router.post('/attachments',route(async(req,res,actor)=>{
  if(activeUploads.has(actor.userId)||activeUploads.size>=2) throw new service.HelpError(429,'UPLOAD_BUSY','Дождитесь завершения текущей загрузки');
  activeUploads.add(actor.userId);
  try {
  // Authorize before buffering multipart data. Server-enforced limits apply to every file.
  await new Promise<void>((resolve,reject)=>upload(req,res,e=>e?reject(e):resolve()));
  const files=req.files as Express.Multer.File[];
  if(!files?.length) throw new service.HelpError(400,'NO_FILES','Выберите файл');
  const typed=files.map(f=>({file:f,detected:detectHelpFile(f.buffer)}));
  if(typed.some(f=>!f.detected)) throw new service.HelpError(415,'UNSUPPORTED_FILE','Этот формат не поддерживается');
  await ensureHelpBucket();
  const attachments:ReturnType<typeof service.attachmentDto>[]=[];
  for(const {file,detected} of typed) {
    const objectKey=`${s3EnvPrefix}/help/${crypto.randomUUID()}`;
    await helpStorageRequest(()=>helpS3.send(new PutObjectCommand({Bucket:helpBucket,Key:objectKey,Body:file.buffer,ContentType:detected!.mimeType,CacheControl:'private, no-store'})));
    const name=Buffer.from(file.originalname,'latin1').toString('utf8').replace(/[\x00-\x1f\\/]/g,'_').slice(0,180)||'Файл';
    const image=detected!.kind==='IMAGE'?await helpImageMetadata(file.buffer):{};
    const row=await prisma.helpAttachment.create({data:{ownerId:actor.userId,name,mimeType:detected!.mimeType,kind:detected!.kind,size:file.size,objectKey,sha256:crypto.createHash('sha256').update(file.buffer).digest('hex'),position:attachments.length,...image}});
    attachments.push(service.attachmentDto(row));
  }
  res.status(201).json({attachments});
  } finally { activeUploads.delete(actor.userId); }
}));
router.get('/attachments/:id',route(async(req,res,actor)=>{
  const row=await prisma.helpAttachment.findUnique({where:{id:z.string().uuid().parse(req.params.id)},include:{message:true}});
  if(!row) throw new service.HelpError(404,'HELP_NOT_FOUND','Файл не найден');
  if(row.message) await service.requireHelpTicket(prisma,row.message.ticketId,actor);
  else if(row.ownerId!==actor.userId) throw new service.HelpError(404,'HELP_NOT_FOUND','Файл не найден');
  const range=typeof req.headers.range==='string'?req.headers.range:undefined;
  if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new service.HelpError(416,'INVALID_RANGE','Некорректный диапазон');
  await ensureHelpBucket();
  const result=await helpStorageRequest(()=>helpS3.send(new GetObjectCommand({Bucket:helpBucket,Key:row.objectKey,Range:range})));
  res.status(result.ContentRange?206:200);
  res.setHeader('Content-Type',row.mimeType);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Disposition',`${row.kind==='FILE'||req.query.download==='1'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  if(result.ContentLength!==undefined) res.setHeader('Content-Length',result.ContentLength);
  if(result.ContentRange) res.setHeader('Content-Range',result.ContentRange);
  (result.Body as Readable).on('error',()=>res.destroy()).pipe(res);
}));
router.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
  if(res.headersSent) return res.end();
  if(err instanceof service.HelpError||err instanceof HelpStorageError) return res.status(err.status).json({code:err.code,message:err.message});
  if(err instanceof z.ZodError) return res.status(400).json({code:'VALIDATION_ERROR',message:'Проверьте поля запроса',issues:err.issues.map(i=>({path:i.path,message:i.message}))});
  if(err instanceof multer.MulterError) return res.status(413).json({code:'UPLOAD_LIMIT',message:'Не более 10 файлов, до 20 МиБ каждый'});
  if(err?.$metadata?.httpStatusCode===416) return res.status(416).json({code:'INVALID_RANGE',message:'Диапазон за пределами файла'});
  console.error('[help] request failed',{name:err?.name,code:err?.code});
  res.status(500).json({code:'HELP_INTERNAL_ERROR',message:'Не удалось выполнить действие. Повторите попытку'});
});
export default router;
