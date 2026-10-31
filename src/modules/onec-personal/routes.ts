import { Router, json, type Request, type Response, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthRequest } from '../../middleware/auth';
import { connectOnec, disconnectOnec, listOnecConnections } from './service';
import { OnecPersonalError } from './config';

export const onecErrorMessages: Record<string, string> = {
  ONEC_AUTH_REQUIRED: 'Проверьте логин и пароль 1С.', ONEC_BAD_CREDENTIALS: 'Проверьте логин и пароль 1С.',
  ONEC_LOGIN_REQUIRED: 'Укажите логин 1С.', ONEC_LOGIN_MISMATCH: 'Для связанного пользователя используется его логин 1С.',
  ONEC_ACCESS_DENIED: 'Учётной записи не разрешён доступ к MCP 1С. Обратитесь в IT.',
  ONEC_RATE_LIMIT: 'Слишком много попыток. Повторите через 15 минут.', ONEC_CHANGED: 'Подключение изменилось. Обновите страницу.',
  ONEC_FORBIDDEN: 'Подключение доступно сотрудникам с действующим профилем.',
};
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(authenticateToken);
router.use((req, res, next) => {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const proxies = (process.env.ONEC_TRUSTED_PROXY_IPS || '127.0.0.1,::1,172.20.0.1').split(',');
  if (req.method === 'PUT' && process.env.NODE_ENV !== 'test' && !req.secure &&
      !(proxies.includes(peer) && req.get('x-forwarded-proto') === 'https')) {
    return res.status(400).json({ ok: false, message: 'Для передачи пароля требуется HTTPS.', error: { code: 'ONEC_HTTPS_REQUIRED' } });
  }
  next();
});
router.use(json({ limit: '4kb' }));
function route(fn: (req: AuthRequest<any>, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { await fn(req as AuthRequest<any>, res); }
    catch (e) {
      const code = e instanceof OnecPersonalError ? e.code : e instanceof z.ZodError ? 'VALIDATION_ERROR' : 'ONEC_UNAVAILABLE';
      const status = e instanceof OnecPersonalError ? e.status : e instanceof z.ZodError ? 400 : 503;
      // Deliberately do not include e.message, upstream bodies or validation input.
      res.status(status).json({ ok: false, message: onecErrorMessages[code] || (status === 400 ? 'Проверьте введённые данные.' : 'Подключение 1С временно недоступно.'), error: { code } });
    }
  };
}
router.get('/', route(async (req, res) => res.json({ ok: true, data: await listOnecConnections(req.user!.userId) })));
const key = z.string().regex(/^[a-z0-9-]{1,48}$/);
router.put('/:baseKey', route(async (req, res) => {
  const baseKey = key.parse(req.params.baseKey);
  const input = z.object({ login: z.string().trim().min(1).max(128).optional(), password: z.string().min(1).max(512).refine(v => !/[\r\n\0]/.test(v)) }).strict().parse(req.body);
  try { res.json({ ok: true, data: await connectOnec(req.user!.userId, baseKey, input.login, input.password) }); }
  finally { input.password = ''; req.body = {}; }
}));
router.delete('/:baseKey', route(async (req, res) => res.json({ ok: true, data: await disconnectOnec(req.user!.userId, key.parse(req.params.baseKey)) })));
router.use((_req, res) => res.status(405).json({ ok: false, message: 'Метод недоступен.', error: { code: 'METHOD_NOT_ALLOWED' } }));
// JSON parser errors can contain the original password. Terminate here, before global error logging.
const privateError: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ ok: false, message: 'Проверьте введённые данные.', error: { code: 'VALIDATION_ERROR' } }); };
router.use(privateError);
export default router;
