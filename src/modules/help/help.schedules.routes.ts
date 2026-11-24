import {Router,type Request,type Response,type NextFunction} from 'express';
import {z} from 'zod';
import type {AuthRequest} from '../../middleware/auth';
import {helpActor} from './help.service';
import {scheduleDraft} from './help.schedule-time';
import {decideSchedule,editSchedule,historyPage,listSchedules,queueSchedule,readScheduleResults,removeSchedule} from './help.schedules';

const router=Router();
const positiveId=z.number().int().positive().max(2147483647);
const origin=z.object({ticketId:positiveId,messageId:positiveId}).strict();
const create=origin.extend(scheduleDraft.shape);
const cursor=z.object({before:z.string().uuid().optional()}).strict();
const uuid=z.string().uuid();
const patch=scheduleDraft.partial().extend({active:z.boolean().optional()}).refine(v=>Object.keys(v).length>0);

// Mounted after the parent Help router's JWT authentication and private/no-store headers.
function handle(fn:(owner:number,req:Request,res:Response)=>Promise<unknown>) {
  return (req:Request,res:Response,next:NextFunction)=>{
    void helpActor((req as AuthRequest).user!.userId).then(actor=>fn(actor.userId,req,res)).catch(next);
  };
}
router.get('/',handle(async(owner,_req,res)=>res.json(await listSchedules(owner))));
router.post('/',handle(async(owner,req,res)=>{
  const {ticketId,messageId,...draft}=create.parse(req.body);
  res.json(await decideSchedule(owner,ticketId,messageId,draft));
}));
router.post('/cancel',handle(async(owner,req,res)=>{
  const {ticketId,messageId}=origin.parse(req.body);
  res.json(await decideSchedule(owner,ticketId,messageId));
}));
router.get('/reports',handle(async(owner,req,res)=>res.json(await historyPage(owner,undefined,cursor.parse(req.query).before))));
router.post('/read',handle(async(owner,req,res)=>{
  const {ids}=z.object({ids:z.array(uuid).min(1).max(100)}).strict().parse(req.body);
  res.json(await readScheduleResults(owner,ids));
}));
router.get('/:id/runs',handle(async(owner,req,res)=>res.json(await historyPage(owner,uuid.parse(req.params.id),cursor.parse(req.query).before))));
router.patch('/:id',handle(async(owner,req,res)=>res.json(await editSchedule(owner,uuid.parse(req.params.id),patch.parse(req.body)))));
router.delete('/:id',handle(async(owner,req,res)=>res.json(await removeSchedule(owner,uuid.parse(req.params.id)))));
router.post('/:id/run',handle(async(owner,req,res)=>{
  const {requestId}=z.object({requestId:uuid}).strict().parse(req.body);
  res.status(202).json(await queueSchedule(owner,uuid.parse(req.params.id),requestId));
}));
export default router;
