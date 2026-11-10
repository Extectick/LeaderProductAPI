import { Router, type Response } from 'express';
import { authenticateToken, type AuthRequest } from '../../middleware/auth';
import { checkUserStatus } from '../../middleware/checkUserStatus';
import { OnecPersonalError, connectionAction } from '../onec-personal/config';
import { normalizeEntityTarget } from './entity.contract';
import { EntityResolveError, resolveEntityTarget } from './entity.service';
import { resolveEntityPreview } from './entity.preview';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control','private, no-store'); next(); });
router.use(authenticateToken, checkUserStatus);
async function readEntity(req:AuthRequest,res:Response,preview=false) {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !(preview?['target']:['target','maxTabularRows']).includes(key)) || !Object.prototype.hasOwnProperty.call(body, 'target')) {
    res.status(400).json({ok:false, error:{code:'ENTITY_INVALID_TARGET'}, message:'Некорректная ссылка на объект.'}); return;
  }
  const input = body as Record<string, unknown>;
  const target = normalizeEntityTarget(input.target);
  if (!target) { res.status(400).json({ok:false, error:{code:'ENTITY_INVALID_TARGET'}, message:'Некорректная ссылка на объект.'}); return; }
  const maxTabularRows = input.maxTabularRows === undefined ? 100 : input.maxTabularRows;
  if (typeof maxTabularRows !== 'number' || !Number.isInteger(maxTabularRows) || maxTabularRows < 1 || maxTabularRows > 1000) {
    res.status(400).json({ok:false, error:{code:'ENTITY_INVALID_LIMIT'}, message:'Некорректный размер просмотра.'}); return;
  }
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  try { res.json({ok:true, data:preview?await resolveEntityPreview(req.user!.userId,target,controller.signal):await resolveEntityTarget(req.user!.userId, target, controller.signal, maxTabularRows)}); }
  catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const known = error instanceof OnecPersonalError || error instanceof EntityResolveError;
    const code = known ? error.code : 'ENTITY_UNAVAILABLE';
    const connect = target.source === 'onec' && ['ONEC_AUTH_REQUIRED','ONEC_CREDENTIALS_INVALID','ONEC_ACCESS_DENIED'].includes(code);
    const status = connect ? 422 : known ? error.status : 503;
    const message = connect ? 'Подключите свою учётную запись 1С, чтобы открыть объект.' : status === 404 ? 'Объект не найден или больше недоступен.' : status === 400 ? 'Некорректная или неподдерживаемая ссылка.' : 'Не удалось загрузить карточку. Повторите попытку.';
    res.status(status).json({ok:false, error:{code}, message, ...(connect && target.source === 'onec' ? {action:connectionAction(target.baseKey)} : {})});
  } finally { res.off('close', close); }
}
router.post('/resolve',(req:AuthRequest,res:Response)=>readEntity(req,res));
router.post('/preview',(req:AuthRequest,res:Response)=>readEntity(req,res,true));
export default router;
