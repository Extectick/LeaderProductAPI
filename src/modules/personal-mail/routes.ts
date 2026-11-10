import {Router,json,type Request,type Response,type ErrorRequestHandler} from 'express';
import {z} from 'zod';
import {authenticateToken,type AuthRequest} from '../../middleware/auth';
import {connectSchema,providerSchema,PersonalMailError,mailMessages} from './contract';
import {connectMail,disconnectMail,listMailConnections,getMailDraft,sendMailDraft} from './service';
const router=Router();router.use(authenticateToken);router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
router.use((req,res,next)=>{const peer=(req.socket.remoteAddress||'').replace(/^::ffff:/,''),proxies=(process.env.MAIL_TRUSTED_PROXY_IPS||process.env.ONEC_TRUSTED_PROXY_IPS||'127.0.0.1,::1').split(',');if(req.method==='PUT'&&process.env.NODE_ENV!=='test'&&!req.secure&&!(proxies.includes(peer)&&req.get('x-forwarded-proto')==='https'))return res.status(400).json({ok:false,message:mailMessages.MAIL_HTTPS_REQUIRED});next();});
router.use(json({limit:'64kb'}));
function route(fn:(req:AuthRequest<any>,res:Response)=>Promise<unknown>){return async(req:Request,res:Response)=>{try{if((req as AuthRequest).user?.helpApi)return res.status(403).json({ok:false,message:'Подтвердите отправку в приложении.'});await fn(req as AuthRequest<any>,res);}catch(error){const code=error instanceof PersonalMailError?error.code:error instanceof z.ZodError?'VALIDATION_ERROR':'MAIL_UNAVAILABLE';res.status(error instanceof PersonalMailError?error.status:error instanceof z.ZodError?400:503).json({ok:false,message:mailMessages[code]||'Не удалось выполнить действие.',error:{code}});}};}
router.get('/connections',route(async(req,res)=>res.json({ok:true,data:await listMailConnections(req.user!.userId)})));
router.put('/connections/:provider',route(async(req,res)=>{const provider=providerSchema.parse(req.params.provider),input=connectSchema.parse(req.body);try{res.json({ok:true,data:await connectMail(req.user!.userId,provider,input.email,input.password)});}finally{input.password='';req.body={};}}));
router.delete('/connections/:provider',route(async(req,res)=>res.json({ok:true,data:await disconnectMail(req.user!.userId,providerSchema.parse(req.params.provider))})));
router.get('/drafts/:id',route(async(req,res)=>res.json({ok:true,data:await getMailDraft(req.user!.userId,z.string().uuid().parse(req.params.id))})));
router.post('/drafts/:id/send',route(async(req,res)=>{const input=z.object({contentHash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict().parse(req.body);res.json({ok:true,data:await sendMailDraft(req.user!.userId,z.string().uuid().parse(req.params.id),input.contentHash)});}));
const errorHandler:ErrorRequestHandler=(_error,_req,res,_next)=>{res.status(400).json({ok:false,message:'Проверьте введённые данные.'});};router.use(errorHandler);export default router;
